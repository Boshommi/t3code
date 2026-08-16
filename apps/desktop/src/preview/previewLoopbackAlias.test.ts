import { describe, expect, it } from "vite-plus/test";

import { rewriteAliasRequestHeaders, rewriteAliasResponseHeaders } from "./previewLoopbackAlias.ts";

describe("previewLoopbackAlias", () => {
  it("maps alias Host/Origin back to localhost for Next", () => {
    expect(
      rewriteAliasRequestHeaders(
        "GET /_next/foo.js HTTP/1.1\r\nHost: t3-loopback.localtest.me:3000\r\nOrigin: http://t3-loopback.localtest.me:3000",
      ),
    ).toBe("GET /_next/foo.js HTTP/1.1\r\nHost: localhost:3000\r\nOrigin: http://localhost:3000");
  });

  it("maps localhost Location back to the alias for Chromium", () => {
    expect(
      rewriteAliasResponseHeaders(
        "HTTP/1.1 308 Permanent Redirect\r\nLocation: http://localhost:3000/images/loading-indicator.gif",
      ),
    ).toBe(
      "HTTP/1.1 308 Permanent Redirect\r\nLocation: http://t3-loopback.localtest.me:3000/images/loading-indicator.gif",
    );
  });
});
