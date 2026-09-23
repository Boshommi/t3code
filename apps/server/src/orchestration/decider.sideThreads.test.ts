import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const THREAD_ID = ThreadId.make("thread-1");
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const ANCHOR_ID = MessageId.make("main-message-1");

const baseReadModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: CREATED_AT,
};

let commandCounter = 0;
const nextCommandId = () => CommandId.make(`cmd-${++commandCounter}`);

const ask = (input: {
  readonly sideThreadId: string;
  readonly messageId: string;
  readonly anchorMessageId?: MessageId | null;
}): OrchestrationCommand => ({
  type: "thread.side-question.ask",
  commandId: nextCommandId(),
  threadId: THREAD_ID,
  sideThreadId: MessageId.make(input.sideThreadId),
  messageId: MessageId.make(input.messageId),
  text: `question ${input.messageId}`,
  anchorMessageId: input.anchorMessageId ?? null,
  createdAt: "2026-01-01T00:01:00.000Z",
});

const answer = (input: {
  readonly sideThreadId: string;
  readonly messageId: string;
  readonly role?: "assistant" | "error";
}): OrchestrationCommand => ({
  type: "thread.side-answer.complete",
  commandId: nextCommandId(),
  threadId: THREAD_ID,
  sideThreadId: MessageId.make(input.sideThreadId),
  messageId: MessageId.make(input.messageId),
  role: input.role ?? "assistant",
  text: `answer ${input.messageId}`,
  createdAt: "2026-01-01T00:02:00.000Z",
});

const deleteSideThread = (sideThreadId: string): OrchestrationCommand => ({
  type: "thread.side-thread.delete",
  commandId: nextCommandId(),
  threadId: THREAD_ID,
  sideThreadId: MessageId.make(sideThreadId),
  createdAt: "2026-01-01T00:03:00.000Z",
});

/** Decide the command and project its events, like the engine does. */
const run = Effect.fn("run")(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const decided = yield* decideOrchestrationCommand({ command, readModel });
  const events = Array.isArray(decided) ? decided : [decided];
  let next = readModel;
  const projected: OrchestrationEvent[] = [];
  for (const event of events) {
    const withSequence = { ...event, sequence: next.snapshotSequence + 1 } as OrchestrationEvent;
    projected.push(withSequence);
    next = yield* projectEvent(next, withSequence);
  }
  return { readModel: next, events: projected };
});

const runAll = Effect.fn("runAll")(function* (
  readModel: OrchestrationReadModel,
  commands: ReadonlyArray<OrchestrationCommand>,
) {
  let next = readModel;
  for (const command of commands) {
    next = (yield* run(next, command)).readModel;
  }
  return next;
});

const sideMessagesOf = (readModel: OrchestrationReadModel) =>
  readModel.threads.find((thread) => thread.id === THREAD_ID)?.sideMessages ?? [];

it.layer(NodeServices.layer)("side thread decider", (it) => {
  it.effect("starts a side thread without touching the main thread", () =>
    Effect.gen(function* () {
      const { readModel, events } = yield* run(
        baseReadModel,
        ask({ sideThreadId: "side-1", messageId: "side-1", anchorMessageId: ANCHOR_ID }),
      );

      expect(events.map((event) => event.type)).toEqual(["thread.side-message-added"]);
      expect(sideMessagesOf(readModel)).toEqual([
        {
          id: MessageId.make("side-1"),
          sideThreadId: MessageId.make("side-1"),
          role: "user",
          text: "question side-1",
          anchorMessageId: ANCHOR_ID,
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ]);
      const thread = readModel.threads[0]!;
      expect(thread.updatedAt).toBe(CREATED_AT);
      expect(thread.latestTurn).toBeNull();
      expect(thread.messages).toEqual([]);
    }),
  );

  it.effect("keeps the side thread's anchor on follow-ups", () =>
    Effect.gen(function* () {
      const started = yield* runAll(baseReadModel, [
        ask({ sideThreadId: "side-1", messageId: "side-1", anchorMessageId: ANCHOR_ID }),
        answer({ sideThreadId: "side-1", messageId: "answer-1" }),
      ]);
      const { readModel } = yield* run(
        started,
        ask({
          sideThreadId: "side-1",
          messageId: "follow-up-1",
          anchorMessageId: MessageId.make("some-other-message"),
        }),
      );

      const messages = sideMessagesOf(readModel);
      expect(
        messages.map((message) => [message.id, message.role, message.anchorMessageId]),
      ).toEqual([
        ["side-1", "user", ANCHOR_ID],
        ["answer-1", "assistant", ANCHOR_ID],
        ["follow-up-1", "user", ANCHOR_ID],
      ]);
    }),
  );

  it.effect("rejects a follow-up while the previous question is unanswered", () =>
    Effect.gen(function* () {
      const started = yield* runAll(baseReadModel, [
        ask({ sideThreadId: "side-1", messageId: "side-1" }),
      ]);
      const error = yield* Effect.flip(
        run(started, ask({ sideThreadId: "side-1", messageId: "follow-up-1" })),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("allows asking again after an error answer", () =>
    Effect.gen(function* () {
      const failed = yield* runAll(baseReadModel, [
        ask({ sideThreadId: "side-1", messageId: "side-1" }),
        answer({ sideThreadId: "side-1", messageId: "answer-1", role: "error" }),
      ]);
      const { readModel } = yield* run(
        failed,
        ask({ sideThreadId: "side-1", messageId: "retry-1" }),
      );
      expect(sideMessagesOf(readModel).map((message) => message.role)).toEqual([
        "user",
        "error",
        "user",
      ]);
    }),
  );

  it.effect("rejects unknown side threads, reused ids, and deleted threads", () =>
    Effect.gen(function* () {
      const unknownFollowUp = yield* Effect.flip(
        run(baseReadModel, ask({ sideThreadId: "missing", messageId: "follow-up-1" })),
      );
      expect(unknownFollowUp._tag).toBe("OrchestrationCommandInvariantError");

      const started = yield* runAll(baseReadModel, [
        ask({ sideThreadId: "side-1", messageId: "side-1" }),
        answer({ sideThreadId: "side-1", messageId: "answer-1" }),
      ]);
      const restarted = yield* Effect.flip(
        run(started, ask({ sideThreadId: "side-1", messageId: "side-1" })),
      );
      expect(restarted._tag).toBe("OrchestrationCommandInvariantError");

      const deletedThread: OrchestrationReadModel = {
        ...baseReadModel,
        threads: baseReadModel.threads.map((thread) => ({ ...thread, deletedAt: CREATED_AT })),
      };
      const onDeleted = yield* Effect.flip(
        run(deletedThread, ask({ sideThreadId: "side-1", messageId: "side-1" })),
      );
      expect(onDeleted._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("deletes only the targeted side thread", () =>
    Effect.gen(function* () {
      const twoThreads = yield* runAll(baseReadModel, [
        ask({ sideThreadId: "side-1", messageId: "side-1" }),
        answer({ sideThreadId: "side-1", messageId: "answer-1" }),
        ask({ sideThreadId: "side-2", messageId: "side-2" }),
      ]);
      const { readModel } = yield* run(twoThreads, deleteSideThread("side-1"));
      expect(sideMessagesOf(readModel).map((message) => message.id)).toEqual(["side-2"]);

      const missing = yield* Effect.flip(run(readModel, deleteSideThread("side-1")));
      expect(missing._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("drops an answer that arrives after its side thread was deleted", () =>
    Effect.gen(function* () {
      const deleted = yield* runAll(baseReadModel, [
        ask({ sideThreadId: "side-1", messageId: "side-1" }),
        deleteSideThread("side-1"),
      ]);
      const { readModel, events } = yield* run(
        deleted,
        answer({ sideThreadId: "side-1", messageId: "answer-1" }),
      );
      expect(events.map((event) => event.type)).toEqual(["thread.meta-updated"]);
      expect(events[0]?.payload).toEqual({ threadId: THREAD_ID, updatedAt: CREATED_AT });
      expect(sideMessagesOf(readModel)).toEqual([]);
    }),
  );

  it.effect("drops a duplicate answer", () =>
    Effect.gen(function* () {
      const answered = yield* runAll(baseReadModel, [
        ask({ sideThreadId: "side-1", messageId: "side-1" }),
        answer({ sideThreadId: "side-1", messageId: "answer-1" }),
      ]);
      const { readModel, events } = yield* run(
        answered,
        answer({ sideThreadId: "side-1", messageId: "answer-2" }),
      );
      expect(events.map((event) => event.type)).toEqual(["thread.meta-updated"]);
      expect(sideMessagesOf(readModel).map((message) => message.id)).toEqual([
        "side-1",
        "answer-1",
      ]);
    }),
  );
});

it.layer(NodeServices.layer)("side thread projector", (it) => {
  it.effect("keeps side messages across a thread revert", () =>
    Effect.gen(function* () {
      const asked = yield* runAll(baseReadModel, [
        ask({ sideThreadId: "side-1", messageId: "side-1" }),
      ]);
      const reverted = yield* projectEvent(asked, {
        sequence: asked.snapshotSequence + 1,
        eventId: EventId.make("event-revert"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-01-01T00:04:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.reverted",
        payload: { threadId: THREAD_ID, turnCount: 0 },
      });
      expect(sideMessagesOf(reverted).map((message) => message.id)).toEqual(["side-1"]);
    }),
  );
});
