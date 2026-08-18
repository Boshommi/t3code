import { describe, expect, it, vi } from "vite-plus/test";

import {
  dispatchPreviewGuestPointer,
  subscribePreviewGuestPointer,
} from "./previewGuestPointerBus";

describe("previewGuestPointerBus", () => {
  it("notifies subscribers and lets them unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePreviewGuestPointer(listener);
    dispatchPreviewGuestPointer();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    dispatchPreviewGuestPointer();
    expect(listener).toHaveBeenCalledOnce();
  });
});
