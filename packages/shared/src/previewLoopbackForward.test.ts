import { describe, expect, it } from "vite-plus/test";

import {
  decideLoopbackForward,
  parseLoopbackPreviewTarget,
  parsePreviewTunnelPort,
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

describe("decideLoopbackForward", () => {
  const target = { href: "http://localhost:4000/", port: 4000, protocol: "http:" as const };

  it("does nothing for a local environment", () => {
    expect(
      decideLoopbackForward({
        environmentIsLoopback: true,
        target,
        hasOurTunnel: false,
        localPortHasListener: false,
      }),
    ).toEqual({ kind: "not-applicable" });
  });

  it("reuses an existing T3 tunnel before probing the local app", () => {
    expect(
      decideLoopbackForward({
        environmentIsLoopback: false,
        target,
        hasOurTunnel: true,
        localPortHasListener: true,
      }),
    ).toEqual({ kind: "reuse-tunnel", port: 4000 });
  });

  it("prefers a local listener when both machines have the same port", () => {
    expect(
      decideLoopbackForward({
        environmentIsLoopback: false,
        target,
        hasOurTunnel: false,
        localPortHasListener: true,
      }),
    ).toEqual({ kind: "prefer-local", port: 4000 });
  });

  it("starts a same-port tunnel when the local port is free", () => {
    expect(
      decideLoopbackForward({
        environmentIsLoopback: false,
        target,
        hasOurTunnel: false,
        localPortHasListener: false,
      }),
    ).toEqual({ kind: "start-tunnel", port: 4000 });
  });
});
