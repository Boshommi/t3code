import { describe, expect, it } from "vite-plus/test";

import {
  buildPreviewLoopbackPacScript,
  decideLoopbackForward,
  parseLoopbackPreviewTarget,
  parsePreviewTunnelPort,
  previewRequestUrlToLoopbackTarget,
  rewritePreviewTunnelPort,
} from "./previewLoopbackForward.ts";

describe("parseLoopbackPreviewTarget", () => {
  it("reads an explicit localhost port", () => {
    expect(parseLoopbackPreviewTarget("http://localhost:4000/app")).toEqual({
      href: "http://localhost:4000/app",
      port: 4000,
      protocol: "http:",
    });
  });

  it("defaults http loopback to port 80", () => {
    expect(parseLoopbackPreviewTarget("http://127.0.0.1/")).toMatchObject({ port: 80 });
  });

  it("rejects a public host", () => {
    expect(parseLoopbackPreviewTarget("https://example.com:4000")).toBeNull();
  });
});

describe("rewritePreviewTunnelPort", () => {
  it("keeps the ticket and swaps only the tunneled port", () => {
    expect(
      rewritePreviewTunnelPort(
        "wss://nuc.example.ts.net/preview-tunnel?wsTicket=abc&port=3000",
        5173,
      ),
    ).toBe("wss://nuc.example.ts.net/preview-tunnel?wsTicket=abc&port=5173");
  });

  it("rejects a URL that is not the preview tunnel", () => {
    expect(
      rewritePreviewTunnelPort("wss://nuc.example.ts.net/ws?wsTicket=abc&port=3000", 5173),
    ).toBe(null);
  });
});

describe("previewRequestUrlToLoopbackTarget", () => {
  it("maps a websocket iframe/HMR URL onto the same loopback port", () => {
    expect(previewRequestUrlToLoopbackTarget("ws://localhost:5173/@vite/client")).toBe(
      "http://localhost:5173/@vite/client",
    );
  });
});

describe("parsePreviewTunnelPort", () => {
  it("accepts a valid port query", () => {
    expect(parsePreviewTunnelPort(new URL("ws://127.0.0.1/preview-tunnel?port=4000"))).toBe(4000);
  });

  it.each(["0", "65536", "22a", "", "-1"])("rejects %s", (port) => {
    expect(
      parsePreviewTunnelPort(new URL(`ws://127.0.0.1/preview-tunnel?port=${port}`)),
    ).toBeNull();
  });
});

describe("buildPreviewLoopbackPacScript", () => {
  it("proxies only loopback hosts through the preview proxy", () => {
    const pac = buildPreviewLoopbackPacScript(43210);
    expect(pac).toContain('return "PROXY 127.0.0.1:43210"');
    expect(pac).toContain('return "DIRECT"');
    expect(pac).toContain('host === "localhost"');
  });
});

describe("decideLoopbackForward", () => {
  const target = { href: "http://localhost:4000/", port: 4000, protocol: "http:" as const };

  it("does nothing for a local environment", () => {
    expect(
      decideLoopbackForward({
        environmentIsLoopback: true,
        target,
        hasOurTunnel: false,
      }),
    ).toEqual({ kind: "not-applicable" });
  });

  it("reuses an existing T3 tunnel", () => {
    expect(
      decideLoopbackForward({
        environmentIsLoopback: false,
        target,
        hasOurTunnel: true,
      }),
    ).toEqual({ kind: "reuse-tunnel", port: 4000 });
  });

  it("starts a remote tunnel even if the same local port is busy", () => {
    expect(
      decideLoopbackForward({
        environmentIsLoopback: false,
        target,
        hasOurTunnel: false,
      }),
    ).toEqual({ kind: "start-tunnel", port: 4000 });
  });
});
