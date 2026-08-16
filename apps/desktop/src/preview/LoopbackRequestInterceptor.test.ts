import type { Session } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";

import { attachPreviewLoopbackRequestInterceptor } from "./LoopbackRequestInterceptor.ts";

describe("attachPreviewLoopbackRequestInterceptor", () => {
  it("re-applies the preview-only PAC so popup windows cannot drop it", () => {
    const setProxy = vi.fn(async () => undefined);
    const session = { setProxy };
    attachPreviewLoopbackRequestInterceptor(session as unknown as Session, 43210);
    attachPreviewLoopbackRequestInterceptor(session as unknown as Session, 43210);
    expect(setProxy).toHaveBeenCalledTimes(2);
    const config = setProxy.mock.calls.at(0)?.at(0);
    expect(config).toEqual(
      expect.objectContaining({
        mode: "pac_script",
        pacScript: expect.stringContaining("data:application/x-ns-proxy-autoconfig;base64,"),
      }),
    );
  });
});
