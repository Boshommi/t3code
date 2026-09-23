/**
 * SideQuestionReactor - answers side questions (`/btw`).
 *
 * Each question added to a side thread is answered by the thread's provider in
 * its own fiber, so a slow answer never holds up other questions or the event
 * stream. The answer, or a short user-facing error, lands through the internal
 * `thread.side-answer.complete` command.
 *
 * @module SideQuestionReactor
 */
import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationSideMessage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionThreadSideMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadSideMessages.ts";
import {
  type ProjectionThreadSideMessage,
  ProjectionThreadSideMessageRepository,
} from "../persistence/Services/ProjectionThreadSideMessages.ts";
import type { ProviderServiceError } from "../provider/Errors.ts";
import type { ProviderSideQuestionInput } from "../provider/Services/ProviderAdapter.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

export class SideQuestionReactor extends Context.Service<
  SideQuestionReactor,
  {
    /** Settles questions orphaned by a restart, then answers new ones. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves once no question is being answered. For tests. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/SideQuestionReactor") {}

export const SIDE_ANSWER_INTERRUPTED_TEXT = "Interrupted by a server restart. Ask again.";
const SIDE_ANSWER_FALLBACK_ERROR_TEXT = "Couldn't answer this side question. Try again.";
const SIDE_ANSWER_ERROR_MAX_CHARS = 500;

/**
 * The answered exchanges of `question`'s side thread that precede it, oldest
 * first. Failed answers are skipped: the provider never saw them.
 */
export function sideThreadHistory(
  messages: ReadonlyArray<
    Pick<ProjectionThreadSideMessage, "messageId" | "sideThreadId" | "role" | "text">
  >,
  question: Pick<OrchestrationSideMessage, "id" | "sideThreadId">,
): ProviderSideQuestionInput["history"] {
  const sideThread = messages.filter((message) => message.sideThreadId === question.sideThreadId);
  const questionIndex = sideThread.findIndex((message) => message.messageId === question.id);
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

/** A short message the user can act on; internals stay in the server log. */
function sideAnswerErrorText(error: ProviderServiceError | undefined): string {
  const text = (() => {
    switch (error?._tag) {
      case "ProviderValidationError":
        return error.operation === "ProviderService.askSideQuestion" ? error.issue : undefined;
      case "ProviderAdapterRequestError":
        return error.method === "side_question" ? error.detail : undefined;
      case "ProviderWorkspaceMissingError":
        return error.message;
      default:
        return undefined;
    }
  })()?.trim();
  if (!text) {
    return SIDE_ANSWER_FALLBACK_ERROR_TEXT;
  }
  return text.length > SIDE_ANSWER_ERROR_MAX_CHARS
    ? `${text.slice(0, SIDE_ANSWER_ERROR_MAX_CHARS - 1)}…`
    : text;
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const sideMessages = yield* ProjectionThreadSideMessageRepository;
  const crypto = yield* Crypto.Crypto;
  const answering = yield* FiberSet.make<void>();
  // Questions settled as orphans; a live event for one must not answer it too.
  const orphaned = new Set<string>();

  const complete = Effect.fn("SideQuestionReactor.complete")(function* (input: {
    readonly threadId: ThreadId;
    readonly sideThreadId: MessageId;
    readonly role: "assistant" | "error";
    readonly text: string;
  }) {
    const uuid = yield* crypto.randomUUIDv4;
    yield* engine.dispatch({
      type: "thread.side-answer.complete",
      commandId: CommandId.make(`server:side-answer:${uuid}`),
      threadId: input.threadId,
      sideThreadId: input.sideThreadId,
      messageId: MessageId.make(uuid),
      role: input.role,
      text: input.text,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  const answerQuestion = Effect.fn("SideQuestionReactor.answerQuestion")(
    function* (threadId: ThreadId, question: OrchestrationSideMessage) {
      const history = yield* sideMessages.listByThreadId({ threadId }).pipe(
        Effect.map((messages) => sideThreadHistory(messages, question)),
        Effect.catch((cause) =>
          Effect.logWarning("side question history unavailable", { threadId, cause }).pipe(
            Effect.as([]),
          ),
        ),
      );
      const answer = yield* providerService
        .askSideQuestion({
          threadId,
          sideThreadId: question.sideThreadId,
          question: question.text,
          history,
        })
        .pipe(
          Effect.map((text) => ({ role: "assistant" as const, text })),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("side question failed", {
                  threadId,
                  sideThreadId: question.sideThreadId,
                  cause: Cause.pretty(cause),
                }).pipe(
                  Effect.as({
                    role: "error" as const,
                    text: sideAnswerErrorText(Option.getOrUndefined(Cause.findErrorOption(cause))),
                  }),
                ),
          ),
        );
      yield* complete({ threadId, sideThreadId: question.sideThreadId, ...answer });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("side answer could not be recorded", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  // Answers are never persisted mid-flight, so questions that were pending
  // when the server stopped would otherwise wait forever.
  const settleOrphanedQuestions = (questions: ReadonlyArray<ProjectionThreadSideMessage>) =>
    Effect.forEach(
      questions,
      (question) =>
        complete({
          threadId: question.threadId,
          sideThreadId: question.sideThreadId,
          role: "error",
          text: SIDE_ANSWER_INTERRUPTED_TEXT,
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("orphaned side question could not be settled", {
                  threadId: question.threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { discard: true },
    );

  const processEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
    if (event.type !== "thread.side-message-added") {
      return Effect.void;
    }
    const { threadId, message } = event.payload;
    if (message.role !== "user" || orphaned.has(message.id)) {
      return Effect.void;
    }
    return FiberSet.run(answering, answerQuestion(threadId, message)).pipe(Effect.asVoid);
  };

  const start: SideQuestionReactor["Service"]["start"] = Effect.fn("SideQuestionReactor.start")(
    function* () {
      // Subscribe, then list orphans before activation lets clients ask:
      // every question is either listed here or arrives as an event.
      const events = yield* engine.subscribeDomainEvents;
      const orphans = yield* sideMessages
        .listUnansweredQuestions()
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("orphaned side questions could not be listed", { cause }).pipe(
              Effect.as([]),
            ),
          ),
        );
      for (const orphan of orphans) {
        orphaned.add(orphan.messageId);
      }
      yield* forkParked(
        settleOrphanedQuestions(orphans).pipe(
          Effect.andThen(Stream.runForEach(events, processEvent)),
        ),
      );
    },
  );

  return {
    start,
    drain: FiberSet.awaitEmpty(answering),
  } satisfies SideQuestionReactor["Service"];
});

export const layer = Layer.effect(SideQuestionReactor, make).pipe(
  Layer.provide(ProjectionThreadSideMessageRepositoryLive),
);
