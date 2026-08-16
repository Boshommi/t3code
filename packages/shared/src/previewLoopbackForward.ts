import { isLoopbackHost, normalizePreviewUrl } from "./preview.ts";

export const PREVIEW_LOOPBACK_TUNNEL_PATH = "/preview-tunnel";

/**
 * Public name that resolves to 127.0.0.1 but is not in Chromium's implicit
 * localhost proxy-bypass list. Same trick cmux uses (`cmux-loopback.localtest.me`):
 * the in-app browser visits this host, SOCKS CONNECT goes to the alias, and
 * we map it back to 127.0.0.1 on the remote. Staying on the name `localhost`
 * is what made Chromium send HTTP-proxy absolute-form GETs / skip the proxy.
 */
export const PREVIEW_LOOPBACK_ALIAS_HOST = "t3-loopback.localtest.me";

export const isPreviewLoopbackAliasHost = (host: string): boolean => {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return (
    normalized === PREVIEW_LOOPBACK_ALIAS_HOST ||
    normalized.endsWith(`.${PREVIEW_LOOPBACK_ALIAS_HOST}`)
  );
};

export const rewritePreviewUrlToAlias = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    if (!isLoopbackHost(url.hostname)) return rawUrl;
    url.hostname = PREVIEW_LOOPBACK_ALIAS_HOST;
    return url.href;
  } catch {
    return rawUrl;
  }
};

export type LoopbackPreviewTarget = {
  readonly href: string;
  readonly port: number;
  readonly protocol: "http:" | "https:";
};

export type LoopbackForwardDecision =
  | { readonly kind: "not-applicable" }
  | { readonly kind: "reuse-tunnel"; readonly port: number }
  | { readonly kind: "start-tunnel"; readonly port: number };

export function parseLoopbackPreviewTarget(rawUrl: string): LoopbackPreviewTarget | null {
  let href: string;
  try {
    href = normalizePreviewUrl(rawUrl);
  } catch {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!isLoopbackHost(parsed.hostname) && !isPreviewLoopbackAliasHost(parsed.hostname)) {
    return null;
  }
  const port =
    parsed.port.length > 0
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "https:"
        ? 443
        : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { href, port, protocol: parsed.protocol };
}

export function rewritePreviewTunnelPort(tunnelWebsocketUrl: string, port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  let parsed: URL;
  try {
    parsed = new URL(tunnelWebsocketUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  if (parsed.pathname !== PREVIEW_LOOPBACK_TUNNEL_PATH) return null;
  if ((parsed.searchParams.get("wsTicket") ?? "").length === 0) return null;
  parsed.searchParams.set("port", String(port));
  return parsed.toString();
}

export const PREVIEW_LOOPBACK_REQUEST_URL_PATTERNS = [
  "http://localhost/*",
  "http://127.0.0.1/*",
  "http://[::1]/*",
  `http://${PREVIEW_LOOPBACK_ALIAS_HOST}/*`,
  "https://localhost/*",
  "https://127.0.0.1/*",
  "https://[::1]/*",
  `https://${PREVIEW_LOOPBACK_ALIAS_HOST}/*`,
  "ws://localhost/*",
  "ws://127.0.0.1/*",
  "ws://[::1]/*",
  `ws://${PREVIEW_LOOPBACK_ALIAS_HOST}/*`,
  "wss://localhost/*",
  "wss://127.0.0.1/*",
  "wss://[::1]/*",
  `wss://${PREVIEW_LOOPBACK_ALIAS_HOST}/*`,
] as const;

export function previewRequestUrlToLoopbackTarget(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  return parsed.toString();
}

export function parsePreviewTunnelPort(rawUrl: URL): number | null {
  const raw = rawUrl.searchParams.get("port");
  if (raw === null || raw.trim().length === 0) return null;
  if (!/^\d+$/u.test(raw)) return null;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return port;
}

export function decideLoopbackForward(input: {
  readonly environmentIsLoopback: boolean;
  readonly target: LoopbackPreviewTarget | null;
  readonly hasOurTunnel: boolean;
}): LoopbackForwardDecision {
  if (input.target === null || input.environmentIsLoopback) {
    return { kind: "not-applicable" };
  }
  if (input.hasOurTunnel) {
    return { kind: "reuse-tunnel", port: input.target.port };
  }
  return { kind: "start-tunnel", port: input.target.port };
}
