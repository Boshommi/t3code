import { assert, it } from "@effect/vitest";

import { museUsageToLimits, museUsageToUpdate, museUsageToWindows } from "./museUsageLimits.ts";

const observed = {
  observedAtMs: 1_789_621_482_379,
  tier: "27681631238169137",
  weekly: { resetsAtMs: 1_789_948_800_000, usedPercent: 12 },
  window: { resetsAtMs: 1_789_639_428_000, usedPercent: 137, windowDurationMins: 300 },
};

it("maps Muse's rolling window and weekly block onto session and weekly rows", () => {
  const windows = museUsageToWindows(observed);
  assert.deepEqual(
    windows.map((window) => [window.id, window.kind, window.label, window.usedPercent]),
    [
      ["window", "session", "Session", 100],
      ["weekly", "weekly", "Weekly", 12],
    ],
  );
  assert.equal(windows[0]?.windowDurationMins, 300);
  assert.equal(windows[0]?.resetsAt, "2026-09-17T10:03:48.000Z");
  assert.equal(windows[1]?.windowDurationMins, 7 * 24 * 60);
  assert.equal(windows[1]?.resetsAt, "2026-09-21T00:00:00.000Z");
});

it("treats a window longer than a week as weekly and skips halves without a percent", () => {
  const windows = museUsageToWindows({
    window: { usedPercent: 4, windowDurationMins: 30 * 24 * 60 },
    weekly: {},
  });
  assert.deepEqual(
    windows.map((window) => [window.id, window.kind]),
    [["window", "weekly"]],
  );
  assert.isUndefined(museUsageToUpdate({}));
  assert.deepEqual(
    museUsageToUpdate(observed)?.windows.map((window) => window.id),
    ["window", "weekly"],
  );
});

it("reports a host that has observed nothing as a failed probe so earlier bars survive", () => {
  const checkedAt = "2026-09-17T05:00:00.000Z";
  const empty = museUsageToLimits(undefined, checkedAt);
  assert.equal(empty.unavailable?.reason, "probeFailed");
  assert.deepEqual(empty.windows, []);
  const limits = museUsageToLimits(observed, checkedAt);
  assert.isUndefined(limits.unavailable);
  assert.equal(limits.checkedAt, checkedAt);
  assert.equal(limits.windows.length, 2);
});
