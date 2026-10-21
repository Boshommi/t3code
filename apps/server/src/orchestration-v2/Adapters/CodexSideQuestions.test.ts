import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexError from "effect-codex-app-server/errors";

import { makeCodexSideQuestions } from "./CodexSideQuestions.ts";

type Handler = (payload: unknown) => Effect.Effect<void, CodexError.CodexAppServerError>;

/** Just enough of an app-server: forks and turns are recorded, notifications are pushed by the test. */
const makeFakeAppServer = Effect.gen(function* () {
  const handlers = new Map<string, Array<Handler>>();
  const requests: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];
  const turnStarts = yield* Queue.unbounded<{ readonly threadId: string; readonly text: string }>();
  let forks = 0;
  let turns = 0;
  const fake = {
    request: (method: string, params: Record<string, unknown>) =>
      Effect.gen(function* () {
        requests.push({ method, params });
        if (method === "thread/fork") return { thread: { id: `fork-${++forks}` } };
        if (method === "turn/start") {
          const input = params.input as ReadonlyArray<{ readonly text: string }>;
          yield* Queue.offer(turnStarts, {
            threadId: String(params.threadId),
            text: input[0]!.text,
          });
          return { turn: { id: `turn-${++turns}` } };
        }
        return {};
      }),
    handleServerNotification: (method: string, handler: Handler) =>
      Effect.sync(() => handlers.set(method, [...(handlers.get(method) ?? []), handler])),
    handleServerRequest: () => Effect.void,
  };
  const emit = (method: string, payload: unknown) =>
    Effect.forEach(handlers.get(method) ?? [], (handler) => Effect.ignore(handler(payload)), {
      discard: true,
    });
  const answerTurn = (threadId: string, text: string) =>
    emit("item/completed", {
      threadId,
      turnId: "turn",
      completedAtMs: 0,
      item: { type: "agentMessage", id: "item", text },
    }).pipe(
      Effect.andThen(
        emit("turn/completed", { threadId, turn: { id: "turn", status: "completed" } }),
      ),
    );
  return {
    client: fake as unknown as CodexClient.CodexAppServerClient["Service"],
    requests,
    turnStarts,
    emit,
    answerTurn,
  };
});

describe("Codex side questions", () => {
  it.effect("answers follow-ups in one read-only ephemeral fork per side thread", () =>
    Effect.gen(function* () {
      const appServer = yield* makeFakeAppServer;
      const sideQuestions = yield* makeCodexSideQuestions(appServer.client);
      const ask = (
        question: string,
        history: ReadonlyArray<{ question: string; answer: string }>,
      ) =>
        sideQuestions.askSideQuestion({
          nativeThreadId: "main-thread",
          sideThreadId: "side-1",
          question,
          history,
        });

      const first = yield* ask("Which file?", []).pipe(Effect.forkScoped);
      const firstTurn = yield* Queue.take(appServer.turnStarts);
      assert.deepEqual(firstTurn, { threadId: "fork-1", text: "Which file?" });
      yield* appServer.answerTurn("fork-1", "config.ts");
      assert.equal(yield* Fiber.join(first), "config.ts");

      const followUp = yield* ask("Why that one?", [
        { question: "Which file?", answer: "config.ts" },
      ]).pipe(Effect.forkScoped);
      // The fork already holds the earlier exchange, so only the question is sent.
      assert.deepEqual(yield* Queue.take(appServer.turnStarts), {
        threadId: "fork-1",
        text: "Why that one?",
      });
      yield* appServer.answerTurn("fork-1", "It loads first.");
      assert.equal(yield* Fiber.join(followUp), "It loads first.");

      const forkRequests = appServer.requests.filter((entry) => entry.method === "thread/fork");
      assert.equal(forkRequests.length, 1);
      assert.deepInclude(forkRequests[0]!.params, {
        threadId: "main-thread",
        ephemeral: true,
        excludeTurns: true,
        sandbox: "read-only",
        approvalPolicy: "never",
      });
    }),
  );

  it.effect("keeps fork traffic away from the main thread's handlers", () =>
    Effect.gen(function* () {
      const appServer = yield* makeFakeAppServer;
      const sideQuestions = yield* makeCodexSideQuestions(appServer.client);
      const seen: Array<string> = [];
      yield* sideQuestions.mainThreadClient.handleServerNotification("item/completed", (payload) =>
        Effect.sync(() => {
          seen.push(payload.threadId);
        }),
      );

      const answer = yield* sideQuestions
        .askSideQuestion({
          nativeThreadId: "main-thread",
          sideThreadId: "side-1",
          question: "Status?",
          history: [],
        })
        .pipe(Effect.forkScoped);
      yield* Queue.take(appServer.turnStarts);
      yield* appServer.answerTurn("fork-1", "Green.");
      yield* appServer.answerTurn("main-thread", "Main thread output.");
      assert.equal(yield* Fiber.join(answer), "Green.");
      assert.deepEqual(seen, ["main-thread"]);
    }),
  );

  it.effect("starts a fresh fork with the history after a failed answer", () =>
    Effect.gen(function* () {
      const appServer = yield* makeFakeAppServer;
      const sideQuestions = yield* makeCodexSideQuestions(appServer.client);
      const history = [{ question: "Which file?", answer: "config.ts" }];
      const ask = sideQuestions.askSideQuestion({
        nativeThreadId: "main-thread",
        sideThreadId: "side-1",
        question: "Why?",
        history,
      });

      const failed = yield* ask.pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.take(appServer.turnStarts);
      yield* appServer.emit("turn/completed", {
        threadId: "fork-1",
        turn: { id: "turn", status: "failed", error: { message: "Rate limited." } },
      });
      const error = yield* Fiber.join(failed);
      assert.equal(error.detail, "Rate limited.");

      const retried = yield* ask.pipe(Effect.forkScoped);
      const retryTurn = yield* Queue.take(appServer.turnStarts);
      assert.equal(retryTurn.threadId, "fork-2");
      assert.include(retryTurn.text, "Question: Which file?\n\nAnswer: config.ts");
      assert.include(retryTurn.text, "New question: Why?");
      yield* appServer.answerTurn("fork-2", "Because.");
      assert.equal(yield* Fiber.join(retried), "Because.");
    }),
  );

  it.effect("fails questions in flight when the session closes", () =>
    Effect.gen(function* () {
      const appServer = yield* makeFakeAppServer;
      const closed = yield* Deferred.make<unknown>();
      const session = Effect.scoped(
        Effect.gen(function* () {
          const sideQuestions = yield* makeCodexSideQuestions(appServer.client);
          yield* sideQuestions
            .askSideQuestion({
              nativeThreadId: "main-thread",
              sideThreadId: "side-1",
              question: "Status?",
              history: [],
            })
            .pipe(
              Effect.flip,
              Effect.flatMap((error) => Deferred.succeed(closed, error)),
              Effect.forkDetach,
            );
          yield* Queue.take(appServer.turnStarts);
        }),
      );
      yield* session;
      const error = yield* Deferred.await(closed);
      assert.propertyVal(error, "detail", "The Codex session closed.");
    }),
  );
});
