import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "~/connection/desktopLocal";

import { previewEnvironmentIsLocal } from "./browserTargetResolver";

const environmentId = EnvironmentId.make("env-1");

describe("previewEnvironmentIsLocal", () => {
  it("treats a missing connection as local so desktop does not attach a proxy", () => {
    expect(previewEnvironmentIsLocal(null)).toBe(true);
  });

  it("skips proxying for the primary environment even when reached via a tailnet URL", () => {
    expect(
      previewEnvironmentIsLocal({
        httpBaseUrl: "https://desktop.tail5db3ea.ts.net/",
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "This device",
          httpBaseUrl: "https://desktop.tail5db3ea.ts.net/",
          wsBaseUrl: "wss://desktop.tail5db3ea.ts.net/",
        }),
      }),
    ).toBe(true);
  });

  it("skips proxying for a desktop-local WSL backend", () => {
    expect(
      previewEnvironmentIsLocal({
        httpBaseUrl: "http://127.0.0.1:4000/",
        target: new BearerConnectionTarget({
          connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
          environmentId,
          label: "WSL (Ubuntu)",
        }),
      }),
    ).toBe(true);
  });

  it("skips proxying when the environment is already on loopback", () => {
    expect(
      previewEnvironmentIsLocal({
        httpBaseUrl: "http://127.0.0.1:3773/",
        target: new BearerConnectionTarget({
          connectionId: "saved-local",
          environmentId,
          label: "Saved",
        }),
      }),
    ).toBe(true);
  });

  it("proxies localhost only for a remote environment", () => {
    expect(
      previewEnvironmentIsLocal({
        httpBaseUrl: "https://nuc.tail5db3ea.ts.net/",
        target: new SshConnectionTarget({
          connectionId: "ssh-1",
          environmentId,
          label: "nuc",
        }),
      }),
    ).toBe(false);
    expect(
      previewEnvironmentIsLocal({
        httpBaseUrl: "https://relay.t3.codes/",
        target: new RelayConnectionTarget({
          environmentId,
          label: "relay",
        }),
      }),
    ).toBe(false);
  });
});
