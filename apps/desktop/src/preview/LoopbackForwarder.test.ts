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

describe("PreviewLoopbackForwarder", () => {
  effectIt.effect("prefers a local listener instead of remapping the port", () =>
    Effect.gen(function* () {
      const occupied = yield* listen(0);
      const address = occupied.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const forwarder = yield* make;
      const result = yield* forwarder.ensure({
        environmentId: EnvironmentId.make("env-1"),
        url: `http://localhost:${String(port)}/app`,
        environmentIsLoopback: false,
        tunnelWebsocketUrl: "ws://127.0.0.1:9/preview-tunnel?port=1",
      });
      expect(result).toEqual({
        navigateUrl: `http://localhost:${String(port)}/app`,
        kind: "prefer-local",
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
        tunnelWebsocketUrl: "ws://127.0.0.1:9/preview-tunnel?port=1",
      });
      expect(result.kind).toBe("start-tunnel");
      const reuse = yield* forwarder.ensure({
        environmentId: EnvironmentId.make("env-1"),
        url: `http://localhost:${String(port)}/`,
        environmentIsLoopback: false,
        tunnelWebsocketUrl: "ws://127.0.0.1:9/preview-tunnel?port=1",
      });
      expect(reuse.kind).toBe("reuse-tunnel");
    }),
  );

  it("keeps prefer-local ahead of remapping in the decision table", () => {
    expect(
      decideLoopbackForward({
        environmentIsLoopback: false,
        target: { href: "http://localhost:4000/", port: 4000, protocol: "http:" },
        hasOurTunnel: false,
        localPortHasListener: true,
      }).kind,
    ).toBe("prefer-local");
  });

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
