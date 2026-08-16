import { describe, expect, it } from "vite-plus/test";

import {
  decidePreviewWindowOpen,
  DEFAULT_PREVIEW_POPUP_HEIGHT,
  DEFAULT_PREVIEW_POPUP_WIDTH,
  isAboutBlankUrl,
  parsePopupFeatureSize,
  previewPopupBrowserWindowOptions,
} from "./PreviewWindowOpen.ts";

describe("parsePopupFeatureSize", () => {
  it("reads width and height from a Google/OAuth feature string", () => {
    expect(parsePopupFeatureSize("popup,width=420,height=720", "width")).toBe(420);
    expect(parsePopupFeatureSize("popup,width=420,height=720", "height")).toBe(720);
  });

  it("rejects missing or out-of-range sizes", () => {
    expect(parsePopupFeatureSize("popup", "width")).toBeNull();
    expect(parsePopupFeatureSize("width=20", "width")).toBeNull();
    expect(parsePopupFeatureSize(undefined, "width")).toBeNull();
  });
});

describe("decidePreviewWindowOpen", () => {
  it("allows the Click Google handoff popup instead of same-tab navigation", () => {
    expect(
      decidePreviewWindowOpen({
        url: "http://localhost:5173/auth?provider=google",
        disposition: "new-window",
        features: "popup,width=420,height=720",
      }),
    ).toEqual({ kind: "allow-popup", width: 420, height: 720 });
  });

  it("allows about:blank OAuth bootstrap popups", () => {
    expect(
      decidePreviewWindowOpen({
        url: "about:blank",
        disposition: "new-window",
        features: "width=500,height=600",
      }),
    ).toEqual({ kind: "allow-popup", width: 500, height: 600 });
    expect(isAboutBlankUrl("about:blank#")).toBe(true);
  });

  it("allows accounts.google.com even when Chromium reports a tab disposition", () => {
    expect(
      decidePreviewWindowOpen({
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=1",
        disposition: "foreground-tab",
      }),
    ).toEqual({
      kind: "allow-popup",
      width: DEFAULT_PREVIEW_POPUP_WIDTH,
      height: DEFAULT_PREVIEW_POPUP_HEIGHT,
    });
  });

  it("keeps ordinary target=_blank links in the same preview tab", () => {
    expect(
      decidePreviewWindowOpen({
        url: "https://docs.example.com/guide",
        disposition: "foreground-tab",
      }),
    ).toEqual({
      kind: "navigate-same-tab",
      url: "https://docs.example.com/guide",
    });
  });

  it("denies non-web popup schemes", () => {
    expect(
      decidePreviewWindowOpen({
        url: "javascript:alert(1)",
        disposition: "new-window",
      }),
    ).toEqual({ kind: "deny" });
    expect(decidePreviewWindowOpen({ url: "   " })).toEqual({ kind: "deny" });
  });
});

describe("previewPopupBrowserWindowOptions", () => {
  it("keeps the preview partition and strips the guest preload", () => {
    expect(
      previewPopupBrowserWindowOptions({
        width: 420,
        height: 720,
        partition: "persist:t3code-preview-abc",
      }),
    ).toEqual({
      width: 420,
      height: 720,
      autoHideMenuBar: true,
      webPreferences: {
        partition: "persist:t3code-preview-abc",
        preload: "",
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
      },
    });
  });
});
