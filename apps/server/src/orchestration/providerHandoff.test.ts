import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildProviderHandoffInput, collectHandoffHistory } from "./providerHandoff.ts";

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  streaming = false,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("collectHandoffHistory", () => {
  it("keeps the conversation and skips the current, streaming, compact and system messages", () => {
    expect(
      collectHandoffHistory({
        messages: [
          message("m1", "user", " Fix the login bug "),
          message("m2", "assistant", "Fixed it in auth.ts"),
          message("m3", "user", "/compact"),
          message("m4", "system", "internal"),
          message("m5", "assistant", "partial", true),
          message("m6", "user", "Now add a test"),
        ],
        currentMessageId: MessageId.make("m6"),
      }),
    ).toEqual([
      { role: "user", text: "Fix the login bug" },
      { role: "assistant", text: "Fixed it in auth.ts" },
    ]);
  });

  it("drops the oldest messages beyond the budget but always keeps the latest", () => {
    const messages = [
      message("m1", "user", "a".repeat(40)),
      message("m2", "assistant", "b".repeat(40)),
      message("m3", "user", "c".repeat(40)),
    ];

    expect(collectHandoffHistory({ messages, maxChars: 80 }).map((entry) => entry.text)).toEqual([
      "b".repeat(40),
      "c".repeat(40),
    ]);
    expect(collectHandoffHistory({ messages, maxChars: 10 })).toHaveLength(1);
  });
});

describe("buildProviderHandoffInput", () => {
  it("hands over the history ahead of the new message", () => {
    const result = buildProviderHandoffInput({
      history: [
        { role: "user", text: "Fix the login bug" },
        { role: "assistant", text: "Fixed it in auth.ts" },
      ],
      previousProviderName: "Claude",
      messageText: "Now add a test",
    });

    expect(result.handedOffMessageCount).toBe(2);
    expect(result.text).toBe(
      [
        "<conversation_handoff>",
        "This conversation started with Claude and is continuing with you. The earlier messages are below for context. The workspace already contains any changes made so far.",
        "",
        "[user]\nFix the login bug\n\n[assistant]\nFixed it in auth.ts",
        "</conversation_handoff>",
        "",
        "Now add a test",
      ].join("\n"),
    );
  });

  it("returns the message unchanged without history", () => {
    expect(
      buildProviderHandoffInput({
        history: [],
        previousProviderName: "Codex",
        messageText: "hello",
      }),
    ).toEqual({ text: "hello", handedOffMessageCount: 0 });
  });

  it("drops the oldest messages to stay within the transcript budget", () => {
    const result = buildProviderHandoffInput({
      history: [
        { role: "user", text: "a".repeat(40) },
        { role: "assistant", text: "b".repeat(40) },
        { role: "user", text: "c".repeat(40) },
      ],
      previousProviderName: "Codex",
      messageText: "next",
      maxTranscriptChars: 110,
    });

    expect(result.handedOffMessageCount).toBe(2);
    expect(result.text).not.toContain("a".repeat(40));
    expect(result.text).toContain("1 older message was omitted.");
  });

  it("keeps the tail of an oversized latest message", () => {
    const result = buildProviderHandoffInput({
      history: [{ role: "assistant", text: `BEGIN${"x".repeat(100)}end` }],
      previousProviderName: "Codex",
      messageText: "next",
      maxTranscriptChars: 20,
    });

    expect(result.handedOffMessageCount).toBe(1);
    expect(result.text).toContain(`[assistant]\n…${"x".repeat(17)}end`);
    expect(result.text).not.toContain("BEGIN");
  });
});
