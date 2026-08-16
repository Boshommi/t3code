/**
 * Decides how the in-app preview browser should handle `window.open`.
 *
 * Electron-free so the policy is unit-testable without importing Manager.
 *
 * Sites (Google Identity, OAuth handoffs) call `window.open` with popup
 * features. Loading that URL in the same tab returns `null` to the page and
 * breaks opener-based auth.
 */

export type PreviewWindowOpenInput = {
  readonly url: string;
  readonly disposition?: string;
  readonly features?: string;
};

export type PreviewWindowOpenDecision =
  | {
      readonly kind: "allow-popup";
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: "navigate-same-tab"; readonly url: string }
  | { readonly kind: "deny" };

export const DEFAULT_PREVIEW_POPUP_WIDTH = 500;
export const DEFAULT_PREVIEW_POPUP_HEIGHT = 700;
const MIN_POPUP_SIZE = 200;
const MAX_POPUP_SIZE = 2_000;

const OAUTH_POPUP_HOSTS = new Set([
  "accounts.google.com",
  "passkeys.google.com",
  "accounts.youtube.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "login.live.com",
  "oauth.telegram.org",
]);

export function parsePopupFeatureSize(
  features: string | undefined,
  name: "width" | "height",
): number | null {
  if (features === undefined || features.length === 0) {
    return null;
  }
  const match = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(\\d+)`, "i").exec(features);
  if (match === null) {
    return null;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(value) || value < MIN_POPUP_SIZE || value > MAX_POPUP_SIZE) {
    return null;
  }
  return value;
}

export function isAboutBlankUrl(url: string): boolean {
  return url === "about:blank" || url.startsWith("about:blank?") || url.startsWith("about:blank#");
}

function hasPopupWindowFeatures(features: string | undefined): boolean {
  if (features === undefined || features.length === 0) {
    return false;
  }
  if (/(?:^|,)\s*popup(?:\s*=|,|$)/i.test(features)) {
    return true;
  }
  return (
    parsePopupFeatureSize(features, "width") !== null ||
    parsePopupFeatureSize(features, "height") !== null
  );
}

function isHttpOrHttpsUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isKnownOauthPopupUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return OAUTH_POPUP_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

export function decidePreviewWindowOpen(input: PreviewWindowOpenInput): PreviewWindowOpenDecision {
  const url = input.url.trim();
  if (url.length === 0) {
    return { kind: "deny" };
  }

  const wantsPopup =
    input.disposition === "new-window" ||
    hasPopupWindowFeatures(input.features) ||
    isAboutBlankUrl(url) ||
    isKnownOauthPopupUrl(url);

  if (wantsPopup) {
    if (!isAboutBlankUrl(url) && !isHttpOrHttpsUrl(url)) {
      return { kind: "deny" };
    }
    return {
      kind: "allow-popup",
      width: parsePopupFeatureSize(input.features, "width") ?? DEFAULT_PREVIEW_POPUP_WIDTH,
      height: parsePopupFeatureSize(input.features, "height") ?? DEFAULT_PREVIEW_POPUP_HEIGHT,
    };
  }

  if (isHttpOrHttpsUrl(url)) {
    return { kind: "navigate-same-tab", url };
  }
  return { kind: "deny" };
}

export function previewPopupWindowBounds(input: {
  readonly width: number;
  readonly height: number;
}): {
  readonly width: number;
  readonly height: number;
  readonly autoHideMenuBar: true;
} {
  return {
    width: input.width,
    height: input.height,
    autoHideMenuBar: true,
    show: true,
  };
}

/**
 * Guest webviews often omit `webPreferences.partition`. Passing only these
 * flags without the opener's `session` makes Electron use the default
 * session, which has no preview SOCKS tunnel — localhost then hits the laptop.
 */
export const PREVIEW_POPUP_WEB_PREFERENCES = {
  preload: "",
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webviewTag: false,
} as const;
