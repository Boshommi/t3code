/**
 * Muse Code subscription usage. The host reports one rolling window (five
 * hours today) plus a weekly block, as `usage/read` during the status probe
 * and as `usage/changed` after each model reply; both carry the same shape,
 * so one mapper serves both and the rows merge by id.
 *
 * @module provider/Layers/museUsageLimits
 */
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { MspSubscriptionUsage } from "../msp/MspProtocol.ts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const WEEK_MINS = 7 * 24 * 60;

function isoFromEpochMillis(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isPercent(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function museUsageToWindows(
  usage: MspSubscriptionUsage,
): ReadonlyArray<ServerProviderUsageWindow> {
  const windows: ServerProviderUsageWindow[] = [];
  const window = usage.window;
  if (window && isPercent(window.usedPercent)) {
    const mins =
      typeof window.windowDurationMins === "number" && window.windowDurationMins > 0
        ? Math.round(window.windowDurationMins)
        : undefined;
    const kind = mins !== undefined && mins >= WEEK_MINS ? "weekly" : "session";
    const resetsAt = isoFromEpochMillis(window.resetsAtMs);
    windows.push({
      id: "window",
      kind,
      label: kind === "session" ? "Session" : "Weekly",
      usedPercent: clampPercent(window.usedPercent),
      ...(mins !== undefined ? { windowDurationMins: mins } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const weekly = usage.weekly;
  if (weekly && isPercent(weekly.usedPercent)) {
    const resetsAt = isoFromEpochMillis(weekly.resetsAtMs);
    windows.push({
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: clampPercent(weekly.usedPercent),
      windowDurationMins: WEEK_MINS,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

/** The mid-turn update; `undefined` when the frame carried nothing usable. */
export function museUsageToUpdate(
  usage: MspSubscriptionUsage,
): ProviderUsageLimitsUpdate | undefined {
  const windows = museUsageToWindows(usage);
  return windows.length > 0 ? { windows } : undefined;
}

/**
 * The status-probe read. A fresh host has observed nothing yet (Muse only
 * learns usage from provider frames), which is reported as a failed probe so
 * bars a previous turn established survive the next probe.
 */
export function museUsageToLimits(
  usage: MspSubscriptionUsage | undefined,
  checkedAt: string,
): ServerProviderUsageLimits {
  const windows = usage ? museUsageToWindows(usage) : [];
  if (windows.length > 0) {
    return makeUsageLimits({ checkedAt, windows });
  }
  return makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Muse Code reports usage after its first reply.",
  });
}
