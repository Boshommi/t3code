import { MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../session-logic";
import {
  collectChatFindDocuments,
  findChatFindMatches,
  formatChatFindCount,
  stepChatFindIndex,
} from "./chatFind";

const TURN_ID = TurnId.make("turn-1");

function userMessage(id: string, text: string): TimelineEntry {
  return {
    id: `entry:${id}`,
    kind: "message",
    createdAt: "2026-08-18T00:00:00.000Z",
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      turnId: TURN_ID,
      streaming: false,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    },
  };
}

function assistantMessage(id: string, text: string): TimelineEntry {
  return {
    id: `entry:${id}`,
    kind: "message",
    createdAt: "2026-08-18T00:00:00.000Z",
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text,
      turnId: TURN_ID,
      streaming: false,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    },
  };
}

describe("chatFind", () => {
  it("collects user and assistant text and skips empty system rows", () => {
    const documents = collectChatFindDocuments([
      userMessage("user-1", "Please fix the login form"),
      assistantMessage("asst-1", "Updated `login.tsx`"),
      {
        id: "entry:system",
        kind: "message",
        createdAt: "2026-08-18T00:00:00.000Z",
        message: {
          id: MessageId.make("system-1"),
          role: "system",
          text: "ignored",
          turnId: null,
          streaming: false,
          createdAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z",
        },
      },
    ]);

    expect(documents.map((document) => document.id)).toEqual(["user-1", "asst-1"]);
    expect(documents[0]?.text).toBe("Please fix the login form");
  });

  it("strips hidden user-message context blocks from the searchable text", () => {
    const documents = collectChatFindDocuments([
      userMessage(
        "user-1",
        "Look at this\n<terminal_context>\n- term-1:\nsecret token\n</terminal_context>",
      ),
    ]);

    expect(documents[0]?.text).toBe("Look at this");
    expect(findChatFindMatches(documents, "secret")).toEqual([]);
    expect(findChatFindMatches(documents, "look")).toHaveLength(1);
  });

  it("finds case-insensitive non-overlapping matches in order", () => {
    const documents = collectChatFindDocuments([
      userMessage("user-1", "Foo bar foo"),
      assistantMessage("asst-1", "FOO again"),
    ]);
    const matches = findChatFindMatches(documents, "foo");

    expect(matches.map((match) => [match.documentId, match.occurrence, match.start])).toEqual([
      ["user-1", 0, 0],
      ["user-1", 1, 8],
      ["asst-1", 0, 0],
    ]);
  });

  it("returns no matches for a blank query", () => {
    const documents = collectChatFindDocuments([userMessage("user-1", "hello")]);
    expect(findChatFindMatches(documents, "   ")).toEqual([]);
  });

  it("wraps next/previous match indices", () => {
    expect(stepChatFindIndex(0, 3, 1)).toBe(1);
    expect(stepChatFindIndex(2, 3, 1)).toBe(0);
    expect(stepChatFindIndex(0, 3, -1)).toBe(2);
    expect(stepChatFindIndex(0, 0, 1)).toBe(0);
  });

  it("formats the find-bar count the way a browser find field would", () => {
    expect(formatChatFindCount(0, 0)).toBe("0/0");
    expect(formatChatFindCount(0, 4)).toBe("1/4");
    expect(formatChatFindCount(3, 4)).toBe("4/4");
  });
});
