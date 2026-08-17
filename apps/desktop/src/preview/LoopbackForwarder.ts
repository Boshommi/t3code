import { EnvironmentId } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import {
  buildPreviewLoopbackPacScript,
  decideLoopbackForward,
  parseLoopbackPreviewTarget,
  PREVIEW_LOOPBACK_PAC_PATH,
  previewLoopbackPacScriptUrl,
  previewRequestUrlToLoopbackTarget,
  rewritePreviewTunnelPort,
} from "@t3tools/shared/previewLoopbackForward";
import * as NodeHttp from "node:http";
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
  options?: { readonly forwardClientData?: boolean },
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
  if (options?.forwardClientData !== false) {
    local.on("data", (buffer: Buffer) => {
      const payload = toSendableBytes(buffer);
      if (opened && websocket.readyState === WebSocket.OPEN) {
        websocket.send(payload);
        return;
      }
      pending.push(payload);
    });
  }
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
  hostHeader?: string,
): { readonly host: string; readonly port: number } | null => {
  const connect = /^CONNECT\s+(\S+)\s+HTTP\//iu.exec(firstLine);
  if (connect?.[1] !== undefined) {
    return parseHostPort(connect[1]);
  }
  const absolute = /^[A-Z]+\s+(https?:\/\/\S+)\s+HTTP\//iu.exec(firstLine);
  if (absolute?.[1] !== undefined) {
    try {
      const url = new URL(absolute[1]);
      const port =
        url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
      return { host: url.hostname, port };
    } catch {
      return null;
    }
  }
  const originForm = /^[A-Z]+\s+(\/[^ ]*)\s+HTTP\//iu.exec(firstLine);
  if (originForm !== null && hostHeader !== undefined && hostHeader.length > 0) {
    return parseHostPort(hostHeader) ?? parseHostPort(`${hostHeader}:80`);
  }
  return null;
};

const readHeaderValue = (header: string, name: string): string | undefined => {
  const match = new RegExp(`(?:^|\\r\\n)${name}\\s*:\\s*([^\\r\\n]+)`, "iu").exec(header);
  const value = match?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
};

/** Keep %XX encoding. `URL.pathname` decodes and Next.js then 3xx-loops. */
export const absoluteProxyUrlToOriginPath = (absoluteUrl: string): string | null => {
  const stripped = absoluteUrl.replace(/^https?:\/\//iu, "");
  if (stripped === absoluteUrl) return null;
  const pathStart = stripped.indexOf("/");
  if (pathStart === -1) {
    const queryStart = stripped.indexOf("?");
    return queryStart === -1 ? "/" : `/${stripped.slice(queryStart)}`;
  }
  return stripped.slice(pathStart);
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

const HOP_BY_HOP_HEADER =
  /^(proxy-connection|proxy-authorization|connection|keep-alive|te|trailer|transfer-encoding|upgrade)$/iu;

export const rewriteHttpProxyRequest = (header: string): string => {
  const lines = header.split("\r\n");
  const requestLine = lines[0];
  if (requestLine === undefined) return header;
  const match = /^([A-Z]+)\s+(https?:\/\/\S+)\s+(HTTP\/\d(?:\.\d)?)$/iu.exec(requestLine);
  if (match !== null) {
    const originPath = absoluteProxyUrlToOriginPath(match[2] ?? "");
    if (originPath !== null) {
      lines[0] = `${match[1]} ${originPath} ${match[3]}`;
    }
  }
  const forwarded = lines.filter(
    (line, index) =>
      index === 0 ||
      line.length === 0 ||
      !HOP_BY_HOP_HEADER.test((line.split(":", 1)[0] ?? "").trim()),
  );
  const withoutEmpty = forwarded.filter((line) => line.length > 0);
  withoutEmpty.push("Connection: close");
  return withoutEmpty.join("\r\n");
};

const contentLengthOf = (header: string): number => {
  const raw = readHeaderValue(header, "content-length");
  if (raw === undefined) return 0;
  const length = Number.parseInt(raw, 10);
  return Number.isInteger(length) && length > 0 ? length : 0;
};

const writeHttpProxyRequest = (
  dest: NodeNet.Socket,
  client: NodeNet.Socket,
  header: string,
  rest: Buffer,
) => {
  dest.write(Buffer.concat([Buffer.from(`${rewriteHttpProxyRequest(header)}\r\n\r\n`), rest]));
  dest.pipe(client);
  let remaining = Math.max(0, contentLengthOf(header) - rest.length);
  if (remaining === 0) {
    return;
  }
  const onData = (chunk: Buffer) => {
    const take = chunk.subarray(0, remaining);
    dest.write(take);
    remaining -= take.byteLength;
    if (remaining === 0) {
      client.off("data", onData);
    }
  };
  client.on("data", onData);
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

const connectRemote = (host: string, port: number) =>
  new Promise<NodeNet.Socket>((resolve, reject) => {
    const dest = NodeNet.createConnection({ host, port });
    dest.once("connect", () => resolve(dest));
    dest.once("error", reject);
  });

export class PreviewLoopbackForwarder extends Context.Service<
  PreviewLoopbackForwarder,
  {
    readonly proxyPort: number;
    readonly pacScriptUrl: string;
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
      const destination = parsePreviewProxyDestination(firstLine, readHeaderValue(header, "host"));
      if (destination === null) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      if (!isLoopbackHost(destination.host)) {
        const dest = await connectRemote(destination.host, destination.port);
        if (firstLine.toUpperCase().startsWith("CONNECT ")) {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length > 0) dest.write(rest);
          socket.pipe(dest);
          dest.pipe(socket);
          return;
        }
        writeHttpProxyRequest(dest, socket, header, rest);
        return;
      }
      const tunnelUrl = resolveTunnelUrl(destination.port);
      if (firstLine.toUpperCase().startsWith("CONNECT ")) {
        if (tunnelUrl !== null) {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          pipeLocalSocketToTunnel(socket, tunnelUrl, undefined, rest, {
            forwardClientData: true,
          });
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
        pipeLocalSocketToTunnel(socket, tunnelUrl, undefined, rewritten, {
          forwardClientData: false,
        });
        return;
      }
      if (lastRemoteEnvironmentId !== undefined) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        return;
      }
      const dest = await connectLocal(destination.port);
      writeHttpProxyRequest(dest, socket, header, rest);
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

  // Chromium 141+ ignores data: PAC URLs ("request PAC script but do not
  // specify its URL") and falls back to DIRECT — the Mac connection-refused
  // failure. Serve the PAC over loopback HTTP so setProxy has a real URL.
  const pacServer = yield* Effect.callback<NodeHttp.Server, PreviewLoopbackForwardError>(
    (resume) => {
      const server = NodeHttp.createServer((request, response) => {
        const path = request.url === undefined ? "" : (request.url.split("?")[0] ?? "");
        if (request.method !== "GET" || path !== PREVIEW_LOOPBACK_PAC_PATH) {
          response.writeHead(404);
          response.end();
          return;
        }
        const address = server.address();
        const pacPort = typeof address === "object" && address !== null ? address.port : 0;
        const body = buildPreviewLoopbackPacScript(proxyPort, previewLoopbackPacScriptUrl(pacPort));
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/x-ns-proxy-autoconfig",
        });
        response.end(body);
      });
      let settled = false;
      server.once("error", (cause) => {
        if (settled) return;
        settled = true;
        resume(
          Effect.fail(
            new PreviewLoopbackForwardError({
              detail: "Could not listen for the preview PAC script.",
              cause,
            }),
          ),
        );
      });
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(server));
      });
      return Effect.sync(() => {
        server.close();
      });
    },
  );
  const pacAddress = pacServer.address();
  const pacPort = typeof pacAddress === "object" && pacAddress !== null ? pacAddress.port : 0;
  if (pacPort === 0) {
    return yield* new PreviewLoopbackForwardError({
      detail: "Could not listen for the preview PAC script.",
    });
  }
  const pacScriptUrl = previewLoopbackPacScriptUrl(pacPort);

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

  return PreviewLoopbackForwarder.of({ proxyPort, pacScriptUrl, ensure, ensureRelated });
});

export const layer = Layer.effect(PreviewLoopbackForwarder, make);
