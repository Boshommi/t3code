// @effect-diagnostics nodeBuiltinImport:off - Exercises the raw HTTP client against real Node servers.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPreviewLoopbackRequestHeaders,
  fetchPreviewLoopback,
  parsePreviewLoopbackHttpTarget,
  parsePreviewSetCookie,
  PreviewLoopbackAgent,
  type PreviewLoopbackConnect,
} from "./previewLoopbackHttp.ts";

describe("parsePreviewLoopbackHttpTarget", () => {
  it("accepts loopback http URLs and keeps the raw origin-form path", () => {
    expect(
      parsePreviewLoopbackHttpTarget(
        "http://localhost:3000/_next/static/chunks/%5Broot-of-the-server%5D__04oy0md._.js",
      ),
    ).toEqual({
      host: "localhost",
      port: 3000,
      path: "/_next/static/chunks/%5Broot-of-the-server%5D__04oy0md._.js",
    });
    expect(parsePreviewLoopbackHttpTarget("http://127.0.0.1:5173/app?x=%20y")).toEqual({
      host: "127.0.0.1",
      port: 5173,
      path: "/app?x=%20y",
    });
    expect(parsePreviewLoopbackHttpTarget("http://[::1]:8080/")).toEqual({
      host: "[::1]",
      port: 8080,
      path: "/",
    });
    expect(parsePreviewLoopbackHttpTarget("http://localhost/")).toEqual({
      host: "localhost",
      port: 80,
      path: "/",
    });
  });

  it("rejects https, non-loopback hosts, and unparseable URLs", () => {
    expect(parsePreviewLoopbackHttpTarget("https://localhost:3000/")).toBeNull();
    expect(parsePreviewLoopbackHttpTarget("http://example.com/")).toBeNull();
    expect(parsePreviewLoopbackHttpTarget("http://192.168.1.20:3000/")).toBeNull();
    expect(parsePreviewLoopbackHttpTarget("not a url")).toBeNull();
  });
});

describe("buildPreviewLoopbackRequestHeaders", () => {
  it("strips transport headers and rebuilds the browser-shaped set", () => {
    const headers = buildPreviewLoopbackRequestHeaders({
      headers: [
        ["Accept", "text/html"],
        ["Connection", "keep-alive"],
        ["Accept-Encoding", "zstd"],
        ["User-Agent", "probe"],
      ],
      hostHeader: "localhost:3000",
      method: "GET",
      referrer: "",
      cookieHeader: "",
      acceptLanguage: "en-US,en;q=0.9",
    });
    expect(headers).toEqual({
      accept: "text/html",
      "user-agent": "probe",
      host: "localhost:3000",
      "accept-encoding": "gzip, deflate, br",
      "accept-language": "en-US,en;q=0.9",
    });
  });

  it("synthesizes Referer and Origin the way a direct browser connection would", () => {
    const post = buildPreviewLoopbackRequestHeaders({
      headers: [],
      hostHeader: "localhost:3000",
      method: "POST",
      referrer: "http://localhost:3000/app",
      cookieHeader: "",
      acceptLanguage: undefined,
    });
    expect(post["referer"]).toBe("http://localhost:3000/app");
    expect(post["origin"]).toBe("http://localhost:3000");

    // Same-origin GETs carry no Origin, matching real browsers.
    const sameOriginGet = buildPreviewLoopbackRequestHeaders({
      headers: [],
      hostHeader: "localhost:3000",
      method: "GET",
      referrer: "http://localhost:3000/app",
      cookieHeader: "",
      acceptLanguage: undefined,
    });
    expect(sameOriginGet["origin"]).toBeUndefined();

    // Cross-origin GETs carry the initiating origin so CORS middlewares
    // (which key their response headers on it) still engage.
    const crossOriginGet = buildPreviewLoopbackRequestHeaders({
      headers: [],
      hostHeader: "localhost:3000",
      method: "GET",
      referrer: "http://localhost:5173/",
      cookieHeader: "",
      acceptLanguage: undefined,
    });
    expect(crossOriginGet["origin"]).toBe("http://localhost:5173");

    // A POST with no known initiator claims the target's own origin so
    // same-origin CSRF checks (Next.js server actions) still pass.
    const bareposts = buildPreviewLoopbackRequestHeaders({
      headers: [],
      hostHeader: "localhost:3000",
      method: "POST",
      referrer: "",
      cookieHeader: "",
      acceptLanguage: undefined,
    });
    expect(bareposts["origin"]).toBe("http://localhost:3000");
  });

  it("attaches jar cookies without overriding an explicit Cookie header", () => {
    const fromJar = buildPreviewLoopbackRequestHeaders({
      headers: [],
      hostHeader: "localhost:3000",
      method: "GET",
      referrer: "",
      cookieHeader: "a=1; b=2",
      acceptLanguage: undefined,
    });
    expect(fromJar["cookie"]).toBe("a=1; b=2");
    const explicit = buildPreviewLoopbackRequestHeaders({
      headers: [["Cookie", "explicit=1"]],
      hostHeader: "localhost:3000",
      method: "GET",
      referrer: "",
      cookieHeader: "a=1",
      acceptLanguage: undefined,
    });
    expect(explicit["cookie"]).toBe("explicit=1");
  });
});

describe("parsePreviewSetCookie", () => {
  const now = 1_700_000_000;

  it("parses names, values, and the attributes Electron's jar understands", () => {
    expect(
      parsePreviewSetCookie("session=abc; Path=/app; HttpOnly; Secure; SameSite=Lax", now),
    ).toEqual({
      name: "session",
      value: "abc",
      path: "/app",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: undefined,
      expired: false,
    });
    expect(parsePreviewSetCookie("k=v; SameSite=None", now)?.sameSite).toBe("no_restriction");
    expect(parsePreviewSetCookie("k=v; Max-Age=60", now)?.expirationDate).toBe(now + 60);
  });

  it("flags deletions from Max-Age <= 0 and past Expires", () => {
    expect(parsePreviewSetCookie("k=; Max-Age=0", now)?.expired).toBe(true);
    expect(parsePreviewSetCookie("k=v; Expires=Thu, 01 Jan 1970 00:00:00 GMT", now)?.expired).toBe(
      true,
    );
    // Max-Age wins over a future Expires.
    const both = parsePreviewSetCookie(
      "k=v; Max-Age=0; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
      now,
    );
    expect(both?.expired).toBe(true);
  });

  it("rejects header values without a name", () => {
    expect(parsePreviewSetCookie("=bare", now)).toBeNull();
    expect(parsePreviewSetCookie("no-equals-sign", now)).toBeNull();
  });
});

/**
 * A Duplex with the same shape as the preview tunnel's websocket duplex: not a
 * net.Socket, no TCP knobs. Exercises the agent-socket shims end to end.
 */
const tunnelLikeConnect =
  (connections?: { count: number }): PreviewLoopbackConnect =>
  (_host, port) =>
    new Promise((resolve, reject) => {
      const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
      socket.once("error", reject);
      socket.once("connect", () => {
        if (connections !== undefined) connections.count += 1;
        const duplex = new NodeStream.Duplex({
          write(chunk, _encoding, callback) {
            socket.write(chunk, callback);
          },
          final(callback) {
            socket.end();
            callback();
          },
          read() {},
        });
        socket.on("data", (chunk) => duplex.push(chunk));
        socket.on("end", () => duplex.push(null));
        socket.on("error", (cause) => duplex.destroy(cause));
        duplex.on("close", () => socket.destroy());
        resolve(duplex);
      });
    });

const listenHttp = (handler: NodeHttp.RequestListener) =>
  new Promise<{ server: NodeHttp.Server; port: number }>((resolve) => {
    const server = NodeHttp.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address !== null ? address.port : 0 });
    });
  });

const readAll = (stream: NodeStream.Readable): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

describe("fetchPreviewLoopback over a tunnel-shaped duplex", () => {
  it("speaks origin-form, preserves percent-encoding, and reuses the tunnel connection", async () => {
    const requestUrls: string[] = [];
    const { server, port } = await listenHttp((req, res) => {
      requestUrls.push(req.url ?? "");
      res.setHeader("Content-Type", "text/plain");
      res.end(`OK:${req.url ?? ""}`);
    });
    const tcpConnections = { count: 0 };
    server.on("connection", () => undefined);
    const agent = new PreviewLoopbackAgent(tunnelLikeConnect(tcpConnections));
    try {
      const target = { host: "localhost", port, path: "/enc/%5Bx%5D.js" };
      const first = await fetchPreviewLoopback({
        target,
        method: "GET",
        headers: { host: `localhost:${port}` },
        body: null,
        signal: undefined,
        agent,
      });
      expect(first.status).toBe(200);
      expect((await readAll(first.body!)).toString()).toBe("OK:/enc/%5Bx%5D.js");
      const second = await fetchPreviewLoopback({
        target: { ...target, path: "/second" },
        method: "GET",
        headers: { host: `localhost:${port}` },
        body: null,
        signal: undefined,
        agent,
      });
      expect((await readAll(second.body!)).toString()).toBe("OK:/second");
      expect(requestUrls).toEqual(["/enc/%5Bx%5D.js", "/second"]);
      // Keep-alive means both requests shared one tunnel circuit.
      expect(tcpConnections.count).toBe(1);
    } finally {
      agent.destroy();
      server.close();
    }
  });

  it("decodes gzip bodies and strips the encoding headers for the renderer", async () => {
    const { server, port } = await listenHttp((req, res) => {
      expect(req.headers["accept-encoding"]).toBe("gzip, deflate, br");
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Content-Encoding", "gzip");
      res.end(NodeZlib.gzipSync(Buffer.from("GZIP-DECODED-OK")));
    });
    const agent = new PreviewLoopbackAgent(tunnelLikeConnect());
    try {
      const result = await fetchPreviewLoopback({
        target: { host: "localhost", port, path: "/gzip" },
        method: "GET",
        headers: { host: `localhost:${port}`, "accept-encoding": "gzip, deflate, br" },
        body: null,
        signal: undefined,
        agent,
      });
      expect((await readAll(result.body!)).toString()).toBe("GZIP-DECODED-OK");
      expect(result.headers.get("content-encoding")).toBeNull();
      expect(result.headers.get("content-length")).toBeNull();
      expect(result.headers.get("content-type")).toBe("text/plain");
    } finally {
      agent.destroy();
      server.close();
    }
  });

  it("returns redirects and 304s to the renderer instead of consuming them", async () => {
    const { server, port } = await listenHttp((req, res) => {
      if (req.url === "/redir") {
        res.statusCode = 308;
        res.setHeader("Location", "/target");
        res.end();
        return;
      }
      res.statusCode = 304;
      res.setHeader("ETag", '"v1"');
      res.end();
    });
    const agent = new PreviewLoopbackAgent(tunnelLikeConnect());
    try {
      const redirect = await fetchPreviewLoopback({
        target: { host: "localhost", port, path: "/redir" },
        method: "GET",
        headers: { host: `localhost:${port}` },
        body: null,
        signal: undefined,
        agent,
      });
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get("location")).toBe("/target");
      const cached = await fetchPreviewLoopback({
        target: { host: "localhost", port, path: "/etag" },
        method: "GET",
        headers: { host: `localhost:${port}`, "if-none-match": '"v1"' },
        body: null,
        signal: undefined,
        agent,
      });
      expect(cached.status).toBe(304);
      expect(cached.body).toBeNull();
      expect(cached.headers.get("etag")).toBe('"v1"');
    } finally {
      agent.destroy();
      server.close();
    }
  });

  it("streams request bodies and exposes Set-Cookie separately from renderer headers", async () => {
    const { server, port } = await listenHttp((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.setHeader("Set-Cookie", ["a=1; Path=/", "b=2"]);
        res.setHeader("Content-Type", "text/plain");
        res.end(`ECHO:${Buffer.concat(chunks).toString()}`);
      });
    });
    const agent = new PreviewLoopbackAgent(tunnelLikeConnect());
    try {
      const result = await fetchPreviewLoopback({
        target: { host: "localhost", port, path: "/post-echo" },
        method: "POST",
        headers: { host: `localhost:${port}` },
        body: NodeStream.Readable.from([Buffer.from("hello-"), Buffer.from("body")]),
        signal: undefined,
        agent,
      });
      expect((await readAll(result.body!)).toString()).toBe("ECHO:hello-body");
      expect(result.setCookies).toEqual(["a=1; Path=/", "b=2"]);
      expect(result.headers.get("set-cookie")).toBeNull();
    } finally {
      agent.destroy();
      server.close();
    }
  });

  it("destroys the upstream request when the renderer aborts", async () => {
    let upstreamClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const { server, port } = await listenHttp((_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write("data: first\n\n");
      res.on("close", () => upstreamClosed?.());
    });
    const agent = new PreviewLoopbackAgent(tunnelLikeConnect());
    try {
      const controller = new AbortController();
      const result = await fetchPreviewLoopback({
        target: { host: "localhost", port, path: "/sse" },
        method: "GET",
        headers: { host: `localhost:${port}` },
        body: null,
        signal: controller.signal,
        agent,
      });
      const firstChunk = new Promise<void>((resolve) => {
        result.body!.once("data", () => resolve());
      });
      await firstChunk;
      controller.abort();
      await closed;
    } finally {
      agent.destroy();
      server.close();
    }
  });

  it("rejects when the tunnel cannot be opened", async () => {
    const agent = new PreviewLoopbackAgent(() => Promise.reject(new Error("tunnel is down")));
    await expect(
      fetchPreviewLoopback({
        target: { host: "localhost", port: 3000, path: "/" },
        method: "GET",
        headers: { host: "localhost:3000" },
        body: null,
        signal: undefined,
        agent,
      }),
    ).rejects.toThrow("tunnel is down");
    agent.destroy();
  });
});
