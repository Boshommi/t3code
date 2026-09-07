import { describe, expect, it } from "vite-plus/test";

import { resolveWindowCloseConfirmAction, WINDOW_CLOSE_CONFIRM_MS } from "./windowCloseConfirm";

describe("resolveWindowCloseConfirmAction", () => {
  it("asks for a second press when the shortcut is not armed", () => {
    expect(resolveWindowCloseConfirmAction({ armedUntil: null, now: 1_000 })).toBe("confirm");
  });

  it("closes when the same shortcut is pressed again before the hint expires", () => {
    expect(
      resolveWindowCloseConfirmAction({
        armedUntil: 1_000 + WINDOW_CLOSE_CONFIRM_MS,
        now: 1_000 + WINDOW_CLOSE_CONFIRM_MS - 1,
      }),
    ).toBe("close");
  });

  it("asks again after the hint expires", () => {
    expect(
      resolveWindowCloseConfirmAction({
        armedUntil: 1_000 + WINDOW_CLOSE_CONFIRM_MS,
        now: 1_000 + WINDOW_CLOSE_CONFIRM_MS,
      }),
    ).toBe("confirm");
  });
});
