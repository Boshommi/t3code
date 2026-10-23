import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { makeClaudeAuth } from "./ClaudeAuth.ts";

const owner = "session:test";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const instanceId = ProviderInstanceId.make("claude_work");

// Mimics `claude auth login` without a terminal: a link, then a code read from stdin.
const FAKE_CLAUDE = `#!/bin/sh
printf '%s' "$CLAUDE_CONFIG_DIR" > "$CLAUDE_CONFIG_DIR/login-dir"
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc"
printf "Paste code here if prompted > "
read code
if [ "$code" = "good#abc" ]; then echo "Login successful."; exit 0; fi
echo "Login failed: Request failed with status code 400"
exit 1
`;

const settle = (states: Stream.Stream<ProviderAuthState>) =>
  states.pipe(
    Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
    Stream.runHead,
    Effect.map((state) => (state._tag === "Some" ? state.value : undefined)),
  );

const signIn = Effect.fn("ClaudeAuth.test.signIn")(function* (code: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-auth-" });
  const accountDir = path.join(root, "account");
  yield* fileSystem.makeDirectory(accountDir);
  const binaryPath = path.join(root, "claude");
  yield* fileSystem.writeFileString(binaryPath, FAKE_CLAUDE);
  yield* fileSystem.chmod(binaryPath, 0o755);
  const changes = yield* Ref.make(0);
  const auth = yield* makeClaudeAuth({
    instanceId,
    settings: decodeClaudeSettings({
      binaryPath,
      homePath: path.join(root, "shared"),
      shadowHomePath: accountDir,
    }),
    environment: { PATH: process.env.PATH },
    configDir: accountDir,
    onChanged: Ref.update(changes, (count) => count + 1),
  });

  const started = yield* auth.start(owner);
  const waiting = yield* auth.subscribe(owner).pipe(
    Stream.filter((state) => state.interaction?.type === "credentials"),
    Stream.runHead,
  );
  assert.isTrue(waiting._tag === "Some");
  const state = waiting._tag === "Some" ? waiting.value : started;
  assert.equal(
    state.authorizationUrl,
    "https://claude.com/cai/oauth/authorize?code=true&state=abc",
  );
  const outcome = yield* settle(auth.subscribe(owner)).pipe(Effect.forkScoped);
  yield* auth.respond!(owner, {
    instanceId,
    flowId: state.flowId!,
    interactionId: state.interaction!.id,
    response: { type: "credentials", values: { code } },
  });
  return {
    final: yield* Fiber.join(outcome),
    loginDir: yield* fileSystem.readFileString(path.join(accountDir, "login-dir")),
    accountDir,
    changes: yield* Ref.get(changes),
  };
});

describe("ClaudeAuth", () => {
  describe("in-app sign-in", () => {
    // The fake CLI is a POSIX shell script.
    it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "signs the account's own directory in with the pasted code",
      () =>
        Effect.gen(function* () {
          const result = yield* signIn("good#abc");
          assert.equal(result.final?.phase, "succeeded");
          assert.equal(result.loginDir, result.accountDir);
          assert.equal(result.changes, 1);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "reports Claude's reason when the code is rejected",
      () =>
        Effect.gen(function* () {
          const result = yield* signIn("wrong");
          assert.equal(result.final?.phase, "failed");
          assert.equal(result.final?.message, "Login failed: Request failed with status code 400");
          assert.equal(result.changes, 0);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});
