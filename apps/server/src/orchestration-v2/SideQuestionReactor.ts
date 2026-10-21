/**
 * Answers side questions (`/btw`) from the thread's live provider session.
 *
 * Each question runs in its own fiber, never through the effect outbox: the
 * outbox serializes a thread's effects, and a slow answer must not hold up the
 * thread's own turn, steering, or Stop. Like MCP app requests, a stopped
 * session is reported, never started. The answer, or a short user-facing
 * error, lands through the internal `thread.side-answer.complete` command.
 */
import { CommandId, MessageId, type OrchestrationV2SideMessage } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { sideThreadHistory } from "./SideThreads.ts";

export class SideQuestionReactor extends Context.Service<
  SideQuestionReactor,
  {
    /** Settles questions a restart orphaned, then answers new ones. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves once no question is being answered. For tests. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/SideQuestionReactor") {}

export const SIDE_ANSWER_INTERRUPTED_TEXT = "Interrupted by a server restart. Ask again.";
const SIDE_ANSWER_TIMEOUT = "5 minutes";
const SIDE_ANSWER_ERROR_MAX_CHARS = 500;

/** A failure the user can act on; anything else stays in the server log. */
class SideAnswerUnavailable extends Schema.TaggedError<SideAnswerUnavailable>()(
  "SideAnswerUnavailable",
  { text: Schema.String },
) {}

const isSideAnswerUnavailable = Schema.is(SideAnswerUnavailable);
const isSideQuestionError = Schema.is(ProviderAdapter.ProviderAdapterSideQuestionError);

function sideAnswerErrorText(error: unknown): string {
  const text = (
    isSideAnswerUnavailable(error)
      ? error.text
      : isSideQuestionError(error)
        ? error.detail
        : "Couldn't answer this side question. Try again."
  ).trim();
  return text.length > SIDE_ANSWER_ERROR_MAX_CHARS
    ? `${text.slice(0, SIDE_ANSWER_ERROR_MAX_CHARS - 1)}…`
    : text || "Couldn't answer this side question. Try again.";
}

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const answering = yield* FiberSet.make<void>();
  // A question is answered once even when it is both listed as an orphan and
  // delivered as an event.
  const handled = new Set<MessageId>();

  const complete = (
    question: OrchestrationV2SideMessage,
    answer: { readonly role: "assistant" | "error"; readonly text: string },
  ) =>
    engine
      .dispatch({
        type: "thread.side-answer.complete",
        commandId: CommandId.make(`server:side-answer:${question.id}`),
        threadId: question.threadId,
        sideThreadId: question.sideThreadId,
        questionId: question.id,
        messageId: MessageId.make(`side-answer:${question.id}`),
        ...answer,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("side answer could not be recorded", {
                threadId: question.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );

  const ask = Effect.fn("SideQuestionReactor.ask")(function* (
    question: OrchestrationV2SideMessage,
  ) {
    const records = yield* projections.getThreadRecords(question.threadId, [
      "providerThreads",
      "sideMessages",
    ]);
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === records.thread.activeProviderThreadId,
    );
    if (providerThread === undefined) {
      return yield* new SideAnswerUnavailable({
        text: "Send a message in this thread before asking a side question.",
      });
    }
    const runtime =
      providerThread.providerSessionId === null
        ? undefined
        : Option.getOrUndefined(yield* providerSessions.get(providerThread.providerSessionId));
    if (runtime === undefined) {
      return yield* new SideAnswerUnavailable({
        text: "The agent's session for this thread has ended. Side questions need a running session: send a message, then ask again.",
      });
    }
    if (runtime.askSideQuestion === undefined) {
      return yield* new SideAnswerUnavailable({
        text: "Side questions are not available for this provider.",
      });
    }
    return yield* runtime.askSideQuestion({
      providerThread,
      sideThreadId: question.sideThreadId,
      question: question.text,
      history: sideThreadHistory(records.sideMessages ?? [], question),
    });
  });

  const answer = (question: OrchestrationV2SideMessage) =>
    ask(question).pipe(
      Effect.timeoutOrElse({
        duration: SIDE_ANSWER_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new SideAnswerUnavailable({ text: "No answer within 5 minutes. Try again." }),
          ),
      }),
      Effect.map((text) => ({ role: "assistant" as const, text: text.trim() })),
      Effect.filterOrFail(
        (result) => result.text.length > 0,
        () => new SideAnswerUnavailable({ text: "The agent returned an empty answer." }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const error = Option.getOrUndefined(Cause.findErrorOption(cause));
        return (
          isSideAnswerUnavailable(error)
            ? Effect.void
            : Effect.logWarning("side question failed", {
                threadId: question.threadId,
                sideThreadId: question.sideThreadId,
                cause: Cause.pretty(cause),
              })
        ).pipe(Effect.as({ role: "error" as const, text: sideAnswerErrorText(error) }));
      }),
      Effect.flatMap((result) => complete(question, result)),
    );

  const claim = (question: OrchestrationV2SideMessage) => {
    if (question.role !== "user" || handled.has(question.id)) return false;
    handled.add(question.id);
    return true;
  };

  const start: SideQuestionReactor["Service"]["start"] = Effect.fn("SideQuestionReactor.start")(
    function* () {
      // Before activation no client can ask, so every waiting question is an
      // orphan: answers are never persisted mid-flight, and a question pending
      // when the server stopped would otherwise wait forever. Read the cursor
      // first so anything asked later arrives on the stream; `claim` drops repeats.
      const cursor = yield* eventSink.latestSequence();
      const orphans = (yield* projections.getUnansweredSideQuestions()).filter(claim);
      yield* forkParked(
        Effect.forEach(
          orphans,
          (question) => complete(question, { role: "error", text: SIDE_ANSWER_INTERRUPTED_TEXT }),
          { discard: true },
        ).pipe(
          Effect.andThen(
            eventSink
              .stream({ afterSequence: cursor, eventType: "side-message.updated" })
              .pipe(
                Stream.runForEach(({ event }) =>
                  event.type === "side-message.updated" && claim(event.payload)
                    ? FiberSet.run(answering, answer(event.payload)).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              ),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("side question stream failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      );
    },
    Effect.catch((cause) => Effect.logWarning("side question reactor could not start", { cause })),
  );

  return SideQuestionReactor.of({ start, drain: FiberSet.awaitEmpty(answering) });
});

export const layer = Layer.effect(SideQuestionReactor, make);
