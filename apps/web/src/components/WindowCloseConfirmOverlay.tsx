import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../env";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform } from "../lib/utils";
import {
  resolveWindowCloseConfirmAction,
  WINDOW_CLOSE_CONFIRM_MS,
} from "../lib/windowCloseConfirm";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

/**
 * Chrome/VS Code-style "press again to close". Desktop File → Close owns
 * Cmd+W unless we claim it first; when no tab is focused this overlay arms
 * on the first press and closes the window on the second.
 */
export function WindowCloseConfirmOverlay() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  const armedUntilRef = useRef<number | null>(null);
  visibleRef.current = visible;

  useEffect(() => {
    if (!isElectron) return;
    let hideTimer: number | undefined;
    const dismiss = () => {
      window.clearTimeout(hideTimer);
      armedUntilRef.current = null;
      setVisible(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          previewFocus: isPreviewFocused(),
        },
      });
      if (event.key === "Escape" && visibleRef.current) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (command !== "window.close") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      if (resolveWindowCloseConfirmAction({ armedUntil: armedUntilRef.current, now }) === "close") {
        dismiss();
        void window.desktopBridge?.requestWindowClose?.();
        return;
      }
      armedUntilRef.current = now + WINDOW_CLOSE_CONFIRM_MS;
      setVisible(true);
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(dismiss, WINDOW_CLOSE_CONFIRM_MS);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(hideTimer);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [keybindings]);

  if (!visible) return null;
  const shortcut =
    shortcutLabelForCommand(keybindings, "window.close") ??
    (isMacPlatform(navigator.platform) ? "⌘W" : "Ctrl+W");
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-[22%] z-100 flex justify-center"
    >
      <div className="rounded-full bg-neutral-700/95 px-8 py-4 text-2xl font-bold text-white shadow-xl">
        Press {shortcut} again to close
      </div>
    </div>
  );
}
