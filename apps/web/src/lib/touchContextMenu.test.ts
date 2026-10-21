import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { LONG_PRESS_MS, installTouchContextMenu } from "./touchContextMenu";

class FakeMouseEvent {
  defaultPrevented = false;
  readonly isTrusted = false;
  constructor(
    readonly type: string,
    readonly init: { clientX: number; clientY: number },
  ) {}
  preventDefault() {
    this.defaultPrevented = true;
  }
}

type Listener = (event: unknown) => void;

function setup(options: { menuHandled: boolean }) {
  const listeners = new Map<string, Listener>();
  const doc = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const dispatched: FakeMouseEvent[] = [];
  const pressTarget = {
    dispatchEvent: (event: FakeMouseEvent) => {
      dispatched.push(event);
      if (options.menuHandled) event.preventDefault();
      return !event.defaultPrevented;
    },
  };
  const uninstall = installTouchContextMenu(doc as unknown as Document);
  const fire = (type: string, init: Record<string, unknown> = {}) => {
    const event = {
      pointerType: "touch",
      isPrimary: true,
      isTrusted: true,
      clientX: 0,
      clientY: 0,
      target: pressTarget,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.propagationStopped = true;
      },
      ...init,
    };
    listeners.get(type)?.(event);
    return event;
  };
  return { dispatched, fire, uninstall };
}

describe("installTouchContextMenu", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("MouseEvent", FakeMouseEvent);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the context menu at the press origin and swallows the trailing tap", () => {
    const { dispatched, fire } = setup({ menuHandled: true });
    fire("pointerdown", { clientX: 40, clientY: 80 });
    fire("pointermove", { clientX: 44, clientY: 82 });
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.type).toBe("contextmenu");
    expect(dispatched[0]?.init).toMatchObject({ clientX: 40, clientY: 80 });

    fire("pointerup");
    expect(fire("click").defaultPrevented).toBe(true);
    expect(fire("click").defaultPrevented).toBe(false);
  });

  it("leaves the tap alone when nothing handled the menu", () => {
    const { dispatched, fire } = setup({ menuHandled: false });
    fire("pointerdown");
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fire("pointerup");

    expect(dispatched).toHaveLength(1);
    expect(fire("click").defaultPrevented).toBe(false);
  });

  it("treats a moving finger as a scroll, not a long press", () => {
    const { dispatched, fire } = setup({ menuHandled: true });
    fire("pointerdown", { clientX: 0, clientY: 0 });
    fire("pointermove", { clientX: 0, clientY: 30 });
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(dispatched).toHaveLength(0);
  });

  it("ignores mouse presses", () => {
    const { dispatched, fire } = setup({ menuHandled: true });
    fire("pointerdown", { pointerType: "mouse" });
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(dispatched).toHaveLength(0);
  });

  it("defers to a native long-press menu and never opens two", () => {
    const early = setup({ menuHandled: true });
    early.fire("pointerdown");
    early.fire("contextmenu");
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(early.dispatched).toHaveLength(0);
    early.uninstall();

    const late = setup({ menuHandled: true });
    late.fire("pointerdown");
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const nativeAfter = late.fire("contextmenu");
    expect(late.dispatched).toHaveLength(1);
    expect(nativeAfter.defaultPrevented).toBe(true);
    expect(nativeAfter.propagationStopped).toBe(true);
  });
});
