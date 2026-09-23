/**
 * Maps each provider's native subagent history onto the provider-neutral
 * transcript the Agents panel renders, and bounds it for the wire.
 *
 * Transcripts are read on demand (only while someone has the agent open), so
 * nothing here is persisted or broadcast.
 */
import type { Part } from "@opencode-ai/sdk/v2";
import type {
  ProviderReadSubagentTranscriptResult,
  SubagentTranscriptEntry,
} from "@t3tools/contracts";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const TEXT_CHAR_LIMIT = 6_000;
const DETAIL_CHAR_LIMIT = 300;
const OUTPUT_CHAR_LIMIT = 2_000;
/** Total text budget per response. The newest entries win. */
const TRANSCRIPT_CHAR_BUDGET = 200_000;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function entrySize(entry: SubagentTranscriptEntry): number {
  return entry._tag === "tool"
    ? entry.name.length + (entry.detail?.length ?? 0) + (entry.output?.length ?? 0)
    : entry.text.length;
}

function clipEntry(entry: SubagentTranscriptEntry): SubagentTranscriptEntry {
  if (entry._tag !== "tool") {
    return { ...entry, text: clip(entry.text, TEXT_CHAR_LIMIT) };
  }
  return {
    _tag: "tool",
    name: clip(entry.name, DETAIL_CHAR_LIMIT),
    ...(entry.detail ? { detail: clip(entry.detail, DETAIL_CHAR_LIMIT) } : {}),
    ...(entry.output ? { output: clip(entry.output, OUTPUT_CHAR_LIMIT) } : {}),
    ...(entry.failed ? { failed: true } : {}),
  };
}

/** Clips every entry and keeps the newest ones that fit the budget. */
export function boundSubagentTranscript(
  entries: ReadonlyArray<SubagentTranscriptEntry>,
): ProviderReadSubagentTranscriptResult {
  const kept: Array<SubagentTranscriptEntry> = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = clipEntry(entries[index]!);
    used += entrySize(entry);
    if (used > TRANSCRIPT_CHAR_BUDGET && kept.length > 0) {
      break;
    }
    kept.push(entry);
  }
  kept.reverse();
  return { entries: kept, skipped: entries.length - kept.length };
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  const newline = trimmed.indexOf("\n");
  return newline === -1 ? trimmed : `${trimmed.slice(0, newline)} …`;
}

const TOOL_INPUT_SUMMARY_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
] as const;

/** One-line summary of a tool input: the command, path, or query when present. */
export function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input.trim().length > 0 ? firstLine(input) : undefined;
  }
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of TOOL_INPUT_SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return firstLine(value);
    }
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
      return firstLine(value.join(" "));
    }
  }
  const serialized = JSON.stringify(input);
  return serialized === "{}" ? undefined : serialized;
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
}

function nonEmpty(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type ToolEntry = Extract<SubagentTranscriptEntry, { _tag: "tool" }>;

function toolEntry(input: {
  readonly name: string;
  readonly detail?: string | undefined;
  readonly output?: string | undefined;
  readonly failed?: boolean | undefined;
}): ToolEntry {
  const detail = input.detail === undefined ? undefined : nonEmpty(input.detail);
  const output = input.output === undefined ? undefined : nonEmpty(input.output);
  return {
    _tag: "tool",
    name: input.name,
    ...(detail ? { detail } : {}),
    ...(output ? { output } : {}),
    ...(input.failed ? { failed: true } : {}),
  };
}

/**
 * Claude subagent transcripts are Anthropic API messages. Tool results arrive
 * as later user-role blocks and are folded back onto their tool_use entry.
 */
export function claudeSubagentTranscriptEntries(
  messages: ReadonlyArray<{
    readonly type: "user" | "assistant" | "system";
    readonly message: unknown;
  }>,
): ReadonlyArray<SubagentTranscriptEntry> {
  const entries: Array<SubagentTranscriptEntry> = [];
  const toolIndexById = new Map<string, number>();
  for (const message of messages) {
    if (message.type === "system") continue;
    const body = message.message as { readonly content?: unknown } | null;
    const content = body?.content;
    if (typeof content === "string") {
      const text = nonEmpty(content);
      if (text) entries.push({ _tag: message.type === "user" ? "prompt" : "message", text });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as ReadonlyArray<Record<string, unknown>>) {
      switch (block.type) {
        case "text": {
          const text = typeof block.text === "string" ? nonEmpty(block.text) : undefined;
          if (text) entries.push({ _tag: message.type === "user" ? "prompt" : "message", text });
          break;
        }
        case "thinking": {
          const text = typeof block.thinking === "string" ? nonEmpty(block.thinking) : undefined;
          if (text) entries.push({ _tag: "reasoning", text });
          break;
        }
        case "tool_use":
        case "server_tool_use":
        case "mcp_tool_use": {
          if (typeof block.id === "string") toolIndexById.set(block.id, entries.length);
          entries.push(
            toolEntry({
              name: typeof block.name === "string" ? block.name : "tool",
              detail: summarizeToolInput(block.input),
            }),
          );
          break;
        }
        case "tool_result": {
          const index =
            typeof block.tool_use_id === "string"
              ? toolIndexById.get(block.tool_use_id)
              : undefined;
          const tool = index === undefined ? undefined : entries[index];
          if (index === undefined || tool?._tag !== "tool") break;
          entries[index] = toolEntry({
            ...tool,
            output: textOf(block.content),
            failed: block.is_error === true,
          });
          break;
        }
      }
    }
  }
  return entries;
}

type CodexThreadItem = EffectCodexSchema.V2ThreadReadResponse__ThreadItem;

function codexItemEntry(item: CodexThreadItem): SubagentTranscriptEntry | undefined {
  switch (item.type) {
    case "userMessage": {
      const text = nonEmpty(
        item.content.flatMap((input) => (input.type === "text" ? [input.text] : [])).join("\n"),
      );
      return text ? { _tag: "prompt", text } : undefined;
    }
    case "agentMessage":
    case "plan": {
      const text = nonEmpty(item.text);
      return text ? { _tag: "message", text } : undefined;
    }
    case "reasoning": {
      const text = nonEmpty((item.summary ?? item.content ?? []).join("\n\n"));
      return text ? { _tag: "reasoning", text } : undefined;
    }
    case "commandExecution":
      return toolEntry({
        name: "shell",
        detail: item.command,
        output: item.aggregatedOutput ?? undefined,
        failed:
          item.status === "failed" ||
          (item.exitCode !== undefined && item.exitCode !== null && item.exitCode !== 0),
      });
    case "fileChange":
      return toolEntry({
        name: "edit",
        detail: item.changes.map((change) => change.path).join(", "),
        failed: item.status === "failed",
      });
    case "mcpToolCall":
      return toolEntry({
        name: `${item.server}.${item.tool}`,
        detail: summarizeToolInput(item.arguments),
        output: item.error?.message ?? textOf(item.result?.content),
        failed: item.status === "failed",
      });
    case "dynamicToolCall":
      return toolEntry({
        name: item.tool,
        detail: summarizeToolInput(item.arguments),
        output: textOf(item.contentItems),
        failed: item.success === false,
      });
    case "collabAgentToolCall":
      return toolEntry({
        name: item.tool,
        detail: item.prompt ?? undefined,
        failed: item.status === "failed",
      });
    case "webSearch":
      return toolEntry({ name: "web search", detail: item.query });
    case "imageView":
      return toolEntry({ name: "view image", detail: String(item.path) });
    default:
      return undefined;
  }
}

/** Codex children are ordinary threads; every turn's items read in order. */
export function codexSubagentTranscriptEntries(
  turns: ReadonlyArray<{ readonly items: ReadonlyArray<unknown> }>,
): ReadonlyArray<SubagentTranscriptEntry> {
  return turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      const entry = codexItemEntry(item as CodexThreadItem);
      return entry ? [entry] : [];
    }),
  );
}

/** OpenCode subagents are child sessions: messages of role-tagged parts. */
export function openCodeSubagentTranscriptEntries(
  messages: ReadonlyArray<{
    readonly info: { readonly role: string };
    readonly parts: ReadonlyArray<Part>;
  }>,
): ReadonlyArray<SubagentTranscriptEntry> {
  const entries: Array<SubagentTranscriptEntry> = [];
  for (const message of messages) {
    for (const part of message.parts) {
      switch (part.type) {
        case "text": {
          const text = part.ignored ? undefined : nonEmpty(part.text);
          if (text)
            entries.push({ _tag: message.info.role === "user" ? "prompt" : "message", text });
          break;
        }
        case "reasoning": {
          const text = nonEmpty(part.text);
          if (text) entries.push({ _tag: "reasoning", text });
          break;
        }
        case "tool": {
          const state = part.state;
          entries.push(
            toolEntry({
              name: part.tool,
              detail:
                (state.status === "running" || state.status === "completed"
                  ? state.title
                  : undefined) ?? summarizeToolInput(state.input),
              output:
                state.status === "completed"
                  ? state.output
                  : state.status === "error"
                    ? state.error
                    : undefined,
              failed: state.status === "error",
            }),
          );
          break;
        }
      }
    }
  }
  return entries;
}

const decodeWorkflowAgentMeta = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ description: Schema.optional(Schema.String) })),
);

/**
 * Finds the agent id of a Claude workflow member from its run's transcript
 * directory, for rows recorded before members carried `transcriptAgentId`.
 * Each attempt writes `agent-<id>.meta.json` naming the member's label; the
 * newest transcript wins so a retried member shows its latest attempt. Only
 * directories inside this session's `subagents/workflows` are read.
 */
export const resolveClaudeWorkflowMemberAgentId = Effect.fn("resolveClaudeWorkflowMemberAgentId")(
  function* (input: {
    readonly sessionId: string;
    readonly transcriptDir: string;
    readonly label: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(input.transcriptDir);
    const runsRoot = path.join(input.sessionId, "subagents", "workflows");
    if (path.dirname(directory).endsWith(`${path.sep}${runsRoot}`) === false) {
      return undefined;
    }
    let newest: { readonly agentId: string; readonly modifiedAt: number } | undefined;
    for (const name of yield* fileSystem.readDirectory(directory)) {
      const match = /^agent-([\w-]+)\.meta\.json$/.exec(name);
      if (!match) continue;
      const meta = decodeWorkflowAgentMeta(
        yield* fileSystem.readFileString(path.join(directory, name)),
      );
      if (Option.getOrUndefined(meta)?.description !== input.label) continue;
      const modifiedAt = yield* fileSystem
        .stat(path.join(directory, `agent-${match[1]}.jsonl`))
        .pipe(
          Effect.map((info) =>
            Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
          ),
          Effect.orElseSucceed(() => 0),
        );
      if (!newest || modifiedAt > newest.modifiedAt) {
        newest = { agentId: match[1]!, modifiedAt };
      }
    }
    return newest?.agentId;
  },
);
