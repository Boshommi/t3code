/**
 * Port forwards from remote environments, like `ssh -L`. The desktop main
 * process listens on this computer's loopback, on the remote port number when
 * it is free, and tunnels each connection to the remote's localhost over the
 * environment's session. A forward belongs to the environment, not a thread.
 * This module mirrors the forwards for the UI, keeps their tunnel tickets
 * fresh, and turns a remote `localhost` URL into one this computer reaches.
 */
import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  AuthPreviewOperateScope,
  type DesktopPortForward,
  type EnvironmentId,
} from "@t3tools/contracts";
import { loopbackUrlPort, normalizePreviewUrl, PREVIEW_TUNNEL_PATH } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { create } from "zustand";

import { previewBridge } from "~/components/preview/previewBridge";
import { connectionAtomRuntime } from "~/connection/runtime";
import { ensureLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  readEnvironmentSupportsLoopbackTunnel,
  useEnvironmentSupportsLoopbackTunnel,
} from "~/state/entities";
import {
  environmentSession,
  readEnvironmentScope,
  readPreparedConnection,
  useEnvironmentScope,
  usePreparedConnection,
} from "~/state/session";

import { reachesEnvironmentLoopback, resolveDiscoveredServerUrl } from "./browserTargetResolver";

export type ForwardPlan =
  | { readonly kind: "none" }
  | { readonly kind: "ready"; readonly url: string }
  | { readonly kind: "start"; readonly remotePort: number };

/** The URL on this computer that reaches a remote URL through a forward. */
export function forwardedUrl(remoteUrl: string, localPort: number): string {
  const url = new URL(remoteUrl);
  // The forward listens on 127.0.0.1, which `localhost` also reaches.
  if (url.hostname !== "127.0.0.1") url.hostname = "localhost";
  url.port = String(localPort);
  return url.href;
}

/**
 * How an environment's URL is reached from this computer, given its forwards.
 * A URL already on one of the forwards' local ports is used as is, since that
 * is where an earlier forward sent the page.
 */
export function planForward(
  rawUrl: string,
  forwards: ReadonlyArray<DesktopPortForward>,
): ForwardPlan {
  const port = loopbackUrlPort(rawUrl);
  if (port === null) return { kind: "none" };
  const existing = forwards.find((forward) => forward.remotePort === port);
  if (existing) return { kind: "ready", url: forwardedUrl(rawUrl, existing.localPort) };
  if (forwards.some((forward) => forward.localPort === port)) return { kind: "ready", url: rawUrl };
  return { kind: "start", remotePort: port };
}

/** The environment's own URL for one that points at a forward on this computer. */
export function unforwardedUrl(
  localUrl: string,
  forwards: ReadonlyArray<DesktopPortForward>,
): string {
  const port = loopbackUrlPort(localUrl);
  const forward = forwards.find((candidate) => candidate.localPort === port);
  if (!forward || forward.remotePort === port) return localUrl;
  const url = new URL(localUrl);
  url.port = String(forward.remotePort);
  return url.href;
}

/** Forwards the desktop main process holds open, mirrored for the UI. */
export const usePortForwardStore = create<{
  readonly forwards: ReadonlyArray<DesktopPortForward>;
}>(() => ({ forwards: [] }));

const environmentForwards = (environmentId: EnvironmentId) =>
  usePortForwardStore
    .getState()
    .forwards.filter((forward) => forward.environmentId === environmentId);

/** The environment's forwards, sorted by remote port. */
export function useEnvironmentPortForwards(
  environmentId: EnvironmentId | null,
): ReadonlyArray<DesktopPortForward> {
  return usePortForwardStore((state) => state.forwards)
    .filter((forward) => forward.environmentId === environmentId)
    .toSorted((left, right) => left.remotePort - right.remotePort);
}

const canForward = (
  prepared: PreparedConnection | null,
  supportsTunnel: boolean,
  canOperatePreview: boolean,
) =>
  previewBridge !== null &&
  prepared !== null &&
  // Cookie sessions belong to the page's own origin and cannot mint tickets.
  prepared.httpAuthorization !== null &&
  !reachesEnvironmentLoopback(prepared.target) &&
  supportsTunnel &&
  canOperatePreview;

/** Whether the environment's localhost is another machine this app can forward from. */
export function canForwardPorts(environmentId: EnvironmentId): boolean {
  return canForward(
    readPreparedConnection(environmentId),
    readEnvironmentSupportsLoopbackTunnel(environmentId),
    readEnvironmentScope(environmentId, AuthPreviewOperateScope),
  );
}

export function useCanForwardPorts(environmentId: EnvironmentId | null): boolean {
  return canForward(
    Option.getOrNull(usePreparedConnection(environmentId)),
    useEnvironmentSupportsLoopbackTunnel(environmentId),
    useEnvironmentScope(environmentId, AuthPreviewOperateScope),
  );
}

const tunnelAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: PREVIEW_TUNNEL_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`preview-tunnel-access:${environmentId}`)),
);

/** A tunnel URL with a new ticket; each one is valid for five minutes. */
async function issueTunnelUrl(environmentId: EnvironmentId): Promise<string> {
  const atom = tunnelAccessAtom(environmentId);
  appAtomRegistry.refresh(atom);
  const access = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
  const ticket = access?.query.wsTicket;
  if (!access || !ticket) throw new Error("The environment did not authorize the port forward.");
  const url = new URL(access.wsBase);
  url.searchParams.set("wsTicket", ticket);
  return url.href;
}

// New connections present the ticket, so it is replaced before the last one lapses.
const TICKET_REFRESH_INTERVAL_MS = 4 * 60_000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function setForwards(forwards: ReadonlyArray<DesktopPortForward>) {
  usePortForwardStore.setState({ forwards });
  if (forwards.length === 0 && refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  } else if (forwards.length > 0 && refreshTimer === null) {
    refreshTimer = setInterval(() => void refreshTickets(), TICKET_REFRESH_INTERVAL_MS);
  }
}

async function refreshTickets() {
  const bridge = previewBridge;
  if (!bridge) return;
  // One call per environment: main keeps a single tunnel URL per environment.
  const byEnvironment = new Map(
    usePortForwardStore.getState().forwards.map((forward) => [forward.environmentId, forward]),
  );
  await Promise.all(
    Array.from(byEnvironment.values(), async ({ environmentId, remotePort }) => {
      try {
        const tunnelUrl = await issueTunnelUrl(environmentId);
        await bridge.forwardPort({ environmentId, remotePort, tunnelUrl });
      } catch {
        // A disconnected environment gets another try on the next tick.
      }
    }),
  );
}

// Forwards outlive a renderer reload; pick them back up so their tickets stay fresh.
void previewBridge?.listPortForwards().then((forwards) => {
  setForwards(forwards);
  void refreshTickets();
}, console.error);

/** Starts forwarding a remote port, or returns the forward already running. */
export async function forwardPort(
  environmentId: EnvironmentId,
  remotePort: number,
): Promise<DesktopPortForward> {
  if (!previewBridge) throw new Error("Port forwarding needs the T3 Code desktop app.");
  const tunnelUrl = await issueTunnelUrl(environmentId);
  const forward = await previewBridge.forwardPort({ environmentId, remotePort, tunnelUrl });
  const { forwards } = usePortForwardStore.getState();
  if (
    !forwards.some(
      (existing) =>
        existing.environmentId === environmentId && existing.remotePort === forward.remotePort,
    )
  ) {
    setForwards([...forwards, forward]);
  }
  return forward;
}

export async function stopPortForward(forward: DesktopPortForward): Promise<void> {
  await previewBridge?.stopPortForward({
    environmentId: forward.environmentId,
    remotePort: forward.remotePort,
  });
  setForwards(
    usePortForwardStore
      .getState()
      .forwards.filter(
        (existing) =>
          existing.environmentId !== forward.environmentId ||
          existing.remotePort !== forward.remotePort,
      ),
  );
}

/**
 * The URL on this computer for an environment's `localhost` URL, forwarding
 * its port first. Null when the URL is not on loopback or the environment's
 * loopback is not forwardable from here.
 */
export async function forwardEnvironmentUrl(
  environmentId: EnvironmentId,
  rawUrl: string,
): Promise<string | null> {
  if (!canForwardPorts(environmentId)) return null;
  const url = normalizePreviewUrl(rawUrl);
  const plan = planForward(url, environmentForwards(environmentId));
  switch (plan.kind) {
    case "none":
      return null;
    case "ready":
      return plan.url;
    case "start":
      return forwardedUrl(url, (await forwardPort(environmentId, plan.remotePort)).localPort);
  }
}

/**
 * Where a desktop tab of the environment should load a URL. Its `localhost`
 * is reached through a forward when possible, keeping the page's origin;
 * otherwise through the environment's address.
 */
export async function resolveDesktopTabUrl(
  environmentId: EnvironmentId,
  rawUrl: string,
): Promise<string> {
  try {
    const forwarded = await forwardEnvironmentUrl(environmentId, rawUrl);
    if (forwarded !== null) return forwarded;
  } catch (error) {
    console.warn("Could not forward the environment's port; using its address instead.", error);
  }
  return resolveDiscoveredServerUrl(environmentId, rawUrl);
}

/**
 * Where a desktop tab of the environment should open a link. A `localhost`
 * link from a remote thread means the remote, so it goes through a forward
 * when one can be made, and is left as it is otherwise.
 */
export async function desktopTabLinkUrl(
  environmentId: EnvironmentId,
  rawUrl: string,
): Promise<string> {
  return (await forwardEnvironmentUrl(environmentId, rawUrl).catch(() => null)) ?? rawUrl;
}

/** An environment's URL for a page a desktop tab reached through a forward. */
export function environmentUrlFor(environmentId: EnvironmentId, localUrl: string): string {
  return unforwardedUrl(localUrl, environmentForwards(environmentId));
}

/** Whether opening the URL outside the app needs one of the environment's ports forwarded. */
export function urlNeedsPortForward(
  environmentId: EnvironmentId | null | undefined,
  rawUrl: string,
): boolean {
  return !!environmentId && loopbackUrlPort(rawUrl) !== null && canForwardPorts(environmentId);
}

/**
 * Opens a URL in the system browser. An environment's `localhost` URL is
 * forwarded first, so the browser reaches the remote server rather than
 * whatever runs on that port here.
 */
export async function openUrlInSystemBrowser(
  environmentId: EnvironmentId | null | undefined,
  rawUrl: string,
): Promise<void> {
  const forwarded = environmentId ? await forwardEnvironmentUrl(environmentId, rawUrl) : null;
  await ensureLocalApi().shell.openExternal(forwarded ?? rawUrl);
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
