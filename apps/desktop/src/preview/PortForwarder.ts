import type { DesktopPortForward, EnvironmentId } from "@t3tools/contracts";
import { rewritePreviewTunnelPort } from "@t3tools/shared/previewLoopbackForward";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createWebSocketDuplex, PreviewLoopbackForwardError } from "./LoopbackForwarder.ts";
import { ignoreBenignPreviewSocketErrors, pipeByteSources } from "./previewHttp.ts";

type ForwardEntry = {
  readonly forward: DesktopPortForward;
  readonly server: NodeNet.Server;
  readonly sockets: Set<NodeNet.Socket>;
  /** Replaced on every `forward` call so connections use an unexpired ticket. */
  tunnelWebsocketUrl: string;
};

const forwardKey = (environmentId: EnvironmentId, remotePort: number) =>
  `${environmentId}:${String(remotePort)}`;

const isAddressInUse = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE";

const listen = (server: NodeNet.Server, port: number) =>
  new Promise<number>((resolve, reject) => {
    const onError = (cause: Error) => reject(cause);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });

/**
 * Real TCP listeners on this machine's loopback that reach a remote
 * environment's localhost ports through `/preview-tunnel`, so the system
 * browser can open a remote dev server. Unlike the in-app preview's SOCKS
 * proxy, these listeners are visible to every local process.
 */
export class PortForwarder extends Context.Service<
  PortForwarder,
  {
    /** Starts a forward, or refreshes the tunnel ticket of an existing one. */
    readonly forward: (input: {
      readonly environmentId: EnvironmentId;
      readonly remotePort: number;
      readonly tunnelWebsocketUrl: string;
    }) => Effect.Effect<DesktopPortForward, PreviewLoopbackForwardError>;
    readonly stop: (input: {
      readonly environmentId: EnvironmentId;
      readonly remotePort: number;
    }) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<DesktopPortForward>>;
  }
>()("@t3tools/desktop/preview/PortForwarder") {}

export const makeWith = (connectTunnel: (tunnelWebsocketUrl: string) => NodeStream.Duplex) =>
  Effect.gen(function* () {
    const entries = new Map<string, ForwardEntry>();

    const close = (entry: ForwardEntry) => {
      entry.server.close();
      for (const socket of entry.sockets) socket.destroy();
      entry.sockets.clear();
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const entry of entries.values()) close(entry);
        entries.clear();
      }),
    );

    const start = Effect.fn("desktop.preview.portForward.start")(function* (input: {
      readonly environmentId: EnvironmentId;
      readonly remotePort: number;
      readonly tunnelWebsocketUrl: string;
    }) {
      const sockets = new Set<NodeNet.Socket>();
      // Filled in once the listener is up; connections cannot arrive before.
      let entry: ForwardEntry | undefined;
      const server = NodeNet.createServer((socket) => {
        ignoreBenignPreviewSocketErrors(socket);
        const tunnelUrl =
          entry === undefined
            ? null
            : rewritePreviewTunnelPort(entry.tunnelWebsocketUrl, input.remotePort);
        if (tunnelUrl === null) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        pipeByteSources(socket, connectTunnel(tunnelUrl));
      });
      // Same port first so the page keeps the origin its CORS and OAuth
      // settings expect; any free port when this machine already uses it.
      const localPort = yield* Effect.tryPromise({
        try: () =>
          listen(server, input.remotePort).catch((cause: unknown) =>
            isAddressInUse(cause) ? listen(server, 0) : Promise.reject(cause),
          ),
        catch: (cause) =>
          new PreviewLoopbackForwardError({
            detail: `Could not forward port ${String(input.remotePort)} to this machine.`,
            cause,
          }),
      });
      // A concurrent call (a double click) may have finished listening first.
      const raced = entries.get(forwardKey(input.environmentId, input.remotePort));
      if (raced !== undefined) {
        server.close();
        return raced.forward;
      }
      entry = {
        forward: { environmentId: input.environmentId, remotePort: input.remotePort, localPort },
        server,
        sockets,
        tunnelWebsocketUrl: input.tunnelWebsocketUrl,
      };
      entries.set(forwardKey(input.environmentId, input.remotePort), entry);
      return entry.forward;
    });

    const forward: PortForwarder["Service"]["forward"] = (input) => {
      const existing = entries.get(forwardKey(input.environmentId, input.remotePort));
      if (existing === undefined) return start(input);
      return Effect.sync(() => {
        existing.tunnelWebsocketUrl = input.tunnelWebsocketUrl;
        return existing.forward;
      });
    };

    const stop: PortForwarder["Service"]["stop"] = (input) =>
      Effect.sync(() => {
        const key = forwardKey(input.environmentId, input.remotePort);
        const entry = entries.get(key);
        if (entry === undefined) return;
        entries.delete(key);
        close(entry);
      });

    return PortForwarder.of({
      forward,
      stop,
      list: Effect.sync(() => Array.from(entries.values(), (entry) => entry.forward)),
    });
  });

export const make = makeWith((tunnelWebsocketUrl) => createWebSocketDuplex(tunnelWebsocketUrl));

export const layer = Layer.effect(PortForwarder, make);
