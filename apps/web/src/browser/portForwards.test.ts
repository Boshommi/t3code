import { EnvironmentId, type DesktopPortForward } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planForward, unforwardedUrl } from "./portForwards";

const environmentId = EnvironmentId.make("remote");
const forward = (remotePort: number, localPort = remotePort): DesktopPortForward => ({
  environmentId,
  remotePort,
  localPort,
});

describe("planForward", () => {
  it("leaves URLs off loopback alone", () => {
    expect(planForward("https://example.com/", [forward(443)])).toEqual({ kind: "none" });
  });

  it("starts a forward for a loopback port that has none", () => {
    expect(planForward("http://localhost:5173/app", [forward(3000)])).toEqual({
      kind: "start",
      remotePort: 5173,
    });
  });

  it("reaches an existing forward on its local port, keeping the path", () => {
    expect(planForward("http://127.0.0.1:3000/login?next=/", [forward(3000, 49152)])).toEqual({
      kind: "ready",
      url: "http://127.0.0.1:49152/login?next=/",
    });
    expect(planForward("http://0.0.0.0:3000/", [forward(3000)])).toEqual({
      kind: "ready",
      url: "http://localhost:3000/",
    });
  });

  it("keeps a URL that already points at a forward's local port", () => {
    expect(planForward("http://localhost:49152/", [forward(3000, 49152)])).toEqual({
      kind: "ready",
      url: "http://localhost:49152/",
    });
  });
});

describe("unforwardedUrl", () => {
  it("maps a forward's local port back to the remote one", () => {
    expect(unforwardedUrl("http://localhost:49152/a?b=c", [forward(3000, 49152)])).toBe(
      "http://localhost:3000/a?b=c",
    );
  });

  it("leaves other URLs alone", () => {
    expect(unforwardedUrl("http://localhost:3000/", [forward(3000)])).toBe(
      "http://localhost:3000/",
    );
    expect(unforwardedUrl("https://example.com/", [forward(443, 49152)])).toBe(
      "https://example.com/",
    );
  });
});
