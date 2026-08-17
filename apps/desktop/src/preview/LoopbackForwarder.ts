import { EnvironmentId } from "@t3tools/contracts";
import {
  decideLoopbackForward,
  parseLoopbackPreviewTarget,
  previewRequestUrlToLoopbackTarget,
  rewritePreviewTunnelPort,
} from "@t3tools/shared/previewLoopbackForward";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { acceptSocks5Connect, isSocks5LoopbackHost, SOCKS5_REP, socks5Reply } from "./socks5.ts";

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

export const pipeLocalSocketToTunnel = (
  local: NodeNet.Socket,
  tunnelWebsocketUrl: string,
  openWebSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  initial?: Uint8Array,
) => {
  const websocket = openWebSocket(tunnelWebsocketUrl);
  websocket.binaryType = "arraybuffer";
  const pending: Uint8Array<ArrayBuffer>[] = [];
  if (initial !== undefined && initial.byteLength > 0) {
    pending.push(toSendableBytes(Buffer.from(initial)));
  }
  let opened = false;
  const closeBoth = () => {
    local.destroy();
    if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
      websocket.close();
    }
  };
  local.on("data", (buffer: Buffer) => {
    const payload = toSendableBytes(buffer);
    if (opened && websocket.readyState === WebSocket.OPEN) {
      websocket.send(payload);
      return;
    }
    pending.push(payload);
  });
  local.on("error", closeBoth);
  local.on("close", closeBoth);
  websocket.addEventListener("open", () => {
    opened = true;
    for (const payload of pending) {
      websocket.send(payload);
    }
    pending.length = 0;
  });
  websocket.addEventListener("message", (event) => {
    const payload = event.data;
    if (payload instanceof ArrayBuffer) {
      local.write(Buffer.from(payload));
      return;
    }
    if (typeof payload === "string") {
      local.write(payload);
    }
  });
  websocket.addEventListener("error", closeBoth);
  websocket.addEventListener("close", () => local.destroy());
  return { websocket, close: closeBoth };
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

const pipeSockets = (left: NodeNet.Socket, right: NodeNet.Socket, initial?: Buffer) => {
  if (initial !== undefined && initial.byteLength > 0) {
    right.write(initial);
  }
  left.pipe(right);
  right.pipe(left);
};

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

  const routeSocksSocket = (socket: NodeNet.Socket) => {
    void (async () => {
      const target = await acceptSocks5Connect(socket);
      if (!isSocks5LoopbackHost(target.host)) {
        const dest = await connectRemote(target.host, target.port);
        socket.write(socks5Reply(SOCKS5_REP.succeeded));
        pipeSockets(socket, dest, target.leftover);
        return;
      }
      const tunnelUrl = resolveTunnelUrl(target.port);
      if (tunnelUrl !== null) {
        socket.write(socks5Reply(SOCKS5_REP.succeeded));
        pipeLocalSocketToTunnel(socket, tunnelUrl, undefined, target.leftover);
        return;
      }
      if (lastRemoteEnvironmentId !== undefined) {
        socket.end(socks5Reply(SOCKS5_REP.hostUnreachable));
        return;
      }
      const dest = await connectLocal(target.port);
      socket.write(socks5Reply(SOCKS5_REP.succeeded));
      pipeSockets(socket, dest, target.leftover);
    })().catch(() => {
      if (!socket.destroyed) {
        socket.end(socks5Reply(SOCKS5_REP.generalFailure));
      }
    });
  };

  const proxyServer = yield* listenOnLoopback(0, routeSocksSocket);
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
