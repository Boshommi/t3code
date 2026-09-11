import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";

export const IDLE_SUSPENSION_THRESHOLD_MS = 5 * 60 * 1_000;

function latestActivityMs(thread: OrchestrationThreadShell): number {
  const candidates = [
    thread.createdAt,
    thread.updatedAt,
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
    thread.session?.updatedAt,
  ];
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of candidates) {
    if (value == null) continue;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed) && parsed > latest) latest = parsed;
  }
  return latest;
}

/** Threads whose browser tabs and idle shells may be suspended to save resources. */
export function isIdleSuspensionCandidate(thread: OrchestrationThreadShell, now: string): boolean {
  if (thread.archivedAt !== null) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (thread.session?.activeTurnId != null) return false;
  if (thread.backgroundLiveness != null) return false;
  if (threadHasQueuedTurnStart(thread, now)) return false;
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) return false;
  return nowMs - latestActivityMs(thread) > IDLE_SUSPENSION_THRESHOLD_MS;
}
