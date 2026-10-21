import {
  type OrchestrationV2ThreadShell,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import * as PreviewManager from "../preview/Manager.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { threadHasQueuedTurnStart } from "./ThreadSettlementService.ts";

export const IDLE_RELEASE_AFTER_MS = 5 * 60 * 1_000;

/**
 * Whether a thread has gone quiet: nothing runs, waits on the user, or is
 * queued, and nothing about it changed since `cutoffMs`.
 */
export function isThreadIdle(
  thread: OrchestrationV2ThreadShell,
  nowMs: number,
  cutoffMs: number,
): boolean {
  if (thread.activeRunId !== null || thread.activityRunStatus != null) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  if ((thread.pendingBackgroundTasks ?? []).length > 0) return false;
  if (threadHasQueuedTurnStart(thread, nowMs)) return false;
  return [
    thread.updatedAt,
    thread.latestUserMessageAt,
    thread.latestRunRequestedAt,
    thread.latestRunStartedAt,
    thread.latestRunCompletedAt,
    thread.lastVisitedAt,
  ].every((value) => value == null || DateTime.toEpochMillis(value) <= cutoffMs);
}

/**
 * Every minute, releases the shells and desktop browser tabs of threads that
 * went quiet more than five minutes ago. A shell running a command stays, and
 * a closed shell keeps its history for the next open. Settled threads release
 * everything at once in ThreadSettlementService.
 *
 * Server-hosted tabs are left to ServerBrowser, which closes idle agent tabs
 * itself and can tell whether anyone is watching. Desktop tabs are Electron
 * guests the server cannot see into, so closing the session is the release:
 * the desktop host drops the webview when the `closed` event arrives.
 */
export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const terminals = yield* TerminalManager.TerminalManager;
  const previews = yield* PreviewManager.PreviewManager;

  const releaseThread = Effect.fn("IdleResourceReleaseService.releaseThread")(
    function* (
      threadId: ThreadId,
      tabs: ReadonlyArray<PreviewSessionSnapshot>,
      nowMs: number,
      cutoffMs: number,
    ) {
      const thread = yield* projections.getThreadShell(threadId);
      if (thread === null || !isThreadIdle(thread, nowMs, cutoffMs)) return;
      yield* terminals.closeIdle({ threadId, idleSinceMs: cutoffMs });
      yield* Effect.forEach(tabs, (tab) => previews.close({ threadId, tabId: tab.tabId }), {
        discard: true,
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("releasing idle thread resources failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  /** One pass. It reads only threads that hold a stale resource, so its cost follows those. */
  const sweep = Effect.fn("IdleResourceReleaseService.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const cutoffMs = nowMs - IDLE_RELEASE_AFTER_MS;
    const staleTabs = (yield* previews.listAll).filter(
      (tab) => tab.runtime !== "server" && Date.parse(tab.updatedAt) <= cutoffMs,
    );
    const tabsByThread = Map.groupBy(staleTabs, (tab) => tab.threadId);
    const threadIds = new Set<string>(tabsByThread.keys());
    for (const terminal of yield* terminals.list()) {
      if (
        terminal.status === "running" &&
        !terminal.hasRunningSubprocess &&
        Date.parse(terminal.updatedAt) <= cutoffMs
      ) {
        threadIds.add(terminal.threadId);
      }
    }
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        releaseThread(ThreadId.make(threadId), tabsByThread.get(threadId) ?? [], nowMs, cutoffMs),
      { concurrency: 4, discard: true },
    );
  });

  const start = Effect.fn("IdleResourceReleaseService.start")(function* () {
    yield* forkParked(sweep().pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));
  });

  return { start, sweep };
});
