import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as itEffect } from "@effect/vitest";
import type { SubagentTranscriptEntry } from "@t3tools/contracts";
import type { Part } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import {
  boundSubagentTranscript,
  claudeSubagentTranscriptEntries,
  codexSubagentTranscriptEntries,
  openCodeSubagentTranscriptEntries,
  resolveClaudeWorkflowMemberAgentId,
} from "./subagentTranscript.ts";

describe("claudeSubagentTranscriptEntries", () => {
  it("folds tool results back onto the tool call that produced them", () => {
    const entries = claudeSubagentTranscriptEntries([
      { type: "user", message: { role: "user", content: "Find the bug." } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Start with the logs." },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "cat log\nwc" } },
            { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "/a.ts" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-2", content: [{ type: "text", text: "x" }] },
            { type: "tool_result", tool_use_id: "tool-1", content: "boom", is_error: true },
          ],
        },
      },
      { type: "system", message: { content: "compacted" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Found it." }] } },
    ]);

    expect(entries).toEqual([
      { _tag: "prompt", text: "Find the bug." },
      { _tag: "reasoning", text: "Start with the logs." },
      { _tag: "tool", name: "Bash", detail: "cat log …", output: "boom", failed: true },
      { _tag: "tool", name: "Read", detail: "/a.ts", output: "x" },
      { _tag: "message", text: "Found it." },
    ]);
  });
});

describe("codexSubagentTranscriptEntries", () => {
  it("reads every turn in order and marks failed commands", () => {
    const entries = codexSubagentTranscriptEntries([
      {
        items: [
          { type: "userMessage", id: "u", content: [{ type: "text", text: "Review orders." }] },
          { type: "reasoning", id: "r", summary: ["Checking tests."] },
          {
            type: "commandExecution",
            id: "c",
            command: "pnpm test",
            commandActions: [],
            cwd: "/repo",
            aggregatedOutput: "1 failed",
            exitCode: 1,
            status: "completed",
          },
          { type: "contextCompaction", id: "k" },
        ],
      },
      { items: [{ type: "agentMessage", id: "a", text: "One test fails." }] },
    ]);

    expect(entries).toEqual([
      { _tag: "prompt", text: "Review orders." },
      { _tag: "reasoning", text: "Checking tests." },
      { _tag: "tool", name: "shell", detail: "pnpm test", output: "1 failed", failed: true },
      { _tag: "message", text: "One test fails." },
    ]);
  });
});

describe("openCodeSubagentTranscriptEntries", () => {
  it("maps user text to prompts and tool states to outputs", () => {
    const part = (fields: Record<string, unknown>) => fields as unknown as Part;
    const entries = openCodeSubagentTranscriptEntries([
      { info: { role: "user" }, parts: [part({ type: "text", text: "Explore the repo." })] },
      {
        info: { role: "assistant" },
        parts: [
          part({
            type: "tool",
            tool: "grep",
            state: {
              status: "completed",
              input: { pattern: "TODO" },
              title: "TODO",
              output: "a.ts",
            },
          }),
          part({
            type: "tool",
            tool: "bash",
            state: { status: "error", input: { command: "ls /nope" }, error: "not found" },
          }),
          part({ type: "step-finish" }),
          part({ type: "text", text: "Done." }),
        ],
      },
    ]);

    expect(entries).toEqual([
      { _tag: "prompt", text: "Explore the repo." },
      { _tag: "tool", name: "grep", detail: "TODO", output: "a.ts" },
      { _tag: "tool", name: "bash", detail: "ls /nope", output: "not found", failed: true },
      { _tag: "message", text: "Done." },
    ]);
  });
});

describe("boundSubagentTranscript", () => {
  it("keeps the newest entries within the budget and reports the cut", () => {
    const entries: Array<SubagentTranscriptEntry> = Array.from({ length: 60 }, (_, index) => ({
      _tag: "message",
      text: `${index}:${"x".repeat(10_000)}`,
    }));

    const result = boundSubagentTranscript(entries);

    expect(result.skipped).toBeGreaterThan(0);
    expect(result.skipped + result.entries.length).toBe(entries.length);
    const last = result.entries.at(-1);
    expect(last?._tag === "message" && last.text.startsWith("59:")).toBe(true);
    expect(last?._tag === "message" && last.text.length).toBeLessThanOrEqual(6_000);
  });

  it("returns short transcripts untouched", () => {
    const entries: Array<SubagentTranscriptEntry> = [{ _tag: "message", text: "hi" }];
    expect(boundSubagentTranscript(entries)).toEqual({ entries, skipped: 0 });
  });
});

describe("resolveClaudeWorkflowMemberAgentId", () => {
  const sessionId = "session-1";
  const writeRun = Effect.fn(function* (root: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runDir = path.join(root, sessionId, "subagents", "workflows", "wf_run");
    yield* fileSystem.makeDirectory(runDir, { recursive: true });
    const writeAgent = Effect.fn(function* (agentId: string, label: string, modifiedAt: number) {
      yield* fileSystem.writeFileString(
        path.join(runDir, `agent-${agentId}.meta.json`),
        `{"agentType":"workflow-subagent","description":"${label}"}`,
      );
      const transcript = path.join(runDir, `agent-${agentId}.jsonl`);
      yield* fileSystem.writeFileString(transcript, "");
      yield* fileSystem.utimes(transcript, modifiedAt, modifiedAt);
    });
    yield* writeAgent("aFirstAttempt", "gaps:shared", 1_000);
    yield* writeAgent("aRetry", "gaps:shared", 2_000);
    yield* writeAgent("aOther", "gaps:portfolio", 3_000);
    return runDir;
  });

  itEffect.effect("picks the newest attempt with the member's label", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const runDir = yield* writeRun(yield* fileSystem.makeTempDirectoryScoped());
      const resolve = (label: string) =>
        resolveClaudeWorkflowMemberAgentId({ sessionId, transcriptDir: runDir, label });

      expect(yield* resolve("gaps:shared")).toBe("aRetry");
      expect(yield* resolve("gaps:missing")).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  itEffect.effect("refuses run directories outside the session", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const runDir = yield* writeRun(yield* fileSystem.makeTempDirectoryScoped());

      const agentId = yield* resolveClaudeWorkflowMemberAgentId({
        sessionId: "another-session",
        transcriptDir: runDir,
        label: "gaps:shared",
      });

      expect(agentId).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
