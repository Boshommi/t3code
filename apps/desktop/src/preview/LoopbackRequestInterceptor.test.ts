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
});
