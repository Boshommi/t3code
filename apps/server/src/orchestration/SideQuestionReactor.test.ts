import {
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSideMessage,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  type ProjectionThreadSideMessage,
  ProjectionThreadSideMessageRepository,
} from "../persistence/Services/ProjectionThreadSideMessages.ts";
import { ProviderValidationError } from "../provider/Errors.ts";
import type { ProviderSideQuestionInput } from "../provider/Services/ProviderAdapter.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import * as SideQuestionReactor from "./SideQuestionReactor.ts";

const NOW = "2026-09-23T12:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-side");

type SideAnswerCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.side-answer.complete" }
>;

let uuidCounter = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(++uuidCounter % 256),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function sideMessage(
  id: string,
  role: OrchestrationSideMessage["role"],
  text: string,
  sideThreadId = "side-1",
  threadId = THREAD_ID,
): ProjectionThreadSideMessage {
  return {
    messageId: MessageId.make(id),
    threadId,
    sideThreadId: MessageId.make(sideThreadId),
    role,
    text,
    anchorMessageId: null,
    createdAt: NOW,
  };
}

function questionAdded(message: ProjectionThreadSideMessage): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make(`event-${message.messageId}`),
    aggregateKind: "thread",
    aggregateId: message.threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.side-message-added",
    payload: {
      threadId: message.threadId,
      message: {
        id: message.messageId,
        sideThreadId: message.sideThreadId,
        role: message.role,
        text: message.text,
        anchorMessageId: message.anchorMessageId,
        createdAt: message.createdAt,
      },
    },
  };
}

const makeHarness = Effect.fn("makeSideQuestionHarness")(function* (options: {
  readonly messages?: ReadonlyArray<ProjectionThreadSideMessage>;
  readonly unanswered?: ReadonlyArray<ProjectionThreadSideMessage>;
  readonly ask: (
    input: ProviderSideQuestionInput,
  ) => ReturnType<ProviderService["Service"]["askSideQuestion"]>;
}) {
  const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
  const commands = yield* Queue.unbounded<SideAnswerCommand>();
  const asked = yield* Queue.unbounded<ProviderSideQuestionInput>();

  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        command.type === "thread.side-answer.complete"
          ? Queue.offer(commands, command).pipe(Effect.as({ sequence: 2 }))
          : Effect.die(`unexpected command ${command.type}`),
      subscribeDomainEvents: PubSub.subscribe(domainEvents).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.mock(ProviderService)({
      askSideQuestion: (input) =>
        Queue.offer(asked, input).pipe(Effect.andThen(options.ask(input))),
    }),
    Layer.mock(ProjectionThreadSideMessageRepository)({
      listByThreadId: ({ threadId }) =>
        Effect.succeed((options.messages ?? []).filter((message) => message.threadId === threadId)),
      listUnansweredQuestions: () => Effect.succeed(options.unanswered ?? []),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  // Built in the test's scope so the reactor's fibers outlive this helper.
  const reactor = yield* SideQuestionReactor.make.pipe(Effect.provide(dependencies));
  yield* reactor.start();
  return {
    reactor,
    commands,
    asked,
    publish: (event: OrchestrationEvent) => PubSub.publish(domainEvents, event),
  };
});

describe("SideQuestionReactor", () => {
  it.effect("answers with the side thread's earlier exchanges, skipping failed ones", () =>
    Effect.gen(function* () {
      const question = sideMessage("q-3", "user", "And the tests?");
      const harness = yield* makeHarness({
        messages: [
          sideMessage("side-1", "user", "Which file?"),
          sideMessage("a-1", "assistant", "src/app.ts"),
          sideMessage("q-2", "user", "Why?"),
          sideMessage("a-2", "error", "Interrupted by a server restart. Ask again."),
          sideMessage("other-q", "user", "Unrelated", "side-other"),
          sideMessage("other-a", "assistant", "Unrelated answer", "side-other"),
          question,
        ],
        ask: () => Effect.succeed("They pass."),
      });

      yield* harness.publish(questionAdded(question));
      const command = yield* Queue.take(harness.commands);
      const asked = yield* Queue.take(harness.asked);

      assert.deepStrictEqual(asked, {
        threadId: THREAD_ID,
        sideThreadId: MessageId.make("side-1"),
        question: "And the tests?",
        history: [{ question: "Which file?", answer: "src/app.ts" }],
      });
      assert.strictEqual(command.role, "assistant");
      assert.strictEqual(command.text, "They pass.");
      assert.strictEqual(command.sideThreadId, "side-1");
      assert.strictEqual(command.threadId, THREAD_ID);
    }).pipe(Effect.scoped),
  );

  it.effect("records a short error when the provider cannot answer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        ask: () =>
          Effect.fail(
            new ProviderValidationError({
              operation: "ProviderService.askSideQuestion",
              issue: "Side questions are not available for this provider.",
            }),
          ),
      });

      yield* harness.publish(questionAdded(sideMessage("side-1", "user", "What now?")));
      const command = yield* Queue.take(harness.commands);

      assert.strictEqual(command.role, "error");
      assert.strictEqual(command.text, "Side questions are not available for this provider.");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps internal failures out of the error text", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        ask: () =>
          Effect.fail(
            new ProviderValidationError({
              operation: "ProviderService.recover",
              issue: "Cannot recover thread 'x' because no provider resume state is persisted.",
            }),
          ),
      });

      yield* harness.publish(questionAdded(sideMessage("side-1", "user", "What now?")));
      const command = yield* Queue.take(harness.commands);

      assert.strictEqual(command.role, "error");
      assert.strictEqual(command.text, "Couldn't answer this side question. Try again.");
    }).pipe(Effect.scoped),
  );

  it.effect("settles questions orphaned by a restart and never answers them", () =>
    Effect.gen(function* () {
      const orphan = sideMessage("side-orphan", "user", "Still there?", "side-orphan");
      const harness = yield* makeHarness({
        unanswered: [orphan],
        ask: () => Effect.succeed("late answer"),
      });

      const settled = yield* Queue.take(harness.commands);
      assert.strictEqual(settled.role, "error");
      assert.strictEqual(settled.text, SideQuestionReactor.SIDE_ANSWER_INTERRUPTED_TEXT);
      assert.strictEqual(settled.sideThreadId, "side-orphan");

      // A replayed event for the orphan and assistant messages are both ignored.
      yield* harness.publish(questionAdded(orphan));
      yield* harness.publish(questionAdded(sideMessage("a-1", "assistant", "An answer")));
      yield* harness.publish(questionAdded(sideMessage("side-2", "user", "Next?", "side-2")));
      const next = yield* Queue.take(harness.commands);
      assert.strictEqual(next.sideThreadId, "side-2");
      yield* harness.reactor.drain;
      assert.strictEqual(yield* Queue.size(harness.commands), 0);
      assert.strictEqual(yield* Queue.size(harness.asked), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("answers questions concurrently so a slow one blocks nothing", () =>
    Effect.gen(function* () {
      const releaseSlow = yield* Deferred.make<string>();
      const harness = yield* makeHarness({
        ask: (input) =>
          input.question === "slow" ? Deferred.await(releaseSlow) : Effect.succeed("fast answer"),
      });

      yield* harness.publish(questionAdded(sideMessage("side-slow", "user", "slow", "side-slow")));
      yield* Queue.take(harness.asked);
      yield* harness.publish(questionAdded(sideMessage("side-fast", "user", "fast", "side-fast")));
      const first = yield* Queue.take(harness.commands);
      assert.strictEqual(first.text, "fast answer");

      yield* Deferred.succeed(releaseSlow, "slow answer");
      const second = yield* Queue.take(harness.commands);
      assert.strictEqual(second.text, "slow answer");
    }).pipe(Effect.scoped),
  );
});
