import { EnvironmentId } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";

import { decideLoopbackForward } from "@t3tools/shared/previewLoopbackForward";

import {
  make,
  parsePreviewProxyDestination,
  pipeLocalSocketToTunnel,
  rewriteHttpProxyRequest,
} from "./LoopbackForwarder.ts";

const listen = (port: number) =>
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen({ host: "127.0.0.1", port }, () => resume(Effect.succeed(server)));
    return Effect.sync(() => {
      server.close();
    });
  });

describe("PreviewLoopbackForwarder", () => {
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

  it("parses CONNECT and absolute-form proxy destinations", () => {
    expect(parsePreviewProxyDestination("CONNECT localhost:5173 HTTP/1.1")).toEqual({
      host: "localhost",
      port: 5173,
    });
    expect(parsePreviewProxyDestination("GET http://127.0.0.1:3000/app HTTP/1.1")).toEqual({
      host: "127.0.0.1",
      port: 3000,
    });
  });

  it("rewrites absolute-form preview proxy requests", () => {
    expect(
      rewriteHttpProxyRequest("GET http://localhost:3000/app?x=1 HTTP/1.1\r\nHost: localhost:3000"),
    ).toBe("GET /app?x=1 HTTP/1.1\r\nHost: localhost:3000");
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
