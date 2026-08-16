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
  | { readonly kind: "prefer-local"; readonly port: number }
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
  readonly localPortHasListener: boolean;
}): LoopbackForwardDecision {
  if (input.target === null || input.environmentIsLoopback) {
    return { kind: "not-applicable" };
  }
  if (input.hasOurTunnel) {
    return { kind: "reuse-tunnel", port: input.target.port };
  }
  if (input.localPortHasListener) {
    return { kind: "prefer-local", port: input.target.port };
  }
  return { kind: "start-tunnel", port: input.target.port };
}
