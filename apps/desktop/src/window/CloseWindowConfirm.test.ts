import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuitShortcutHintEvent } from "@t3tools/contracts";

import { CLOSE_WINDOW_CONFIRM_MS, makeCloseWindowShortcutHandler } from "./CloseWindowConfirm.ts";

const DOWN = { state: "down", mode: "close-window" } as const;
const UP = { state: "up" } as const;

function makeHarness() {
  const hints: Array<[string, QuitShortcutHintEvent]> = [];
  const closed: string[] = [];
  const press = makeCloseWindowShortcutHandler<string>({
    notify: (window, hint) => hints.push([window, hint]),
    close: (window) => closed.push(window),
  });
  return { hints, closed, press };
}

describe("makeCloseWindowShortcutHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for a second press before closing", () => {
    const { hints, closed, press } = makeHarness();

    press("main");
    expect(closed).toEqual([]);
    expect(hints).toEqual([["main", DOWN]]);

    vi.advanceTimersByTime(CLOSE_WINDOW_CONFIRM_MS - 1);
    press("main");
    expect(closed).toEqual(["main"]);
    expect(hints).toEqual([
      ["main", DOWN],
      ["main", UP],
    ]);
  });

  it("hides the hint and asks again once the window expires", () => {
    const { hints, closed, press } = makeHarness();

    press("main");
    vi.advanceTimersByTime(CLOSE_WINDOW_CONFIRM_MS);
    expect(hints).toEqual([
      ["main", DOWN],
      ["main", UP],
    ]);

    press("main");
    expect(closed).toEqual([]);
    expect(hints.at(-1)).toEqual(["main", DOWN]);
  });

  it("does not let a press on another window confirm the first", () => {
    const { hints, closed, press } = makeHarness();

    press("main");
    press("other");
    expect(closed).toEqual([]);
    expect(hints).toEqual([
      ["main", DOWN],
      ["main", UP],
      ["other", DOWN],
    ]);
  });
});
