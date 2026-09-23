import type { DesktopPortForward, EnvironmentId } from "@t3tools/contracts";
import { parseLoopbackPreviewTarget } from "@t3tools/shared/previewLoopbackForward";
import * as Option from "effect/Option";
import { useMemo } from "react";
import { create } from "zustand";

import { previewBridge } from "~/components/preview/previewBridge";
import { toastManager } from "~/components/ui/toast";
import { ensureLocalApi } from "~/localApi";
import { readPreparedConnection, usePreparedConnection } from "~/state/session";

import { previewEnvironmentIsLocal } from "./browserTargetResolver";
import { issuePreviewTunnelWebsocketUrl } from "./resolvePreviewNavigationUrl";

// Tunnel tickets live five minutes and every new browser connection presents
// one, so an active forward needs a fresh ticket before the last one lapses.
const TICKET_REFRESH_INTERVAL_MS = 4 * 60_000;

/** Forwards the desktop main process holds open, mirrored for the UI. */
export const usePortForwardStore = create<{
  readonly forwards: ReadonlyArray<DesktopPortForward>;
}>(() => ({ forwards: [] }));

let refreshTimer: ReturnType<typeof setInterval> | null = null;

const sameForward = (
  left: Pick<DesktopPortForward, "environmentId" | "remotePort">,
  right: Pick<DesktopPortForward, "environmentId" | "remotePort">,
) => left.environmentId === right.environmentId && left.remotePort === right.remotePort;

function setForwards(forwards: ReadonlyArray<DesktopPortForward>) {
  usePortForwardStore.setState({ forwards });
  if (forwards.length === 0 && refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  } else if (forwards.length > 0 && refreshTimer === null) {
    refreshTimer = setInterval(() => void refreshTickets(), TICKET_REFRESH_INTERVAL_MS);
  }
}

async function issueTunnelUrl(environmentId: EnvironmentId, remotePort: number): Promise<string> {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("This environment is not connected.");
  if (connection.httpAuthorization?._tag === "Dpop") {
    throw new Error("Port forwarding is not available over T3 Connect yet.");
  }
  const url = await issuePreviewTunnelWebsocketUrl(
    connection.httpBaseUrl,
    connection.httpAuthorization,
    remotePort,
  );
  if (url === null) throw new Error("The environment did not authorize the port forward.");
  return url;
}

async function refreshTickets() {
  const forwardPort = previewBridge?.forwardPort;
  if (forwardPort === undefined) return;
  await Promise.all(
    usePortForwardStore.getState().forwards.map(async ({ environmentId, remotePort }) => {
      try {
        const tunnelWebsocketUrl = await issueTunnelUrl(environmentId, remotePort);
        await forwardPort({ environmentId, remotePort, tunnelWebsocketUrl });
      } catch {
        // A disconnected environment gets another try on the next tick.
      }
    }),
  );
}

// Main keeps forwards across renderer reloads; pick them back up so their
// tickets keep being refreshed.
if (previewBridge?.listPortForwards !== undefined) {
  void previewBridge.listPortForwards().then(
    (forwards) => {
      setForwards(forwards);
      void refreshTickets();
    },
    () => undefined,
  );
}

const connectionCanForwardPorts = (connection: ReturnType<typeof readPreparedConnection>) =>
  previewBridge?.forwardPort !== undefined &&
  connection !== null &&
  connection.httpAuthorization?._tag !== "Dpop" &&
  !previewEnvironmentIsLocal(connection);

/**
 * Whether this environment's localhost is another machine that the desktop
 * app can forward ports from. T3 Connect sessions cannot mint tunnel tickets.
 */
export function canForwardPorts(environmentId: EnvironmentId | null | undefined): boolean {
  if (!environmentId) return false;
  return connectionCanForwardPorts(readPreparedConnection(environmentId));
}

/** `canForwardPorts` for render, updating when the environment's connection does. */
export function useCanForwardPorts(environmentId: EnvironmentId | null): boolean {
  return connectionCanForwardPorts(Option.getOrNull(usePreparedConnection(environmentId)));
}

/**
 * Whether the system browser needs a forward to open this URL: it points at
 * localhost, and localhost for this environment is another machine.
 */
export function needsPortForward(
  environmentId: EnvironmentId | null | undefined,
  rawUrl: string,
): boolean {
  if (!environmentId || previewBridge?.forwardPort === undefined) return false;
  if (parseLoopbackPreviewTarget(rawUrl) === null) return false;
  return !previewEnvironmentIsLocal(readPreparedConnection(environmentId));
}

/** The environment's forwards; they belong to the remote, not to any one thread. */
export function useEnvironmentPortForwards(
  environmentId: EnvironmentId | null | undefined,
): ReadonlyArray<DesktopPortForward> {
  const forwards = usePortForwardStore((state) => state.forwards);
  return useMemo(
    () => forwards.filter((forward) => forward.environmentId === environmentId),
    [environmentId, forwards],
  );
}

/** Starts forwarding a remote port, or returns the forward already running. */
export async function forwardPort(
  environmentId: EnvironmentId,
  remotePort: number,
): Promise<DesktopPortForward> {
  const bridgeForwardPort = previewBridge?.forwardPort;
  if (bridgeForwardPort === undefined) {
    throw new Error("Port forwarding needs the T3 Code desktop app.");
  }
  const tunnelWebsocketUrl = await issueTunnelUrl(environmentId, remotePort);
  const forward = await bridgeForwardPort({ environmentId, remotePort, tunnelWebsocketUrl });
  const { forwards } = usePortForwardStore.getState();
  if (!forwards.some((existing) => sameForward(existing, forward))) {
    setForwards([...forwards, forward]);
  }
  return forward;
}

/**
 * URL on this machine for a forward. A remote URL keeps its path and its
 * `localhost` or `127.0.0.1` host, since pages care which origin they are on;
 * without one, the forward's own listen address is the literal answer.
 */
export function forwardedUrl(forward: DesktopPortForward, remoteUrl?: string): string {
  const target = remoteUrl === undefined ? null : parseLoopbackPreviewTarget(remoteUrl);
  const url = new URL(target?.href ?? "http://127.0.0.1/");
  // The forward listens on 127.0.0.1 only; `localhost` resolves there too.
  if (url.hostname !== "127.0.0.1") url.hostname = "localhost";
  url.port = String(forward.localPort);
  return url.href;
}

export async function stopPortForward(
  forward: Pick<DesktopPortForward, "environmentId" | "remotePort">,
): Promise<void> {
  await previewBridge?.stopPortForward?.({
    environmentId: forward.environmentId,
    remotePort: forward.remotePort,
  });
  setForwards(
    usePortForwardStore.getState().forwards.filter((existing) => !sameForward(existing, forward)),
  );
}

/**
 * Opens a URL in the system browser. A remote environment's localhost URL is
 * first forwarded to this machine, so the browser reaches the remote dev
 * server rather than whatever runs locally on that port.
 */
export async function openUrlInSystemBrowser(
  environmentId: EnvironmentId | null | undefined,
  rawUrl: string,
): Promise<void> {
  const api = ensureLocalApi();
  const target = needsPortForward(environmentId, rawUrl)
    ? parseLoopbackPreviewTarget(rawUrl)
    : null;
  if (!environmentId || target === null) {
    await api.shell.openExternal(rawUrl);
    return;
  }
  const alreadyForwarded = usePortForwardStore
    .getState()
    .forwards.some((existing) => sameForward(existing, { environmentId, remotePort: target.port }));
  const forward = await forwardPort(environmentId, target.port);
  if (!alreadyForwarded) {
    toastManager.add({
      type: "success",
      title: `Forwarding port ${String(target.port)}`,
      description:
        forward.localPort === target.port
          ? `localhost:${String(target.port)} on this machine now reaches the remote environment.`
          : `Port ${String(target.port)} is in use on this machine, so it is forwarded to localhost:${String(forward.localPort)}.`,
      actionProps: { children: "Ports", onClick: () => openPortForwardsDialog(environmentId) },
    });
  }
  await api.shell.openExternal(forwardedUrl(forward, rawUrl));
}

/** Which environment's ports dialog is open; the dialog is mounted once at the app root. */
export const usePortForwardsDialogStore = create<{
  readonly environmentId: EnvironmentId | null;
}>(() => ({ environmentId: null }));

export function openPortForwardsDialog(environmentId: EnvironmentId): void {
  usePortForwardsDialogStore.setState({ environmentId });
}

export function closePortForwardsDialog(): void {
  usePortForwardsDialogStore.setState({ environmentId: null });
}
