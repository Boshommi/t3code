import {
  ProviderSetupError,
  type ClaudeSettings,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";

const LOGIN_URL_PATTERN = /https:\/\/\S+\/oauth\/authorize\?\S+/;
// eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC.
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** The CLI's last line explains a failure, such as a rejected code. */
function lastLine(transcript: string): string | undefined {
  return transcript
    .replace(ANSI_PATTERN, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^Paste code here if prompted >\s*/, "").trim())
    .findLast((line) => line.length > 0 && !LOGIN_URL_PATTERN.test(line))
    ?.slice(0, 300);
}

/**
 * Signs in by running `claude auth login` for this instance's config
 * directory. Without a terminal the CLI prints a link and reads the code that
 * the sign-in page shows from stdin, so the whole exchange works from a client
 * on another machine. Claude stores the login itself, exactly as when the user
 * runs the command, so the CLI on the server shares it.
 */
export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly configDir: string;
  /** Re-reads the account after its login changes. */
  readonly onChanged: Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });

  const spawnClaude = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const env = yield* makeClaudeEnvironment(options.settings, options.environment).pipe(
      Effect.provideService(Path.Path, path),
    );
    const command = yield* resolveSpawnCommand(options.settings.binaryPath, args, { env });
    return yield* spawner
      .spawn(
        ChildProcess.make(command.command, command.args, {
          env,
          shell: command.shell,
          stdin: "pipe",
        }),
      )
      .pipe(
        Effect.mapError(() =>
          failure(
            "start",
            "Could not run Claude Code. Check that it is installed on this machine.",
          ),
        ),
      );
  });

  const authenticate = Effect.fn("ClaudeAuth.authenticate")(function* (
    _methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (!options.settings.enabled) {
      return yield* failure("start", "Enable this provider before signing in.");
    }
    const login = yield* spawnClaude(["auth", "login", "--claudeai"]);
    let transcript = "";
    const loginUrl = yield* Deferred.make<string>();
    yield* login.all.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          transcript = (transcript + chunk).slice(-8_000);
          const match = LOGIN_URL_PATTERN.exec(transcript);
          return match === null ? Effect.void : Deferred.succeed(loginUrl, match[0]);
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const exited = yield* login.exitCode.pipe(Effect.forkScoped);
    const endedEarly = Fiber.join(exited).pipe(
      Effect.ignore,
      Effect.andThen(
        Effect.suspend(() =>
          Effect.fail(
            failure(
              "start",
              lastLine(transcript) ?? "Claude Code ended before showing a sign-in link.",
            ),
          ),
        ),
      ),
    );
    const url = yield* Effect.raceFirst(Deferred.await(loginUrl), endedEarly);

    yield* context.setInteraction(
      {
        type: "credentials",
        id: "claude-code",
        fields: [{ name: "code", label: "Code from the sign-in page", secret: true }],
      },
      (response) =>
        Effect.gen(function* () {
          if (response.type !== "credentials") return;
          const code = response.values.code?.trim();
          if (!code) return yield* failure("respond", "Paste the code shown after signing in.");
          yield* Stream.run(Stream.encodeText(Stream.make(`${code}\n`)), login.stdin).pipe(
            Effect.mapError(() =>
              failure("respond", "Claude sign-in is no longer running. Start again."),
            ),
          );
          yield* context.verifying;
        }),
      undefined,
      url,
    );

    const exitCode = yield* Fiber.join(exited).pipe(
      Effect.mapError(() => failure("start", "Claude sign-in stopped unexpectedly. Start again.")),
    );
    if (exitCode !== 0) {
      return yield* failure("start", lastLine(transcript) ?? "Claude sign-in did not finish.");
    }
    yield* options.onChanged;
  });

  const logout = Effect.gen(function* () {
    const exitCode = yield* Effect.scoped(
      spawnClaude(["auth", "logout"]).pipe(
        Effect.flatMap((process) => process.exitCode),
        Effect.mapError(() => failure("logout", "Could not sign out of Claude. Try again.")),
      ),
    );
    yield* options.onChanged;
    if (exitCode !== 0) return yield* failure("logout", "Could not sign out of Claude. Try again.");
    return "Signed out of Claude.";
  });

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // Instances sharing a config directory share one login.
    credentialBinding: { owner: "provider", key: `claude:${options.configDir}` },
    methods: Effect.succeed([
      {
        id: "claudeai",
        name: "Claude subscription",
        description: "Sign in with your Claude account.",
        type: "agent" as const,
      },
    ]),
    authenticate,
    logout,
  });
});
