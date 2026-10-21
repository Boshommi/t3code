import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { parseClaudeFrontmatter } from "./ClaudeSkills.ts";

/** Claude Code agent names; anything else is refused so it can never become a path. */
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface ClaudeSubagentDefaults {
  readonly model?: string;
  /** A named level or a positive integer, as Claude Code accepts it. */
  readonly effort?: string;
}

export function parseClaudeAgentDefinition(contents: string): ClaudeSubagentDefaults {
  const frontmatter = parseClaudeFrontmatter(contents);
  if (frontmatter.kind !== "parsed") return {};
  const { model: rawModel, effort: rawEffort } = frontmatter.record;
  const model = typeof rawModel === "string" ? rawModel.trim() : "";
  const effort =
    typeof rawEffort === "string" && EFFORT_LEVELS.has(rawEffort.trim())
      ? rawEffort.trim()
      : typeof rawEffort === "number" && Number.isInteger(rawEffort) && rawEffort > 0
        ? String(rawEffort)
        : undefined;
  return {
    ...(model.length > 0 && model !== "inherit" ? { model } : {}),
    ...(effort === undefined ? {} : { effort }),
  };
}

/**
 * What a subagent runs with when its Agent call names no model or effort,
 * resolved as Claude Code does: `<cwd>/.claude/agents/<type>.md`, else
 * `<configDir>/agents/<type>.md`, then `CLAUDE_CODE_SUBAGENT_MODEL` for the
 * model. `task_started` carries none of this. Forks always inherit the parent.
 */
export const resolveClaudeSubagentDefaults = Effect.fn("resolveClaudeSubagentDefaults")(
  function* (input: {
    readonly subagentType: string | undefined;
    readonly cwd: string | null;
    readonly configDir: string;
    readonly environment: NodeJS.ProcessEnv;
  }): Effect.fn.Return<ClaudeSubagentDefaults, never, FileSystem.FileSystem | Path.Path> {
    const name = input.subagentType?.trim() ?? "";
    if (name === "fork") return {};
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let definition: ClaudeSubagentDefaults = {};
    if (AGENT_NAME_PATTERN.test(name)) {
      for (const directory of [
        ...(input.cwd === null ? [] : [path.join(input.cwd, ".claude", "agents")]),
        path.join(input.configDir, "agents"),
      ]) {
        const contents = yield* fileSystem
          .readFileString(path.join(directory, `${name}.md`))
          .pipe(Effect.option);
        if (Option.isSome(contents)) {
          definition = parseClaudeAgentDefinition(contents.value);
          break;
        }
      }
    }
    const environmentModel = input.environment.CLAUDE_CODE_SUBAGENT_MODEL?.trim();
    return definition.model === undefined && environmentModel
      ? { ...definition, model: environmentModel }
      : definition;
  },
);
