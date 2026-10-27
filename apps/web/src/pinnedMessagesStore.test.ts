import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import { insertPin, migratePinnedMessages, type PinnedMessage } from "./pinnedMessagesStore";

function pin(messageId: string, messageCreatedAt: string, text = "Response"): PinnedMessage {
  return {
    citation: {
      version: 1,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make(messageId),
      text,
      start: 0,
      end: text.length,
      prefix: "",
      suffix: "",
    },
    messageCreatedAt,
  };
}

describe("insertPin", () => {
  it("keeps pins in thread order regardless of when they were pinned", () => {
    const pins = insertPin(
      insertPin([], pin("late", "2026-01-01T00:02:00.000Z")),
      pin("early", "2026-01-01T00:01:00.000Z"),
    );

    expect(pins.map((entry) => entry.citation.messageId)).toEqual(["early", "late"]);
  });

  it("replaces an existing pin for the same response", () => {
    const pins = insertPin(
      [pin("message", "2026-01-01T00:00:00.000Z", "Old")],
      pin("message", "2026-01-01T00:00:00.000Z", "New"),
    );

    expect(pins.map((entry) => entry.citation.text)).toEqual(["New"]);
  });
});

describe("migratePinnedMessages", () => {
  it("drops malformed pins and threads left empty", () => {
    const valid = pin("message", "2026-01-01T00:00:00.000Z");

    expect(
      migratePinnedMessages({
        pinsByThreadKey: {
          kept: [valid, { citation: { messageId: "missing-fields" }, messageCreatedAt: "x" }],
          dropped: [{ messageCreatedAt: 1 }],
          notAnArray: "pins",
        },
        sectionOpen: true,
      }),
    ).toEqual({ pinsByThreadKey: { kept: [valid] }, sectionOpen: true });
  });

  it("starts empty and collapsed without stored state", () => {
    expect(migratePinnedMessages(undefined)).toEqual({ pinsByThreadKey: {}, sectionOpen: false });
  });
});
