// @effect-diagnostics nodeBuiltinImport:off - fixtures are written with plain fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  parseClaudeAgentDefinition,
  resolveClaudeAgentDefinition,
} from "./ClaudeAgentDefinitions.ts";

describe("parseClaudeAgentDefinition", () => {
  it("reads model and effort from frontmatter", () => {
    assert.deepEqual(
      parseClaudeAgentDefinition(
        "---\nname: scout\nmodel: claude-sidekick-luna\neffort: max\nmaxTurns: 25\n---\nYou scout.\n",
      ),
      { model: "claude-sidekick-luna", effort: "max" },
    );
  });

  it("treats `inherit`, unknown effort names and missing frontmatter as absent", () => {
    assert.deepEqual(
      parseClaudeAgentDefinition("---\nmodel: inherit\neffort: ultra\n---\nbody"),
      {},
    );
    assert.deepEqual(parseClaudeAgentDefinition("no frontmatter here"), {});
    assert.deepEqual(parseClaudeAgentDefinition("---\n: : not yaml [\n---\n"), {});
  });

  it("accepts an integer effort the way Claude Code does", () => {
    assert.deepEqual(parseClaudeAgentDefinition("---\neffort: 40\n---\n"), { effort: "40" });
  });
});

describe("resolveClaudeAgentDefinition", () => {
  it.effect("prefers the project definition over the user config dir", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-agent-defs-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const cwd = NodePath.join(root, "project");
      const configDir = NodePath.join(root, "config");
      NodeFS.mkdirSync(NodePath.join(cwd, ".claude", "agents"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(configDir, "agents"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(configDir, "agents", "scout.md"),
        "---\nmodel: user-model\neffort: low\n---\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(configDir, "agents", "reviewer.md"),
        "---\nmodel: claude-reviewer-astra\neffort: high\n---\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(cwd, ".claude", "agents", "scout.md"),
        "---\nmodel: claude-sidekick-luna\neffort: max\n---\n",
      );

      assert.deepEqual(
        yield* resolveClaudeAgentDefinition({ subagentType: "scout", cwd, configDir }),
        { model: "claude-sidekick-luna", effort: "max" },
      );
      assert.deepEqual(
        yield* resolveClaudeAgentDefinition({ subagentType: "reviewer", cwd, configDir }),
        { model: "claude-reviewer-astra", effort: "high" },
      );
      assert.deepEqual(
        yield* resolveClaudeAgentDefinition({ subagentType: "general-purpose", cwd, configDir }),
        {},
      );
      // A subagent_type that is not a plain agent name never becomes a path.
      assert.deepEqual(
        yield* resolveClaudeAgentDefinition({ subagentType: "../../etc/passwd", cwd, configDir }),
        {},
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
