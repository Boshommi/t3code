/**
 * Side threads (`/btw`): read-only questions about a thread, answered beside it.
 * Deciding a side-thread command never touches the thread's runs, provider
 * conversation, or `updatedAt`: asking about a thread must not change it.
 */
import type {
  MessageId,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  OrchestrationV2SideMessage,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

export type SideThreadCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "thread.side-question.ask"
      | "thread.side-thread.delete"
      | "thread.side-answer.complete";
  }
>;

type WithoutId<Event> = Event extends unknown ? Omit<Event, "id"> : never;
type SideThreadEvent = WithoutId<
  Extract<
    OrchestrationV2DomainEvent,
    { readonly type: "side-message.updated" | "side-thread.deleted" }
  >
>;

export type SideThreadCommandPlan =
  | { readonly type: "emit"; readonly event: SideThreadEvent }
  /** A late answer whose question is gone or already answered lands as a no-op. */
  | { readonly type: "ignore" }
  | { readonly type: "reject"; readonly detail: string };

function sideThreadMessages(
  sideMessages: ReadonlyArray<OrchestrationV2SideMessage>,
  sideThreadId: MessageId,
): ReadonlyArray<OrchestrationV2SideMessage> {
  return sideMessages.filter((message) => message.sideThreadId === sideThreadId);
}

export function planSideThreadCommand(input: {
  readonly command: SideThreadCommand;
  readonly thread: OrchestrationV2AppThread;
  readonly sideMessages: ReadonlyArray<OrchestrationV2SideMessage>;
  readonly now: DateTime.Utc;
}): SideThreadCommandPlan {
  const { command, thread, now } = input;
  const sideThread = sideThreadMessages(input.sideMessages, command.sideThreadId);
  const message = (
    fields: Pick<OrchestrationV2SideMessage, "id" | "role" | "text" | "anchorMessageId">,
  ): SideThreadCommandPlan => ({
    type: "emit",
    event: {
      type: "side-message.updated",
      threadId: thread.id,
      occurredAt: now,
      payload: {
        ...fields,
        threadId: thread.id,
        sideThreadId: command.sideThreadId,
        createdAt: now,
      },
    },
  });

  switch (command.type) {
    case "thread.side-question.ask": {
      if (thread.deletedAt !== null) {
        return { type: "reject", detail: `Thread ${thread.id} is deleted.` };
      }
      if (input.sideMessages.some((existing) => existing.id === command.messageId)) {
        return { type: "reject", detail: `Side message ${command.messageId} already exists.` };
      }
      // A side thread's id is its first question's id, so the check above
      // also rejects starting the same side thread twice.
      if (command.sideThreadId !== command.messageId && sideThread.length === 0) {
        return { type: "reject", detail: `Side thread ${command.sideThreadId} does not exist.` };
      }
      if (sideThread.at(-1)?.role === "user") {
        return {
          type: "reject",
          detail: `Side thread ${command.sideThreadId} is still waiting for an answer.`,
        };
      }
      return message({
        id: command.messageId,
        role: "user",
        text: command.text,
        // Follow-ups stay anchored where the side thread started.
        anchorMessageId: sideThread[0]?.anchorMessageId ?? command.anchorMessageId,
      });
    }
    case "thread.side-thread.delete":
      if (sideThread.length === 0) {
        return { type: "reject", detail: `Side thread ${command.sideThreadId} does not exist.` };
      }
      return {
        type: "emit",
        event: {
          type: "side-thread.deleted",
          threadId: thread.id,
          occurredAt: now,
          payload: { sideThreadId: command.sideThreadId },
        },
      };
    case "thread.side-answer.complete": {
      const pending = sideThread.at(-1);
      if (
        thread.deletedAt !== null ||
        pending?.role !== "user" ||
        pending.id !== command.questionId
      ) {
        return { type: "ignore" };
      }
      return message({
        id: command.messageId,
        role: command.role,
        text: command.text,
        anchorMessageId: sideThread[0]?.anchorMessageId ?? null,
      });
    }
  }
}

/**
 * The answered exchanges of a side thread before `questionId`, oldest first.
 * Failed answers are skipped: the provider never saw them.
 */
export function sideThreadHistory(
  sideMessages: ReadonlyArray<OrchestrationV2SideMessage>,
  question: Pick<OrchestrationV2SideMessage, "id" | "sideThreadId">,
): ReadonlyArray<{ readonly question: string; readonly answer: string }> {
  const sideThread = sideThreadMessages(sideMessages, question.sideThreadId);
  const questionIndex = sideThread.findIndex((message) => message.id === question.id);
  const earlier = questionIndex >= 0 ? sideThread.slice(0, questionIndex) : sideThread;
  const history: Array<{ question: string; answer: string }> = [];
  for (const [index, message] of earlier.entries()) {
    const next = earlier[index + 1];
    if (message.role === "user" && next?.role === "assistant") {
      history.push({ question: message.text, answer: next.text });
    }
  }
  return history;
}
