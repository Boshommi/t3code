import type { TerminalSummary, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as PreviewManager from "../preview/Manager.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { isIdleSuspensionCandidate } from "./ThreadIdleSuspensionPolicy.ts";

export class ThreadIdleSuspensionReactor extends Context.Service<
  ThreadIdleSuspensionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly suspendOnce: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadIdleSuspensionReactor") {}

export const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminals = yield* TerminalManager.TerminalManager;
  const previews = yield* PreviewManager.PreviewManager;

  const suspendTerminal = Effect.fn("ThreadIdleSuspensionReactor.suspendTerminal")(
    function* (summary: TerminalSummary) {
      yield* terminals.close({ threadId: summary.threadId, terminalId: summary.terminalId });
    },
    (effect, summary) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("idle terminal suspension skipped", {
                threadId: summary.threadId,
                terminalId: summary.terminalId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const suspendThread = Effect.fn("ThreadIdleSuspensionReactor.suspendThread")(
    function* (threadId: ThreadId, summaries: ReadonlyArray<TerminalSummary>) {
      const idleTerminals = summaries.filter(
        (summary) =>
          summary.threadId === threadId &&
          summary.status === "running" &&
          !summary.hasRunningSubprocess,
      );
      yield* Effect.forEach(idleTerminals, suspendTerminal, { discard: true });
      const sessions = yield* previews.list({ threadId });
      if (sessions.sessions.length > 0) {
        yield* previews.close({ threadId });
      }
      if (idleTerminals.length > 0 || sessions.sessions.length > 0) {
        yield* Effect.logInfo("suspended idle thread resources", {
          threadId,
          terminals: idleTerminals.length,
          previews: sessions.sessions.length,
        });
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("idle thread suspension skipped", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const sweep = Effect.fn("ThreadIdleSuspensionReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const candidates = snapshot.threads.filter((thread) => isIdleSuspensionCandidate(thread, now));
    if (candidates.length === 0) return;
    const summaries = yield* terminals.list();
    yield* Effect.forEach(candidates, (thread) => suspendThread(thread.id, summaries), {
      concurrency: 8,
      discard: true,
    });
  });

  const suspendOnce = sweep().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("idle thread suspension sweep failed", {
            cause: Cause.pretty(cause),
          }),
    ),
  );
  const worker = yield* makeDrainableWorker(() => suspendOnce);

  const start: ThreadIdleSuspensionReactor["Service"]["start"] = Effect.fn(
    "ThreadIdleSuspensionReactor.start",
  )(function* () {
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });

  return {
    start,
    drain: worker.drain,
    suspendOnce,
  } satisfies ThreadIdleSuspensionReactor["Service"];
});

export const layer = Layer.effect(ThreadIdleSuspensionReactor, make);
