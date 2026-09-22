import { EnvironmentId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";
import { describe, expect } from "vite-plus/test";

import { makeWith } from "./PortForwarder.ts";

const environmentId = EnvironmentId.make("env-remote");

const tunnelUrl = (ticket: string) => `ws://127.0.0.1:9/preview-tunnel?wsTicket=${ticket}&port=1`;

const serverPort = (server: NodeNet.Server) => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

/** Stands in for the remote dev server: echoes whatever arrives. */
const listenEcho = () =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => socket.pipe(socket));
      server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.sync(() => server.close()),
  );

const freePort = () =>
  Effect.callback<number>((resume) => {
    const probe = NodeNet.createServer();
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = serverPort(probe);
      probe.close(() => resume(Effect.succeed(port)));
    });
  });

const roundTrip = (port: number, message: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const socket = NodeNet.createConnection({ host: "127.0.0.1", port }, () => {
          socket.write(message);
        });
        socket.once("data", (chunk) => {
          socket.destroy();
          resolve(chunk.toString());
        });
        socket.once("error", reject);
      }),
  );

const connectionRefused = (port: number) =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(false);
        });
        socket.once("error", () => resolve(true));
      }),
  );

/** Dials the echo server directly, recording the tunnel URL each connection used. */
const makeRecordingForwarder = (echoPort: number) => {
  const dialed: Array<URL> = [];
  const forwarder = makeWith((url) => {
    dialed.push(new URL(url));
    return NodeNet.createConnection({ host: "127.0.0.1", port: echoPort });
  });
  return { dialed, forwarder };
};

describe("PortForwarder", () => {
  it.effect("carries local connections through the tunnel for the remote port", () =>
    Effect.gen(function* () {
      const echoPort = serverPort(yield* listenEcho());
      const { dialed, forwarder: make } = makeRecordingForwarder(echoPort);
      const forwarder = yield* make;
      // The echo server already holds this port locally, so the forward has
      // to fall back to another one while still targeting the remote port.
      const forward = yield* forwarder.forward({
        environmentId,
        remotePort: echoPort,
        tunnelWebsocketUrl: tunnelUrl("first"),
      });
      expect(forward.remotePort).toBe(echoPort);
      expect(forward.localPort).not.toBe(echoPort);

      expect(yield* roundTrip(forward.localPort, "ping")).toBe("ping");
      expect(dialed[0]?.searchParams.get("port")).toBe(String(echoPort));
      expect(dialed[0]?.searchParams.get("wsTicket")).toBe("first");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the remote port number locally when it is free", () =>
    Effect.gen(function* () {
      const port = yield* freePort();
      const forwarder = yield* makeRecordingForwarder(port).forwarder;
      const forward = yield* forwarder.forward({
        environmentId,
        remotePort: port,
        tunnelWebsocketUrl: tunnelUrl("ticket"),
      });
      expect(forward.localPort).toBe(port);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the refreshed ticket for later connections", () =>
    Effect.gen(function* () {
      const echoPort = serverPort(yield* listenEcho());
      const { dialed, forwarder: make } = makeRecordingForwarder(echoPort);
      const forwarder = yield* make;
      const first = yield* forwarder.forward({
        environmentId,
        remotePort: echoPort,
        tunnelWebsocketUrl: tunnelUrl("first"),
      });
      const refreshed = yield* forwarder.forward({
        environmentId,
        remotePort: echoPort,
        tunnelWebsocketUrl: tunnelUrl("second"),
      });
      expect(refreshed).toEqual(first);

      yield* roundTrip(refreshed.localPort, "ping");
      expect(dialed.map((url) => url.searchParams.get("wsTicket"))).toEqual(["second"]);
    }).pipe(Effect.scoped),
  );

  it.effect("releases the local port when stopped", () =>
    Effect.gen(function* () {
      const echoPort = serverPort(yield* listenEcho());
      const forwarder = yield* makeRecordingForwarder(echoPort).forwarder;
      const forward = yield* forwarder.forward({
        environmentId,
        remotePort: echoPort,
        tunnelWebsocketUrl: tunnelUrl("ticket"),
      });
      yield* forwarder.stop({ environmentId, remotePort: echoPort });

      expect(yield* forwarder.list).toEqual([]);
      expect(yield* connectionRefused(forward.localPort)).toBe(true);
    }).pipe(Effect.scoped),
  );
});
