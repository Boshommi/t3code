import { EnvironmentId } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";

import { decideLoopbackForward } from "@t3tools/shared/previewLoopbackForward";

import { make, pipeLocalSocketToTunnel } from "./LoopbackForwarder.ts";

const listen = (port: number) =>
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen({ host: "127.0.0.1", port }, () => resume(Effect.succeed(server)));
    return Effect.sync(() => {
      server.close();
    });
  });

const socksConnect = (proxyPort: number, host: string, port: number) =>
  new Promise<NodeNet.Socket>((resolve, reject) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port: proxyPort }, () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let phase: "greeting" | "reply" = "greeting";
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === "greeting") {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
          socket.off("data", onData);
          reject(new Error("SOCKS5 greeting was rejected."));
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(2);
        phase = "reply";
        const name = Buffer.from(host, "utf8");
        const request = Buffer.alloc(7 + name.length);
        request[0] = 0x05;
        request[1] = 0x01;
        request[3] = 0x03;
        request[4] = name.length;
        name.copy(request, 5);
        request.writeUInt16BE(port, 5 + name.length);
        socket.write(request);
      }
      if (phase === "reply") {
        if (buffer.length < 10) return;
        if (buffer[1] !== 0x00) {
          socket.off("data", onData);
          reject(new Error(`SOCKS5 CONNECT failed: ${String(buffer[1])}`));
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(10);
        socket.off("data", onData);
        if (buffer.length > 0) {
          socket.unshift(buffer);
        }
        resolve(socket);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });

const httpGet = (socket: NodeNet.Socket, host: string, path: string, connection: string) => {
  socket.write(
    [`GET ${path} HTTP/1.1`, `Host: ${host}`, `Connection: ${connection}`, "", ""].join("\r\n"),
  );
};

const readHttpResponse = (socket: NodeNet.Socket) =>
  new Promise<{ readonly status: string; readonly headers: string; readonly body: Buffer }>(
    (resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const split = buffer.indexOf("\r\n\r\n");
        if (split === -1) return;
        const headers = buffer.subarray(0, split).toString("utf8");
        const bodyStart = buffer.subarray(split + 4);
        const lengthMatch = /content-length:\s*(\d+)/iu.exec(headers);
        if (lengthMatch) {
          const length = Number(lengthMatch[1]);
          if (bodyStart.length < length) return;
          socket.off("data", onData);
          socket.off("error", onError);
          resolve({
            status: headers.split("\r\n")[0] ?? "",
            headers,
            body: bodyStart.subarray(0, length),
          });
          return;
        }
        if (/transfer-encoding:\s*chunked/iu.test(headers)) {
          if (!chunkedComplete(bodyStart)) return;
          socket.off("data", onData);
          socket.off("error", onError);
          resolve({
            status: headers.split("\r\n")[0] ?? "",
            headers,
            body: decodeChunked(bodyStart),
          });
        }
      };
      const onError = (cause: Error) => {
        socket.off("data", onData);
        reject(cause);
      };
      socket.on("data", onData);
      socket.once("error", onError);
    },
  );

const chunkedComplete = (body: Buffer): boolean => {
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) return false;
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString("utf8"), 16);
    if (!Number.isInteger(size)) return false;
    if (size === 0) {
      return (
        body.indexOf("\r\n\r\n", lineEnd) !== -1 ||
        body.subarray(lineEnd).equals(Buffer.from("\r\n\r\n"))
      );
    }
    const dataStart = lineEnd + 2;
    const dataEnd = dataStart + size + 2;
    if (body.length < dataEnd) return false;
    offset = dataEnd;
  }
  return false;
};

const decodeChunked = (body: Buffer): Buffer => {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString("utf8"), 16);
    if (size === 0) break;
    const dataStart = lineEnd + 2;
    parts.push(body.subarray(dataStart, dataStart + size));
    offset = dataStart + size + 2;
  }
  return Buffer.concat(parts);
};

describe("PreviewLoopbackForwarder", () => {
  effectIt.effect("listens for a SOCKS5 preview proxy", () =>
    Effect.gen(function* () {
      const forwarder = yield* make;
      expect(forwarder.proxyPort).toBeGreaterThan(0);
    }),
  );

  effectIt.effect("tunnels to the remote port even when the same local port is busy", () =>
    Effect.gen(function* () {
      const occupied = yield* listen(0);
      const address = occupied.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const forwarder = yield* make;
      const result = yield* forwarder.ensure({
        environmentId: EnvironmentId.make("env-1"),
        url: `http://localhost:${String(port)}/app`,
        environmentIsLoopback: false,
        tunnelWebsocketUrl: "ws://127.0.0.1:9/preview-tunnel?wsTicket=ticket&port=1",
      });
      expect(result).toEqual({
        navigateUrl: `http://localhost:${String(port)}/app`,
        kind: "start-tunnel",
      });
      occupied.close();
    }),
  );

  effectIt.effect("starts a same-port tunnel when the local port is free", () =>
    Effect.gen(function* () {
      const probe = yield* listen(0);
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close();
      const forwarder = yield* make;
      const result = yield* forwarder.ensure({
        environmentId: EnvironmentId.make("env-1"),
        url: `http://localhost:${String(port)}/`,
        environmentIsLoopback: false,
        tunnelWebsocketUrl: "ws://127.0.0.1:9/preview-tunnel?wsTicket=ticket&port=1",
      });
      expect(result.kind).toBe("start-tunnel");
      const reuse = yield* forwarder.ensure({
        environmentId: EnvironmentId.make("env-1"),
        url: `http://localhost:${String(port)}/`,
        environmentIsLoopback: false,
        tunnelWebsocketUrl: "ws://127.0.0.1:9/preview-tunnel?wsTicket=ticket&port=1",
      });
      expect(reuse.kind).toBe("reuse-tunnel");
      const claimed = yield* listen(port);
      expect(typeof claimed.address() === "object").toBe(true);
      claimed.close();
    }),
  );

  effectIt.effect("opens a second same-port tunnel for an iframe localhost URL", () =>
    Effect.gen(function* () {
      const firstProbe = yield* listen(0);
      const firstAddress = firstProbe.address();
      const firstPort =
        typeof firstAddress === "object" && firstAddress !== null ? firstAddress.port : 0;
      firstProbe.close();
      const secondProbe = yield* listen(0);
      const secondAddress = secondProbe.address();
      const secondPort =
        typeof secondAddress === "object" && secondAddress !== null ? secondAddress.port : 0;
      secondProbe.close();
      const forwarder = yield* make;
      yield* forwarder.ensure({
        environmentId: EnvironmentId.make("env-1"),
        url: `http://localhost:${String(firstPort)}/`,
        environmentIsLoopback: false,
        tunnelWebsocketUrl: `ws://127.0.0.1:9/preview-tunnel?wsTicket=ticket&port=${String(firstPort)}`,
      });
      const related = yield* forwarder.ensureRelated(`http://localhost:${String(secondPort)}/app`);
      expect(related.kind).toBe("start-tunnel");
      const websocket = yield* forwarder.ensureRelated(
        `ws://localhost:${String(secondPort)}/@vite/client`,
      );
      expect(websocket.kind).toBe("reuse-tunnel");
    }),
  );

  effectIt.effect("ignores related localhost requests before any remote tunnel exists", () =>
    Effect.gen(function* () {
      const forwarder = yield* make;
      const result = yield* forwarder.ensureRelated("http://localhost:5173/");
      expect(result.kind).toBe("not-applicable");
    }),
  );

  it("always starts a remote tunnel from the in-app preview", () => {
    expect(
      decideLoopbackForward({
        environmentIsLoopback: false,
        target: { href: "http://localhost:4000/", port: 4000, protocol: "http:" },
        hasOurTunnel: false,
      }).kind,
    ).toBe("start-tunnel");
  });

  effectIt.effect("does not occupy the preview port for the default browser", () =>
    Effect.gen(function* () {
      const probe = yield* listen(0);
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close();
      const forwarder = yield* make;
      yield* forwarder.ensure({
        environmentId: EnvironmentId.make("env-1"),
        url: `http://localhost:${String(port)}/`,
        environmentIsLoopback: false,
        tunnelWebsocketUrl: `ws://127.0.0.1:9/preview-tunnel?wsTicket=ticket&port=${String(port)}`,
      });
      const refused = yield* Effect.callback<boolean>((resume) => {
        const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
        socket.once("error", (error) =>
          resume(Effect.succeed("code" in error && error.code === "ECONNREFUSED")),
        );
        socket.once("connect", () => {
          socket.destroy();
          resume(Effect.succeed(false));
        });
        return Effect.sync(() => socket.destroy());
      });
      expect(refused).toBe(true);
    }),
  );

  effectIt.effect("forwards origin-form HTTP through SOCKS without rewriting paths", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const origin = yield* Effect.callback<NodeNet.Server>((resume) => {
        const server = NodeNet.createServer((socket) => {
          let buffer = "";
          socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            if (!buffer.includes("\r\n\r\n")) return;
            seen.push(buffer.split("\r\n")[0] ?? "");
            socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
          });
        });
        server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.succeed(server)));
        return Effect.sync(() => {
          server.close();
        });
      });
      const address = origin.address();
      const originPort = typeof address === "object" && address !== null ? address.port : 0;
      const forwarder = yield* make;
      const encoded = `/_next/static/chunks/%5Broot-of-the-server%5D__04oy0md._.js`;
      const socket = yield* Effect.tryPromise(() =>
        socksConnect(forwarder.proxyPort, "127.0.0.1", originPort),
      );
      httpGet(socket, `127.0.0.1:${String(originPort)}`, encoded, "close");
      const response = yield* Effect.tryPromise(() => readHttpResponse(socket));
      socket.end();
      expect(seen[0]).toBe(`GET ${encoded} HTTP/1.1`);
      expect(response.status).toBe("HTTP/1.1 200 OK");
      expect(response.body.toString("utf8")).toBe("ok");
    }),
  );

  effectIt.effect("keeps Next :3000 HTML and keep-alive /_next assets complete", () =>
    Effect.gen(function* () {
      const forwarder = yield* make;
      const socket = yield* Effect.tryPromise(() =>
        socksConnect(forwarder.proxyPort, "localhost", 3000),
      );
      httpGet(socket, "localhost:3000", "/", "keep-alive");
      const page = yield* Effect.tryPromise(() => readHttpResponse(socket));
      expect(page.status).toBe("HTTP/1.1 200 OK");
      expect(page.headers).not.toMatch(/308/);
      expect(page.body.includes(Buffer.from("</html>"))).toBe(true);
      expect(page.body.byteLength).toBeGreaterThan(1_000);

      httpGet(
        socket,
        "localhost:3000",
        "/_next/static/chunks/src_lib_ui_suisseintl_fb5dd8da_module_1mdjsv5.css",
        "keep-alive",
      );
      const css = yield* Effect.tryPromise(() => readHttpResponse(socket));
      expect(css.status).toBe("HTTP/1.1 200 OK");
      expect(css.headers).not.toMatch(/308/);

      httpGet(
        socket,
        "localhost:3000",
        "/_next/static/chunks/%5Broot-of-the-server%5D__04oy0md._.js",
        "close",
      );
      const js = yield* Effect.tryPromise(() => readHttpResponse(socket));
      socket.end();
      expect(js.status).toBe("HTTP/1.1 200 OK");
      expect(js.headers).not.toMatch(/308/);
      expect(js.body.byteLength).toBeGreaterThan(0);
    }),
  );

  it("closes both sides when the tunnel websocket errors", () => {
    const local = new NodeNet.Socket();
    const fake = {
      binaryType: "arraybuffer",
      readyState: 0,
      send() {},
      close() {
        this.readyState = 3;
      },
      addEventListener(type: string, listener: () => void) {
        if (type === "error") {
          listener();
        }
      },
    };
    pipeLocalSocketToTunnel(
      local,
      "ws://127.0.0.1:9/preview-tunnel",
      () => fake as unknown as WebSocket,
    );
    expect(fake.readyState).toBe(3);
  });
});
