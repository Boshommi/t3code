/**
 * Subagent definition lookup for the model/effort a spawned Claude Code
 * subagent actually runs with.
 *
 * Claude Code resolves a subagent's model as: the Agent tool's explicit
 * `model`, then the definition file's `model:` frontmatter, then
 * `CLAUDE_CODE_SUBAGENT_MODEL`, then the session model — and its effort as the
 * tool's explicit `effort`, then the definition's `effort:`, then the session
 * effort. The SDK's `task_started` message carries none of the definition's
 * values, so without reading the file the seeded task row silently reports the
 * session's model/effort for an agent that ran on something else entirely.
 *
 * Definitions live in `<cwd>/.claude/agents/<type>.md` (project, wins) and
 * `<configDir>/agents/<type>.md` (user). Lookup is best-effort: a missing or
 * malformed file simply contributes nothing.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/** Claude Code agent names: lowercase letters, digits and hyphens. Anything
 * else is refused so a hostile `subagent_type` can never become a path. */
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface ClaudeAgentDefinitionOverrides {
  /** `model:` frontmatter, unless it is `inherit` (same as absent). */
  readonly model?: string;
  /** `effort:` frontmatter as Claude Code accepts it: a named level or an integer. */
  readonly effort?: string;
}

export function parseClaudeAgentDefinition(contents: string): ClaudeAgentDefinitionOverrides {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const rawEffort = record.effort;
  const effort =
    typeof rawEffort === "string" && EFFORT_LEVELS.has(rawEffort.trim())
      ? rawEffort.trim()
      : typeof rawEffort === "number" && Number.isInteger(rawEffort) && rawEffort > 0
        ? String(rawEffort)
        : undefined;
  return {
    ...(model.length > 0 && model !== "inherit" ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

/**
 * Read the definition for `subagentType` from the project, then the user
 * config dir. Never fails: unreadable roots yield `{}`.
 */
export const resolveClaudeAgentDefinition = Effect.fn("resolveClaudeAgentDefinition")(
  function* (input: {
    readonly subagentType: string;
    readonly cwd: string | undefined;
    readonly configDir: string | undefined;
  }): Effect.fn.Return<ClaudeAgentDefinitionOverrides, never, FileSystem.FileSystem | Path.Path> {
    const name = input.subagentType.trim();
    if (!AGENT_NAME_PATTERN.test(name)) {
      return {};
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const candidates = [
      ...(input.cwd ? [path.join(input.cwd, ".claude", "agents", `${name}.md`)] : []),
      ...(input.configDir ? [path.join(input.configDir, "agents", `${name}.md`)] : []),
    ];
    for (const candidate of candidates) {
      const contents = yield* fileSystem
        .readFileString(candidate)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }
      return parseClaudeAgentDefinition(contents);
    }
    return {};
  },
);
