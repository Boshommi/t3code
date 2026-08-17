import { describe, expect, it } from "vite-plus/test";

import {
  absoluteProxyUrlToOriginPath,
  parsePreviewProxyDestination,
  rewriteHttpProxyRequest,
} from "./previewHttp.ts";

describe("previewHttp", () => {
  it("parses CONNECT and absolute-form destinations", () => {
    expect(parsePreviewProxyDestination("CONNECT localhost:5173 HTTP/1.1")).toEqual({
      host: "localhost",
      port: 5173,
    });
    expect(parsePreviewProxyDestination("GET http://127.0.0.1:3000/app HTTP/1.1")).toEqual({
      host: "127.0.0.1",
      port: 3000,
    });
    expect(
      parsePreviewProxyDestination("GET /_next/static/foo.js HTTP/1.1", "localhost:3000"),
    ).toEqual({ host: "localhost", port: 3000 });
  });

  it("rewrites absolute-form without closing keep-alive", () => {
    expect(
      rewriteHttpProxyRequest(
        "GET http://localhost:3000/app?x=1 HTTP/1.1\r\nHost: localhost:3000\r\nProxy-Connection: keep-alive",
      ),
    ).toBe("GET /app?x=1 HTTP/1.1\r\nHost: localhost:3000");
  });

  it("keeps the headers that carry framing and websocket upgrades", () => {
    expect(
      rewriteHttpProxyRequest(
        [
          "GET http://localhost:3000/_next/hmr HTTP/1.1",
          "Host: localhost:3000",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Transfer-Encoding: chunked",
          "Proxy-Authorization: Basic zzz",
        ].join("\r\n"),
      ),
    ).toBe(
      [
        "GET /_next/hmr HTTP/1.1",
        "Host: localhost:3000",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Transfer-Encoding: chunked",
      ].join("\r\n"),
    );
  });

  it("keeps percent-encoding so Next.js does not redirect-loop", () => {
    const encoded = "/_next/static/chunks/%5Broot-of-the-server%5D__04oy0md._.js";
    expect(absoluteProxyUrlToOriginPath(`http://localhost:3000${encoded}`)).toBe(encoded);
    expect(
      rewriteHttpProxyRequest(
        `GET http://localhost:3000${encoded} HTTP/1.1\r\nHost: localhost:3000`,
      ),
    ).toBe(`GET ${encoded} HTTP/1.1\r\nHost: localhost:3000`);
  });
});
