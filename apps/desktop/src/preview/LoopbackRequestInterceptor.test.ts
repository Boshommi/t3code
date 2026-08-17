import type { Session } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  attachPreviewLoopbackRequestInterceptor,
  previewLoopbackProxyRules,
} from "./LoopbackRequestInterceptor.ts";

describe("attachPreviewLoopbackRequestInterceptor", () => {
  it("forces localhost through the preview proxy", () => {
    const setProxy = vi.fn(async () => undefined);
    const session = { setProxy };
    attachPreviewLoopbackRequestInterceptor(session as unknown as Session, 43210);
    expect(setProxy).toHaveBeenCalledTimes(1);
    expect(setProxy.mock.calls.at(0)?.at(0)).toEqual({
      mode: "fixed_servers",
      proxyRules: previewLoopbackProxyRules(43210),
      proxyBypassRules: "<-loopback>",
    });
  });

  // An http= rule makes Chromium write absolute-form request lines, which Next
  // answers with a 308 back to the same URL. SOCKS5 keeps it origin-form.
  it("asks Chromium for a SOCKS5 circuit, not an HTTP forward proxy", () => {
    expect(previewLoopbackProxyRules(43210)).toBe("socks5://127.0.0.1:43210");
  });
});
