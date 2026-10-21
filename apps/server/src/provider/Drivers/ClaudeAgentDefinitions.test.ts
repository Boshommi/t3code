import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  parseClaudeAgentDefinition,
  resolveClaudeSubagentDefaults,
} from "./ClaudeAgentDefinitions.ts";

describe("parseClaudeAgentDefinition", () => {
  it("reads model and effort, tolerating Claude Code's unquoted descriptions", () => {
    assert.deepEqual(
      parseClaudeAgentDefinition(
        "---\nname: scout\ndescription: Use this agent when: scouting\nmodel: sonnet\neffort: max\n---\nYou scout.\n",
      ),
      { model: "sonnet", effort: "max" },
    );
    assert.deepEqual(parseClaudeAgentDefinition("---\neffort: 40\n---\n"), { effort: "40" });
  });

  it("treats `inherit`, unknown efforts and missing frontmatter as absent", () => {
    assert.deepEqual(parseClaudeAgentDefinition("---\nmodel: inherit\neffort: ultra\n---\n"), {});
    assert.deepEqual(parseClaudeAgentDefinition("no frontmatter here"), {});
  });
});

it.layer(NodeServices.layer)("resolveClaudeSubagentDefaults", (it) => {
  it.effect("prefers the project definition, then the user one, then the environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-agents-" });
      const cwd = path.join(root, "project");
      const configDir = path.join(root, "config");
      yield* fs.makeDirectory(path.join(cwd, ".claude", "agents"), { recursive: true });
      yield* fs.makeDirectory(path.join(configDir, "agents"), { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "agents", "scout.md"),
        "---\nmodel: user-model\neffort: low\n---\n",
      );
      yield* fs.writeFileString(
        path.join(cwd, ".claude", "agents", "scout.md"),
        "---\nmodel: project-model\neffort: max\n---\n",
      );
      yield* fs.writeFileString(
        path.join(configDir, "agents", "reviewer.md"),
        "---\neffort: high\n---\n",
      );
      const resolve = (subagentType: string | undefined, environment: NodeJS.ProcessEnv = {}) =>
        resolveClaudeSubagentDefaults({ subagentType, cwd, configDir, environment });
      const environment = { CLAUDE_CODE_SUBAGENT_MODEL: "env-model" };

      assert.deepEqual(yield* resolve("scout", environment), {
        model: "project-model",
        effort: "max",
      });
      assert.deepEqual(yield* resolve("reviewer", environment), {
        model: "env-model",
        effort: "high",
      });
      assert.deepEqual(yield* resolve("general-purpose", environment), { model: "env-model" });
      assert.deepEqual(yield* resolve("general-purpose"), {});
      // Forks always run on the parent's model.
      assert.deepEqual(yield* resolve("fork", environment), {});
      // A subagent_type that is not a plain agent name never becomes a path.
      assert.deepEqual(yield* resolve("../config/agents/scout"), {});
    }),
  );
});
