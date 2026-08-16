import { describe, expect, it } from "vite-plus/test";

import { rewritePreviewSecChUa } from "./previewClientHints.ts";

describe("rewritePreviewSecChUa", () => {
  it("replaces the Electron brand so Google Identity does not treat the guest as a webview", () => {
    expect(
      rewritePreviewSecChUa(`"Chromium";v="142", "Not A(Brand";v="24", "Electron";v="41"`),
    ).toBe(`"Chromium";v="142", "Not A(Brand";v="24", "Google Chrome";v="142"`);
  });

  it("leaves a Chrome-like hint unchanged", () => {
    const chrome = `"Google Chrome";v="142", "Chromium";v="142", "Not A(Brand";v="24"`;
    expect(rewritePreviewSecChUa(chrome)).toBe(chrome);
  });
});
