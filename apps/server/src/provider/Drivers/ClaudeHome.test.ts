import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  materializeClaudeShadowHome,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
  describe("Claude account directories", () => {
    it.effect.skipIf(!symlinksSupported)(
      "shares conversations and settings while keeping each login private",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "claude-shared-",
          });
          const accountRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "claude-account-",
          });
          const accountHome = path.join(accountRoot, "work");
          yield* fileSystem.writeFileString(path.join(sharedHome, "settings.json"), "{}\n");
          yield* fileSystem.writeFileString(path.join(sharedHome, ".credentials.json"), "shared");
          yield* fileSystem.writeFileString(path.join(sharedHome, ".claude.json"), "shared");
          const config = { homePath: sharedHome, shadowHomePath: accountHome };

          yield* materializeClaudeShadowHome(config);
          // A second account start must leave the first setup intact.
          yield* materializeClaudeShadowHome(config);

          expect(yield* resolveClaudeHomePath(config)).toBe(accountHome);
          expect((yield* makeClaudeEnvironment(config)).CLAUDE_CONFIG_DIR).toBe(accountHome);
          // Accounts on one shared home can resume each other's threads.
          expect(yield* makeClaudeContinuationGroupKey(config)).toBe(
            yield* makeClaudeContinuationGroupKey({ homePath: sharedHome }),
          );
          for (const shared of ["projects", "todos", "settings.json"]) {
            expect(yield* fileSystem.readLink(path.join(accountHome, shared))).toBe(
              path.join(sharedHome, shared),
            );
          }
          for (const owned of [".credentials.json", ".claude.json"]) {
            expect(yield* fileSystem.exists(path.join(accountHome, owned))).toBe(false);
          }
        }).pipe(Effect.scoped),
    );
  });
});
