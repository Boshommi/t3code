import type { QuitShortcutHintEvent } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { isMacPlatform } from "../lib/utils";

const HOLD_HINT_LINGER_MS = 1200;

type HintMode = Extract<QuitShortcutHintEvent, { state: "down" }>["mode"];

/** Shows the desktop's Cmd/Ctrl+Q quit and Cmd/Ctrl+W close-window confirmation hints. */
export function QuitHoldOverlay() {
  const [visibleMode, setVisibleMode] = useState<HintMode | null>(null);

  useEffect(() => {
    const subscribe = window.desktopBridge?.onQuitShortcut;
    if (!subscribe) return;
    let hideTimer: number | undefined;
    let pressedMode: HintMode = "hold";
    const unsubscribe = subscribe((hint) => {
      window.clearTimeout(hideTimer);
      if (hint.state === "down") {
        pressedMode = hint.mode;
        setVisibleMode(hint.mode);
        return;
      }
      if (pressedMode !== "hold") {
        setVisibleMode(null);
        return;
      }
      hideTimer = window.setTimeout(() => setVisibleMode(null), HOLD_HINT_LINGER_MS);
    });
    return () => {
      window.clearTimeout(hideTimer);
      unsubscribe();
    };
  }, []);

  if (!visibleMode) return null;
  const mac = isMacPlatform(navigator.platform);
  const quitShortcut = mac ? "⌘Q" : "Ctrl+Q";
  const message =
    visibleMode === "close-window"
      ? `Press ${mac ? "⌘W" : "Ctrl+W"} again to close`
      : visibleMode === "hold"
        ? `Hold ${quitShortcut} or press twice to quit`
        : `Press ${quitShortcut} again to quit`;
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-[22%] z-100 flex justify-center"
    >
      <div className="rounded-full bg-foreground/95 px-8 py-4 text-2xl font-bold text-background shadow-xl">
        {message}
      </div>
    </div>
  );
}
