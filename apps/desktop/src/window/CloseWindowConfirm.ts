// @effect-diagnostics globalTimers:off -- Runs inside a native menu click; the hint timer lives outside any Effect runtime.

import type { QuitShortcutHintEvent } from "@t3tools/contracts";

export const CLOSE_WINDOW_CONFIRM_MS = 2000;

export interface CloseWindowShortcutOptions<W> {
  readonly notify: (window: W, event: QuitShortcutHintEvent) => void;
  readonly close: (window: W) => void;
}

/**
 * Cmd/Ctrl+W reaches the native Close Window item only when the renderer had
 * nothing (a terminal or right-panel tab) to close. The first press shows a
 * hint; a second press on the same window within CLOSE_WINDOW_CONFIRM_MS
 * closes it.
 */
export function makeCloseWindowShortcutHandler<W>(
  options: CloseWindowShortcutOptions<W>,
): (window: W) => void {
  let armed: { readonly window: W; readonly timer: ReturnType<typeof setTimeout> } | undefined;

  const disarm = () => {
    if (armed === undefined) return;
    const { window, timer } = armed;
    armed = undefined;
    clearTimeout(timer);
    options.notify(window, { state: "up" });
  };

  return (window) => {
    if (armed?.window === window) {
      disarm();
      options.close(window);
      return;
    }
    disarm();
    armed = { window, timer: setTimeout(disarm, CLOSE_WINDOW_CONFIRM_MS) };
    options.notify(window, { state: "down", mode: "close-window" });
  };
}
