import type { Session } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";

import { attachPreviewLoopbackRequestInterceptor } from "./LoopbackRequestInterceptor.ts";

describe("attachPreviewLoopbackRequestInterceptor", () => {
  it("ensures a related tunnel before a localhost iframe request continues", async () => {
    const ensureRelated = vi.fn(async () => undefined);
    const onBeforeRequest = vi.fn();
    const session = { webRequest: { onBeforeRequest } };
    attachPreviewLoopbackRequestInterceptor(session as unknown as Session, ensureRelated);
    attachPreviewLoopbackRequestInterceptor(session as unknown as Session, ensureRelated);
    expect(onBeforeRequest).toHaveBeenCalledTimes(1);
    const listener = onBeforeRequest.mock.calls[0]?.[1] as (
      details: { url: string },
      callback: (response: object) => void,
    ) => void;
    const callback = vi.fn();
    listener({ url: "http://localhost:5173/app" }, callback);
    await vi.waitFor(() => {
      expect(ensureRelated).toHaveBeenCalledWith("http://localhost:5173/app");
      expect(callback).toHaveBeenCalledWith({});
    });
  });
});
