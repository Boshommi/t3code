import { EnvironmentId } from "@t3tools/contracts";
import {
  decideLoopbackForward,
  isPreviewLoopbackAliasHost,
  parseLoopbackPreviewTarget,
  previewRequestUrlToLoopbackTarget,
  rewritePreviewTunnelPort,
} from "@t3tools/shared/previewLoopbackForward";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  isPreviewLoopbackDestination,
  pipeByteSources,
  runHttpForwardSession,
} from "./previewHttp.ts";
import { pipeWithPreviewLoopbackAliasRewrite } from "./previewLoopbackAlias.ts";
import { acceptSocks5Connect, SOCKS5_REP, SOCKS5_VERSION, socks5Reply } from "./socks5.ts";

export class PreviewLoopbackForwardError extends Schema.TaggedErrorClass<PreviewLoopbackForwardError>()(
  "PreviewLoopbackForwardError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type PreviewLoopbackForwardResult = {
  readonly navigateUrl: string;
  readonly kind: "not-applicable" | "reuse-tunnel" | "start-tunnel";
};

type TunnelEntry = {
  readonly environmentId: EnvironmentId;
  readonly port: number;
  readonly tunnelWebsocketUrl: string;
};

const tunnelKey = (environmentId: EnvironmentId, port: number) =>
  `${environmentId}:${String(port)}`;

const toSendableBytes = (buffer: Buffer): Uint8Array<ArrayBuffer> => {
  const payload = new Uint8Array(buffer.byteLength);
  payload.set(buffer);
  return payload;
};

export const createWebSocketDuplex = (
  tunnelWebsocketUrl: string,
  openWebSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
): NodeStream.Duplex => {
  const websocket = openWebSocket(tunnelWebsocketUrl);
  websocket.binaryType = "arraybuffer";
  const pending: Buffer[] = [];
  let opened = false;
  let closed = false;
  const duplex = new NodeStream.Duplex({
    write(chunk, _encoding, callback) {
      const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (opened && websocket.readyState === WebSocket.OPEN) {
        websocket.send(toSendableBytes(payload));
        callback();
        return;
      }
      if (
        websocket.readyState !== WebSocket.CONNECTING &&
        websocket.readyState !== WebSocket.OPEN
      ) {
        callback(new Error("Preview tunnel websocket is closed."));
        return;
      }
      pending.push(payload);
      callback();
    },
    read() {},
  });
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    duplex.destroy();
    if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
      websocket.close();
    }
  };
  websocket.addEventListener("open", () => {
    opened = true;
    for (const queued of pending.splice(0)) {
      websocket.send(toSendableBytes(queued));
    }
  });
  websocket.addEventListener("message", (event) => {
    const payload = event.data;
    if (payload instanceof ArrayBuffer) {
      duplex.push(Buffer.from(payload));
      return;
    }
    if (typeof payload === "string") {
      duplex.push(Buffer.from(payload));
    }
  });
  websocket.addEventListener("error", closeBoth);
  websocket.addEventListener("close", () => duplex.push(null));
  duplex.on("close", closeBoth);
  duplex.on("finish", () => {
    if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
      websocket.close();
    }
  });
  return duplex;
};

export const pipeLocalSocketToTunnel = (
  local: NodeNet.Socket,
  tunnelWebsocketUrl: string,
  openWebSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  initial?: Uint8Array,
) => {
  const duplex = createWebSocketDuplex(tunnelWebsocketUrl, openWebSocket);
  pipeByteSources(local, duplex, initial === undefined ? undefined : Buffer.from(initial));
  return {
    websocket: undefined,
    close: () => {
      local.destroy();
      duplex.destroy();
    },
  };
};

const listenOnLoopback = (port: number, onConnection: (socket: NodeNet.Socket) => void) =>
  Effect.callback<NodeNet.Server, PreviewLoopbackForwardError>((resume) => {
    const server = NodeNet.createServer(onConnection);
    let settled = false;
    const settle = (effect: Effect.Effect<NodeNet.Server, PreviewLoopbackForwardError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    server.once("error", (cause) => {
      settle(
        Effect.fail(
          new PreviewLoopbackForwardError({
            detail: `Could not listen on 127.0.0.1:${String(port)}.`,
            cause,
          }),
        ),
      );
    });
    server.listen({ host: "127.0.0.1", port }, () => {
      settle(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const connectLocal = (port: number) =>
  new Promise<NodeNet.Socket>((resolve, reject) => {
    const dest = NodeNet.createConnection({ host: "127.0.0.1", port });
    dest.once("connect", () => resolve(dest));
    dest.once("error", reject);
  });

const connectRemote = (host: string, port: number) =>
  new Promise<NodeNet.Socket>((resolve, reject) => {
    const dest = NodeNet.createConnection({ host, port });
    dest.once("connect", () => resolve(dest));
    dest.once("error", reject);
  });

const readFirstChunk = (socket: NodeNet.Socket) =>
  new Promise<Buffer>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      socket.off("error", onError);
      resolve(chunk);
    };
    const onError = (cause: Error) => {
      socket.off("data", onData);
      reject(cause);
    };
    socket.once("data", onData);
    socket.once("error", onError);
  });

export class PreviewLoopbackForwarder extends Context.Service<
  PreviewLoopbackForwarder,
  {
    readonly proxyPort: number;
    readonly ensure: (input: {
      readonly environmentId: EnvironmentId;
      readonly url: string;
      readonly environmentIsLoopback: boolean;
      readonly tunnelWebsocketUrl: string;
    }) => Effect.Effect<PreviewLoopbackForwardResult, PreviewLoopbackForwardError>;
    readonly ensureRelated: (
      rawUrl: string,
    ) => Effect.Effect<PreviewLoopbackForwardResult, PreviewLoopbackForwardError>;
  }
>()("@t3tools/desktop/preview/LoopbackForwarder/PreviewLoopbackForwarder") {}

type StoredTunnelAuth = {
  readonly environmentId: EnvironmentId;
  readonly environmentIsLoopback: boolean;
  readonly tunnelWebsocketUrl: string;
};

export const make = Effect.gen(function* () {
  const tunnels = new Map<string, TunnelEntry>();
  const authByEnvironment = new Map<EnvironmentId, StoredTunnelAuth>();
  let lastRemoteEnvironmentId: EnvironmentId | undefined;

  const resolveTunnelUrl = (port: number): string | null => {
    if (lastRemoteEnvironmentId === undefined) return null;
    const auth = authByEnvironment.get(lastRemoteEnvironmentId);
    if (auth === undefined) return null;
    return rewritePreviewTunnelPort(auth.tunnelWebsocketUrl, port);
  };

  const connectDestination = async (host: string, port: number) => {
    if (!isPreviewLoopbackDestination(host)) {
      return connectRemote(host, port);
    }
    const tunnelUrl = resolveTunnelUrl(port);
    if (tunnelUrl !== null) {
      return createWebSocketDuplex(tunnelUrl);
    }
    if (lastRemoteEnvironmentId !== undefined) {
      throw new Error("Remote preview tunnel is not available for this port.");
    }
    return connectLocal(port);
  };

  // Chromium is pointed at this listener with socks5:// rules, so the SOCKS
  // branch is the path every preview request takes: once the circuit is up we
  // copy bytes and never parse them, which is what keeps keep-alive, chunked
  // HTML, percent-encoded paths, TLS, and websocket upgrades intact. The HTTP
  // branch stays as a fallback for a Chromium build that ignores socks5 rules
  // and speaks proxy protocol at us anyway.
  const routeProxySocket = (socket: NodeNet.Socket) => {
    void (async () => {
      const first = await readFirstChunk(socket);
      if (first[0] === SOCKS5_VERSION) {
        const target = await acceptSocks5Connect(socket, first);
        const dest = await connectDestination(target.host, target.port);
        socket.write(socks5Reply(SOCKS5_REP.succeeded));
        if (isPreviewLoopbackAliasHost(target.host)) {
          pipeWithPreviewLoopbackAliasRewrite(socket, dest, target.leftover);
          return;
        }
        pipeByteSources(socket, dest, target.leftover);
        return;
      }
      await runHttpForwardSession(socket, first, connectDestination);
    })().catch(() => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  };

  const proxyServer = yield* listenOnLoopback(0, routeProxySocket);
  const proxyAddress = proxyServer.address();
  const proxyPort =
    typeof proxyAddress === "object" && proxyAddress !== null ? proxyAddress.port : 0;
  if (proxyPort === 0) {
    return yield* new PreviewLoopbackForwardError({
      detail: "Could not listen for the preview-only loopback proxy.",
    });
  }

  const ensure: PreviewLoopbackForwarder["Service"]["ensure"] = Effect.fn(
    "desktop.preview.loopbackForward.ensure",
  )(function* (input) {
    const target = parseLoopbackPreviewTarget(input.url);
    if (target !== null && !input.environmentIsLoopback) {
      authByEnvironment.set(input.environmentId, {
        environmentId: input.environmentId,
        environmentIsLoopback: input.environmentIsLoopback,
        tunnelWebsocketUrl: input.tunnelWebsocketUrl,
      });
      lastRemoteEnvironmentId = input.environmentId;
    }
    const key = target ? tunnelKey(input.environmentId, target.port) : "";
    const hasOurTunnel = target !== null && tunnels.has(key);
    const decision = decideLoopbackForward({
      environmentIsLoopback: input.environmentIsLoopback,
      target,
      hasOurTunnel,
    });
    if (decision.kind === "not-applicable") {
      return { navigateUrl: input.url, kind: decision.kind };
    }
    // Stay on localhost so the page origin matches CORS allowlists. The
    // cmux-style localtest.me alias would change origin and break APIs.
    if (decision.kind === "reuse-tunnel") {
      return { navigateUrl: input.url, kind: decision.kind };
    }
    tunnels.set(key, {
      environmentId: input.environmentId,
      port: decision.port,
      tunnelWebsocketUrl: input.tunnelWebsocketUrl,
    });
    return { navigateUrl: input.url, kind: "start-tunnel" };
  });

  const ensureRelated: PreviewLoopbackForwarder["Service"]["ensureRelated"] = Effect.fn(
    "desktop.preview.loopbackForward.ensureRelated",
  )(function* (rawUrl) {
    const target = parseLoopbackPreviewTarget(previewRequestUrlToLoopbackTarget(rawUrl));
    if (target === null || lastRemoteEnvironmentId === undefined) {
      return { navigateUrl: rawUrl, kind: "not-applicable" };
    }
    const auth = authByEnvironment.get(lastRemoteEnvironmentId);
    if (auth === undefined) {
      return { navigateUrl: rawUrl, kind: "not-applicable" };
    }
    const tunnelWebsocketUrl = rewritePreviewTunnelPort(auth.tunnelWebsocketUrl, target.port);
    if (tunnelWebsocketUrl === null) {
      return { navigateUrl: rawUrl, kind: "not-applicable" };
    }
    return yield* ensure({
      environmentId: auth.environmentId,
      url: target.href,
      environmentIsLoopback: auth.environmentIsLoopback,
      tunnelWebsocketUrl,
    });
  });

  return PreviewLoopbackForwarder.of({ proxyPort, ensure, ensureRelated });
});

export const layer = Layer.effect(PreviewLoopbackForwarder, make);
