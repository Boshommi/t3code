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
  readonly kind: "not-applicable" | "reuse-tunnel" | "prefer-local" | "start-tunnel";
};

type TunnelEntry = {
  readonly environmentId: EnvironmentId;
  readonly port: number;
  readonly server: NodeNet.Server;
  readonly tunnelWebsocketUrl: string;
};

const tunnelKey = (environmentId: EnvironmentId, port: number) =>
  `${environmentId}:${String(port)}`;

const toSendableBytes = (buffer: Buffer): Uint8Array<ArrayBuffer> => {
  const payload = new Uint8Array(buffer.byteLength);
  payload.set(buffer);
  return payload;
};

const hasListenerOnLoopback = (port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(value));
    };
    socket.setTimeout(250);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    return Effect.sync(() => socket.destroy());
  });

export const pipeLocalSocketToTunnel = (
  local: NodeNet.Socket,
  tunnelWebsocketUrl: string,
  openWebSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
) => {
  const websocket = openWebSocket(tunnelWebsocketUrl);
  websocket.binaryType = "arraybuffer";
  const pending: Uint8Array<ArrayBuffer>[] = [];
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

export class PreviewLoopbackForwarder extends Context.Service<
  PreviewLoopbackForwarder,
  {
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

export const make = Effect.sync(() => {
  const tunnels = new Map<string, TunnelEntry>();
  const authByEnvironment = new Map<EnvironmentId, StoredTunnelAuth>();
  let lastRemoteEnvironmentId: EnvironmentId | undefined;

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
    const localPortHasListener =
      target === null ? false : yield* hasListenerOnLoopback(target.port);
    const decision = decideLoopbackForward({
      environmentIsLoopback: input.environmentIsLoopback,
      target,
      hasOurTunnel,
      localPortHasListener,
    });
    if (decision.kind === "not-applicable" || decision.kind === "prefer-local") {
      return { navigateUrl: input.url, kind: decision.kind };
    }
    if (decision.kind === "reuse-tunnel") {
      return { navigateUrl: input.url, kind: decision.kind };
    }

    const started = yield* listenOnLoopback(decision.port, (socket) => {
      pipeLocalSocketToTunnel(socket, input.tunnelWebsocketUrl);
    }).pipe(
      Effect.catch((error) => {
        const cause = error.cause;
        const code =
          typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
        if (code === "EADDRINUSE") {
          return Effect.succeed(null);
        }
        return Effect.fail(error);
      }),
    );
    if (started === null) {
      return { navigateUrl: input.url, kind: "prefer-local" };
    }
    tunnels.set(key, {
      environmentId: input.environmentId,
      port: decision.port,
      server: started,
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

  return PreviewLoopbackForwarder.of({ ensure, ensureRelated });
});

export const layer = Layer.effect(PreviewLoopbackForwarder, make);
