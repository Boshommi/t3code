import { parseLoopbackPreviewTarget } from "@t3tools/shared/previewLoopbackForward";
import { PREVIEW_LOOPBACK_TUNNEL_PATH } from "@t3tools/shared/previewLoopbackForward";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import type { EnvironmentId } from "@t3tools/contracts";

import { previewBridge } from "~/components/preview/previewBridge";
import { readPreparedConnection } from "~/state/session";

import { previewEnvironmentIsLocal, resolveBrowserNavigationTarget } from "./browserTargetResolver";

export const issuePreviewTunnelWebsocketUrl = async (
  httpBaseUrl: string,
  authorization:
    | { readonly _tag: "Bearer"; readonly token: string }
    | { readonly _tag: "Dpop"; readonly accessToken: string }
    | null,
  port: number,
): Promise<string | null> => {
  if (authorization?._tag === "Dpop") return null;
  const ticketUrl = new URL("/api/auth/websocket-ticket", httpBaseUrl);
  const headers: Record<string, string> = { accept: "application/json" };
  const init: RequestInit = { method: "POST", headers };
  if (authorization?._tag === "Bearer") {
    headers.authorization = `Bearer ${authorization.token}`;
  } else {
    init.credentials = "include";
  }
  const response = await fetch(ticketUrl, init);
  if (!response.ok) return null;
  const body: unknown = await response.json();
  const ticket =
    typeof body === "object" && body !== null && "ticket" in body && typeof body.ticket === "string"
      ? body.ticket
      : null;
  if (ticket === null || ticket.length === 0) return null;
  const websocketUrl = new URL(httpBaseUrl);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  websocketUrl.pathname = PREVIEW_LOOPBACK_TUNNEL_PATH;
  websocketUrl.search = "";
  websocketUrl.hash = "";
  websocketUrl.searchParams.set("wsTicket", ticket);
  websocketUrl.searchParams.set("port", String(port));
  return websocketUrl.toString();
};

// Main reuses the ticket from the latest remote navigation for every later
// preview connection, related ports included, and tickets expire after five
// minutes. Dev servers drop idle keep-alive sockets within seconds, so a page
// left open (an auth iframe, a login POST, an HMR reconnect) needs a fresh
// ticket long after its navigation.
const PREVIEW_TICKET_REFRESH_INTERVAL_MS = 4 * 60_000;

type PreviewTunnelTarget = {
  readonly environmentId: EnvironmentId;
  readonly href: string;
  readonly port: number;
};

let previewTunnelTarget: PreviewTunnelTarget | null = null;
let previewTicketTimer: ReturnType<typeof setInterval> | null = null;

async function refreshPreviewTunnelTicket() {
  const target = previewTunnelTarget;
  const ensureLoopbackForward = previewBridge?.ensureLoopbackForward;
  if (target === null || ensureLoopbackForward === undefined) return;
  const connection = readPreparedConnection(target.environmentId);
  if (connection === null) return;
  try {
    const tunnelWebsocketUrl = await issuePreviewTunnelWebsocketUrl(
      connection.httpBaseUrl,
      connection.httpAuthorization,
      target.port,
    );
    // A navigation to another environment while the ticket was in flight owns
    // the tunnel now; re-ensuring this one would route it back here.
    if (tunnelWebsocketUrl === null || previewTunnelTarget !== target) return;
    await ensureLoopbackForward({
      environmentId: target.environmentId,
      url: target.href,
      environmentIsLoopback: false,
      tunnelWebsocketUrl,
    });
  } catch {
    // A disconnected environment gets another try on the next tick.
  }
}

export async function prepareDesktopLoopbackPreviewUrl(
  environmentId: EnvironmentId,
  rawUrl: string,
): Promise<string | null> {
  const connection = readPreparedConnection(environmentId);
  const target = parseLoopbackPreviewTarget(rawUrl);
  if (
    previewBridge?.ensureLoopbackForward === undefined ||
    connection === null ||
    target === null ||
    previewEnvironmentIsLocal(connection)
  ) {
    return null;
  }
  const tunnelWebsocketUrl = await issuePreviewTunnelWebsocketUrl(
    connection.httpBaseUrl,
    connection.httpAuthorization,
    target.port,
  );
  if (tunnelWebsocketUrl === null) return null;
  const forwarded = await previewBridge.ensureLoopbackForward({
    environmentId,
    url: target.href,
    environmentIsLoopback: false,
    tunnelWebsocketUrl,
  });
  previewTunnelTarget = { environmentId, href: target.href, port: target.port };
  previewTicketTimer ??= setInterval(
    () => void refreshPreviewTunnelTicket(),
    PREVIEW_TICKET_REFRESH_INTERVAL_MS,
  );
  return forwarded.navigateUrl;
}

export async function resolvePreviewNavigationUrl(
  environmentId: EnvironmentId,
  rawUrl: string,
): Promise<string> {
  const prepared = await prepareDesktopLoopbackPreviewUrl(environmentId, rawUrl);
  if (prepared !== null) return prepared;
  try {
    return resolveBrowserNavigationTarget(environmentId, {
      kind: "url",
      url: normalizePreviewUrl(rawUrl),
    }).resolvedUrl;
  } catch {
    return rawUrl;
  }
}
