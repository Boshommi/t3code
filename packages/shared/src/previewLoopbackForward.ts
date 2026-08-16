import { isLoopbackHost, normalizePreviewUrl } from "./preview.ts";

export const PREVIEW_LOOPBACK_TUNNEL_PATH = "/preview-tunnel";

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
  if (!isLoopbackHost(parsed.hostname)) return null;
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
  "https://localhost/*",
  "https://127.0.0.1/*",
  "https://[::1]/*",
  "ws://localhost/*",
  "ws://127.0.0.1/*",
  "ws://[::1]/*",
  "wss://localhost/*",
  "wss://127.0.0.1/*",
  "wss://[::1]/*",
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

export function buildPreviewLoopbackPacScript(proxyPort: number): string {
  return [
    "function FindProxyForURL(url, host) {",
    '  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host === "0.0.0.0") {',
    `    return "PROXY 127.0.0.1:${String(proxyPort)}";`,
    "  }",
    '  return "DIRECT";',
    "}",
    "",
  ].join("\n");
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
