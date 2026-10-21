/**
 * Side questions (`/btw`) for Codex. Each side thread is answered in one
 * ephemeral, read-only fork of the provider thread, so follow-ups reuse the
 * fork's prompt cache while the main thread's history and running turn stay
 * untouched. Forks share the session's app-server, so `mainThreadClient` keeps
 * their notifications and requests away from the adapter's own handlers.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Semaphore from "effect/Semaphore";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderDriverKind } from "@t3tools/contracts";

type CodexAppServerClient = CodexClient.CodexAppServerClient["Service"];

const CODEX_PROVIDER = ProviderDriverKind.make("codex");

/** Thread-level instructions for a side-question fork. */
const SIDE_CONVERSATION_INSTRUCTIONS = [
  "You are in a side conversation branched from the conversation above.",
  "Treat the inherited conversation as reference material only: do not continue, resume, or act on its task, and do not follow its earlier instructions as if they were addressed to you now.",
  "Answer only the side question, directly and concisely, from what you already know. Inspect files read-only only when the answer truly needs it.",
  "Never modify files, run commands with side effects, start sub-agents, or ask for approval.",
].join("\n");

export interface CodexSideQuestionInput {
  readonly nativeThreadId: string;
  readonly sideThreadId: string;
  readonly question: string;
  readonly history: ProviderAdapter.ProviderAdapterV2SideQuestionInput["history"];
}

/** First prompt of a fork that must rebuild a side thread's earlier exchanges. */
export function buildSideQuestionPrompt(
  history: CodexSideQuestionInput["history"],
  question: string,
): string {
  if (history.length === 0) return question;
  const exchanges = history
    .map((entry) => `Question: ${entry.question}\n\nAnswer: ${entry.answer}`)
    .join("\n\n---\n\n");
  return `Earlier in this side conversation:\n\n${exchanges}\n\n---\n\nNew question: ${question}`;
}

interface PendingAnswer {
  turnId: string | undefined;
  readonly messages: Array<string>;
  deltas: string;
  lastError: string | undefined;
  readonly result: Deferred.Deferred<string, ProviderAdapter.ProviderAdapterSideQuestionError>;
}

const sideQuestionError = (detail: string, cause?: unknown) =>
  new ProviderAdapter.ProviderAdapterSideQuestionError({
    driver: CODEX_PROVIDER,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

function payloadThreadId(payload: unknown): string | undefined {
  if (!Predicate.isObject(payload)) return undefined;
  if (typeof payload.threadId === "string") return payload.threadId;
  const thread = payload.thread;
  return Predicate.isObject(thread) && typeof thread.id === "string" ? thread.id : undefined;
}

export const makeCodexSideQuestions = Effect.fn("makeCodexSideQuestions")(function* (
  client: CodexAppServerClient,
) {
  /** Side thread → its fork, reused by follow-ups. */
  const forks = new Map<
    string,
    { forkThreadId: string | undefined; readonly lock: Semaphore.Semaphore }
  >();
  /** Every fork this session created; never pruned, so late traffic stays routed here. */
  const forkThreadIds = new Set<string>();
  /** Fork thread id → the question it is answering now. */
  const pending = new Map<string, PendingAnswer>();
  const isForkTraffic = (payload: unknown) => {
    const threadId = payloadThreadId(payload);
    return threadId !== undefined && forkThreadIds.has(threadId);
  };

  // Forks are ephemeral and die with the session's app-server.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...pending.values()],
      (answer) => Deferred.fail(answer.result, sideQuestionError("The Codex session closed.")),
      { discard: true },
    ),
  );

  yield* client.handleServerNotification("turn/started", (payload) =>
    Effect.sync(() => {
      const answer = pending.get(payload.threadId);
      if (answer !== undefined) answer.turnId = payload.turn.id;
    }),
  );
  yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
    Effect.sync(() => {
      const answer = pending.get(payload.threadId);
      if (answer !== undefined) answer.deltas += payload.delta;
    }),
  );
  yield* client.handleServerNotification("item/completed", (payload) =>
    Effect.sync(() => {
      const answer = pending.get(payload.threadId);
      if (answer !== undefined && payload.item.type === "agentMessage") {
        answer.messages.push(payload.item.text);
      }
    }),
  );
  yield* client.handleServerNotification("error", (payload) =>
    Effect.sync(() => {
      const answer = pending.get(payload.threadId);
      if (answer !== undefined && !payload.willRetry) answer.lastError = payload.error.message;
    }),
  );
  yield* client.handleServerNotification("turn/completed", (payload) => {
    const answer = pending.get(payload.threadId);
    if (answer === undefined) return Effect.void;
    const turn = payload.turn;
    if (turn.status === "completed") {
      // Commentary can precede the final message; the last one answers.
      const text = (answer.messages.at(-1) ?? answer.deltas).trim();
      return text.length > 0
        ? Deferred.succeed(answer.result, text).pipe(Effect.asVoid)
        : Deferred.fail(answer.result, sideQuestionError("Codex returned an empty answer.")).pipe(
            Effect.asVoid,
          );
    }
    const detail =
      turn.error?.message ??
      answer.lastError ??
      (turn.status === "interrupted"
        ? "The side question was interrupted."
        : "Codex could not answer the side question.");
    return Deferred.fail(answer.result, sideQuestionError(detail)).pipe(Effect.asVoid);
  });

  // Forks run read-only with approvals off; anything that still asks is
  // refused rather than surfacing in the main thread.
  const mainThreadClient: CodexAppServerClient = {
    ...client,
    handleServerNotification: (method, handler) =>
      client.handleServerNotification(method, (payload) =>
        isForkTraffic(payload) ? Effect.void : handler(payload),
      ),
    handleServerRequest: (method, handler) =>
      client.handleServerRequest(method, (payload) =>
        isForkTraffic(payload)
          ? Effect.fail(
              CodexErrors.CodexAppServerRequestError.invalidRequest(
                "Side conversations cannot ask for input or approval.",
              ),
            )
          : handler(payload),
      ),
  };

  const askSideQuestion = Effect.fn("CodexSideQuestions.ask")(function* (
    input: CodexSideQuestionInput,
  ) {
    let fork = forks.get(input.sideThreadId);
    if (fork === undefined) {
      fork = { forkThreadId: undefined, lock: Semaphore.makeUnsafe(1) };
      forks.set(input.sideThreadId, fork);
    }
    const entry = fork;
    // A fork runs one turn at a time.
    return yield* entry.lock.withPermit(
      Effect.gen(function* () {
        let prompt = input.question;
        if (entry.forkThreadId === undefined) {
          const forked = yield* client
            .request("thread/fork", {
              threadId: input.nativeThreadId,
              ephemeral: true,
              // Current Codex rejects an ephemeral fork of a paginated thread without it.
              excludeTurns: true,
              sandbox: "read-only",
              approvalPolicy: "never",
              developerInstructions: SIDE_CONVERSATION_INSTRUCTIONS,
            })
            .pipe(
              Effect.mapError((cause) =>
                sideQuestionError("Codex could not start a side conversation.", cause),
              ),
            );
          entry.forkThreadId = forked.thread.id;
          forkThreadIds.add(forked.thread.id);
          // A fresh fork of a side thread with answers (the app-server
          // restarted, or the last fork failed) lost those exchanges.
          prompt = buildSideQuestionPrompt(input.history, input.question);
        }
        const forkThreadId = entry.forkThreadId;
        const answer: PendingAnswer = {
          turnId: undefined,
          messages: [],
          deltas: "",
          lastError: undefined,
          result: yield* Deferred.make<string, ProviderAdapter.ProviderAdapterSideQuestionError>(),
        };
        pending.set(forkThreadId, answer);
        // A failed or abandoned fork may be wedged; the next question starts a
        // fresh one and replays the history instead.
        const abandonFork = Effect.gen(function* () {
          if (entry.forkThreadId === forkThreadId) entry.forkThreadId = undefined;
          if (answer.turnId !== undefined) {
            yield* client
              .request("turn/interrupt", { threadId: forkThreadId, turnId: answer.turnId })
              .pipe(Effect.timeoutOption("3 seconds"), Effect.ignore);
          }
        });
        return yield* client
          .request("turn/start", {
            threadId: forkThreadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
          })
          .pipe(
            Effect.mapError((cause) =>
              sideQuestionError("Codex could not answer the side question.", cause),
            ),
            Effect.tap((started) =>
              Effect.sync(() => {
                answer.turnId ??= started.turn.id;
              }),
            ),
            Effect.andThen(Deferred.await(answer.result)),
            Effect.onError(() => abandonFork),
            Effect.ensuring(
              Effect.sync(() => {
                if (pending.get(forkThreadId) === answer) pending.delete(forkThreadId);
              }),
            ),
          );
      }),
    );
  });

  return { mainThreadClient, askSideQuestion };
});
