// iOS and iPadOS Safari never turn a long press into a `contextmenu` event, so
// every right-click menu in the app is unreachable there. Installing this once
// synthesizes one after a still long press, which lets each `onContextMenu`
// handler serve touch without knowing about it. Android fires its own event;
// whichever arrives first for a press wins and the other is dropped.
export const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
// A click can trail the lifted finger by a frame or two; any later click is a
// new interaction and must go through.
const CLICK_SUPPRESS_MS = 400;

export function installTouchContextMenu(target: Document = document): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let synthesized = false;
  let nativeFired = false;
  let suppressClickUntil = 0;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    start = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    cancel();
    synthesized = false;
    nativeFired = false;
    suppressClickUntil = 0;
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    const pressTarget = event.target;
    if (!pressTarget) return;
    const origin = { x: event.clientX, y: event.clientY };
    start = origin;
    timer = setTimeout(() => {
      timer = null;
      start = null;
      if (nativeFired) return;
      synthesized = true;
      const menuEvent = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: origin.x,
        clientY: origin.y,
      });
      pressTarget.dispatchEvent(menuEvent);
      // Only a press that opened a menu is consumed; otherwise the tap stands.
      if (menuEvent.defaultPrevented) suppressClickUntil = Number.POSITIVE_INFINITY;
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!start || event.pointerType !== "touch") return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel();
  };

  const onPointerUp = () => {
    cancel();
    if (suppressClickUntil === Number.POSITIVE_INFINITY) {
      suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
    }
  };

  const onContextMenu = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if (synthesized) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    nativeFired = true;
    cancel();
  };

  const onClick = (event: MouseEvent) => {
    if (Date.now() > suppressClickUntil) return;
    suppressClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  const capture = { capture: true } as const;
  const passiveCapture = { capture: true, passive: true } as const;
  target.addEventListener("pointerdown", onPointerDown, passiveCapture);
  target.addEventListener("pointermove", onPointerMove, passiveCapture);
  target.addEventListener("pointerup", onPointerUp, passiveCapture);
  target.addEventListener("pointercancel", cancel, passiveCapture);
  target.addEventListener("contextmenu", onContextMenu, capture);
  target.addEventListener("click", onClick, capture);
  return () => {
    cancel();
    target.removeEventListener("pointerdown", onPointerDown, passiveCapture);
    target.removeEventListener("pointermove", onPointerMove, passiveCapture);
    target.removeEventListener("pointerup", onPointerUp, passiveCapture);
    target.removeEventListener("pointercancel", cancel, passiveCapture);
    target.removeEventListener("contextmenu", onContextMenu, capture);
    target.removeEventListener("click", onClick, capture);
  };
}
