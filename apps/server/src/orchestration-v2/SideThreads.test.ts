import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2SideMessage,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { planSideThreadCommand, sideThreadHistory } from "./SideThreads.ts";

const threadId = ThreadId.make("thread:side");
const now = DateTime.makeUnsafe("2026-10-21T10:00:00.000Z");
const thread = { id: threadId, deletedAt: null } as OrchestrationV2AppThread;

function sideMessage(
  id: string,
  role: OrchestrationV2SideMessage["role"],
  sideThreadId = "side:1",
): OrchestrationV2SideMessage {
  return {
    id: MessageId.make(id),
    threadId,
    sideThreadId: MessageId.make(sideThreadId),
    role,
    text: `${role} ${id}`,
    anchorMessageId: MessageId.make("message:anchor"),
    createdAt: now,
  };
}

const ask = (input: { readonly sideThreadId: string; readonly messageId: string }) =>
  ({
    type: "thread.side-question.ask",
    commandId: CommandId.make(`command:${input.messageId}`),
    threadId,
    sideThreadId: MessageId.make(input.sideThreadId),
    messageId: MessageId.make(input.messageId),
    text: "Why?",
    anchorMessageId: MessageId.make("message:other"),
  }) as const;

const complete = (questionId: string) =>
  ({
    type: "thread.side-answer.complete",
    commandId: CommandId.make(`command:answer:${questionId}`),
    threadId,
    sideThreadId: MessageId.make("side:1"),
    questionId: MessageId.make(questionId),
    messageId: MessageId.make(`answer:${questionId}`),
    role: "assistant",
    text: "Because.",
  }) as const;

describe("planSideThreadCommand", () => {
  it("starts a side thread anchored where it was asked", () => {
    const plan = planSideThreadCommand({
      command: ask({ sideThreadId: "side:new", messageId: "side:new" }),
      thread,
      sideMessages: [],
      now,
    });
    assert.equal(plan.type, "emit");
    if (plan.type !== "emit" || plan.event.type !== "side-message.updated") return;
    assert.equal(plan.event.payload.role, "user");
    assert.equal(plan.event.payload.anchorMessageId, "message:other");
  });

  it("keeps follow-ups on the side thread's original anchor", () => {
    const plan = planSideThreadCommand({
      command: ask({ sideThreadId: "side:1", messageId: "q:2" }),
      thread,
      sideMessages: [sideMessage("side:1", "user"), sideMessage("a:1", "assistant")],
      now,
    });
    assert.equal(plan.type, "emit");
    if (plan.type !== "emit" || plan.event.type !== "side-message.updated") return;
    assert.equal(plan.event.payload.anchorMessageId, "message:anchor");
  });

  it("rejects a follow-up while the side thread waits, or to a missing side thread", () => {
    const waiting = planSideThreadCommand({
      command: ask({ sideThreadId: "side:1", messageId: "q:2" }),
      thread,
      sideMessages: [sideMessage("side:1", "user")],
      now,
    });
    assert.equal(waiting.type, "reject");
    const missing = planSideThreadCommand({
      command: ask({ sideThreadId: "side:missing", messageId: "q:2" }),
      thread,
      sideMessages: [],
      now,
    });
    assert.equal(missing.type, "reject");
  });

  it("lands an answer only for the question still waiting", () => {
    const sideMessages = [sideMessage("side:1", "user")];
    assert.equal(
      planSideThreadCommand({ command: complete("side:1"), thread, sideMessages, now }).type,
      "emit",
    );
    assert.equal(
      planSideThreadCommand({ command: complete("q:stale"), thread, sideMessages, now }).type,
      "ignore",
    );
    assert.equal(
      planSideThreadCommand({ command: complete("side:1"), thread, sideMessages: [], now }).type,
      "ignore",
    );
  });
});

describe("sideThreadHistory", () => {
  it("pairs answered exchanges before the question and skips failed answers", () => {
    const messages = [
      sideMessage("side:1", "user"),
      sideMessage("a:1", "assistant"),
      sideMessage("q:2", "user"),
      sideMessage("e:2", "error"),
      sideMessage("other", "user", "side:other"),
      sideMessage("q:3", "user"),
    ];
    assert.deepEqual(
      sideThreadHistory(messages, { id: MessageId.make("q:3"), sideThreadId: messages[0]!.id }),
      [{ question: "user side:1", answer: "assistant a:1" }],
    );
  });
});
