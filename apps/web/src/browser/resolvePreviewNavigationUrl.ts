import { parseLoopbackPreviewTarget } from "@t3tools/shared/previewLoopbackForward";
import { PREVIEW_LOOPBACK_TUNNEL_PATH } from "@t3tools/shared/previewLoopbackForward";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import type { EnvironmentId } from "@t3tools/contracts";

import { previewBridge } from "~/components/preview/previewBridge";
import { readPreparedConnection } from "~/state/session";

import { previewEnvironmentIsLocal, resolveBrowserNavigationTarget } from "./browserTargetResolver";

const issuePreviewTunnelWebsocketUrl = async (
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
