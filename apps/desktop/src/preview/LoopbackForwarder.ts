import { EnvironmentId } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
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

export const parsePreviewProxyDestination = (
  firstLine: string,
): { readonly host: string; readonly port: number } | null => {
  const connect = /^CONNECT\s+(\S+)\s+HTTP\//iu.exec(firstLine);
  if (connect?.[1] !== undefined) {
    return parseHostPort(connect[1]);
  }
  const absolute = /^[A-Z]+\s+(https?:\/\/\S+)\s+HTTP\//iu.exec(firstLine);
  if (absolute?.[1] === undefined) return null;
  try {
    const url = new URL(absolute[1]);
    const port =
      url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { host: url.hostname, port };
  } catch {
    return null;
  }
};

const parseHostPort = (value: string): { readonly host: string; readonly port: number } | null => {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end <= 1) return null;
    const host = value.slice(1, end);
    const portPart = value.slice(end + 1);
    if (!portPart.startsWith(":")) return null;
    const port = Number.parseInt(portPart.slice(1), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { host, port };
  }
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const port = Number.parseInt(value.slice(separator + 1), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: value.slice(0, separator), port };
};

export const rewriteHttpProxyRequest = (header: string): string => {
  const lines = header.split("\r\n");
  const requestLine = lines[0];
  if (requestLine === undefined) return header;
  const match = /^([A-Z]+)\s+(https?:\/\/\S+)\s+(HTTP\/\d(?:\.\d)?)$/iu.exec(requestLine);
  if (match === null) return header;
  try {
    const url = new URL(match[2] ?? "");
    lines[0] = `${match[1]} ${url.pathname}${url.search} ${match[3]}`;
    return lines.join("\r\n");
  } catch {
    return header;
  }
};

const readHttpHead = (socket: NodeNet.Socket) =>
  new Promise<{ readonly header: string; readonly rest: Buffer }>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffer.length > 65_536) {
          socket.off("data", onData);
          reject(new Error("Proxy request headers too large."));
        }
        return;
      }
      socket.off("data", onData);
      socket.off("error", onError);
      resolve({
        header: buffer.subarray(0, end).toString("utf8"),
        rest: buffer.subarray(end + 4),
      });
    };
    const onError = (cause: Error) => {
      socket.off("data", onData);
      reject(cause);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });

const connectLocal = (port: number) =>
  new Promise<NodeNet.Socket>((resolve, reject) => {
    const dest = NodeNet.createConnection({ host: "127.0.0.1", port });
    dest.once("connect", () => resolve(dest));
    dest.once("error", reject);
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

  const routeProxySocket = (socket: NodeNet.Socket) => {
    void (async () => {
      const { header, rest } = await readHttpHead(socket);
      const firstLine = header.split("\r\n")[0] ?? "";
      const destination = parsePreviewProxyDestination(firstLine);
      if (destination === null || !isLoopbackHost(destination.host)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const tunnelUrl = resolveTunnelUrl(destination.port);
      if (firstLine.toUpperCase().startsWith("CONNECT ")) {
        if (tunnelUrl !== null) {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          pipeLocalSocketToTunnel(socket, tunnelUrl, undefined, rest);
          return;
        }
        // A remote preview PAC always sends localhost here. Connecting to the
        // laptop port produces "connection refused" when the app is remote.
        if (lastRemoteEnvironmentId !== undefined) {
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
          return;
        }
        const dest = await connectLocal(destination.port);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) dest.write(rest);
        socket.pipe(dest);
        dest.pipe(socket);
        return;
      }
      const rewritten = Buffer.concat([
        Buffer.from(`${rewriteHttpProxyRequest(header)}\r\n\r\n`),
        rest,
      ]);
      if (tunnelUrl !== null) {
        pipeLocalSocketToTunnel(socket, tunnelUrl, undefined, rewritten);
        return;
      }
      if (lastRemoteEnvironmentId !== undefined) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        return;
      }
      const dest = await connectLocal(destination.port);
      dest.write(rewritten);
      socket.pipe(dest);
      dest.pipe(socket);
    })().catch(() => {
      socket.destroy();
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
