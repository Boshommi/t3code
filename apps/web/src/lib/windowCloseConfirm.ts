import { useLayoutEffect } from "react";

export const WINDOW_CLOSE_CONFIRM_MS = 2000;

let rightPanelOpenCount = 0;

/** True when a mounted chat or pull-request view has a closeable right-panel tab. */
export function isWindowCloseRightPanelOpen(): boolean {
  return rightPanelOpenCount > 0;
}

/** Keep the window-close shortcut from stealing Cmd+W while a panel tab is open. */
export function useSyncWindowCloseRightPanelOpen(open: boolean): void {
  useLayoutEffect(() => {
    if (!open) return;
    rightPanelOpenCount += 1;
    return () => {
      rightPanelOpenCount -= 1;
    };
  }, [open]);
}

export function resolveWindowCloseConfirmAction(input: {
  readonly armedUntil: number | null;
  readonly now: number;
}): "confirm" | "close" {
  if (input.armedUntil !== null && input.now < input.armedUntil) {
    return "close";
  }
  return "confirm";
}
