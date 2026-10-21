import { describe, expect, it } from "@effect/vitest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeNet from "node:net";

import * as PortForwarder from "./PortForwarder.ts";

const environmentId = EnvironmentId.make("remote");

const makeForwarder = Layer.build(PortForwarder.layer).pipe(
  Effect.map((services) => Context.get(services, PortForwarder.PortForwarder)),
);

/** Stands in for `/api/preview-tunnel`: records each URL and echoes bytes back. */
const fakeTunnel = Effect.acquireRelease(
  Effect.callback<NodeWS.WebSocketServer>((resume) => {
    const server: NodeWS.WebSocketServer = new NodeWS.WebSocketServer({
      host: "127.0.0.1",
      port: 0,
    });
    server.once("listening", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      for (const client of server.clients) client.terminate();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => {
    const urls: string[] = [];
    server.on("connection", (socket, request) => {
      urls.push(request.url ?? "");
      socket.on("message", (data) => socket.send(data, { binary: true }));
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing tunnel port");
    return { urls, url: (ticket: string) => `ws://127.0.0.1:${address.port}/t?wsTicket=${ticket}` };
  }),
);

const holdPort = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.succeed(server)));
  }),
  (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
).pipe(
  Effect.map((server) => {
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing port");
    return address.port;
  }),
);

const freePort = Effect.scoped(holdPort);

/** Sends a line through the forward and resolves with what comes back. */
const roundTrip = (port: number, line: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        const socket = NodeNet.createConnection({ host: "127.0.0.1", port }, () =>
          socket.write(line),
        );
        socket.once("data", (data) => {
          resolve(data.toString());
          socket.destroy();
        });
        socket.once("error", () => resolve("refused"));
      }),
  );

describe("PortForwarder", () => {
  it.effect("keeps the remote port number and tunnels with the latest ticket", () =>
    Effect.gen(function* () {
      const tunnel = yield* fakeTunnel;
      const forwarder = yield* makeForwarder;
      const remotePort = yield* freePort;

      const forward = yield* forwarder.forward({
        environmentId,
        remotePort,
        tunnelUrl: tunnel.url("first"),
      });
      expect(forward.localPort).toBe(remotePort);
      expect(yield* roundTrip(forward.localPort, "hello")).toBe("hello");

      const again = yield* forwarder.forward({
        environmentId,
        remotePort,
        tunnelUrl: tunnel.url("second"),
      });
      expect(again).toEqual(forward);
      expect(yield* roundTrip(forward.localPort, "again")).toBe("again");
      expect(tunnel.urls).toEqual([
        `/t?wsTicket=first&port=${remotePort}`,
        `/t?wsTicket=second&port=${remotePort}`,
      ]);
    }),
  );

  it.effect("picks another local port when the remote one is taken here", () =>
    Effect.gen(function* () {
      const tunnel = yield* fakeTunnel;
      const forwarder = yield* makeForwarder;
      const taken = yield* holdPort;

      const forward = yield* forwarder.forward({
        environmentId,
        remotePort: taken,
        tunnelUrl: tunnel.url("ticket"),
      });
      expect(forward.localPort).not.toBe(taken);
      expect(yield* roundTrip(forward.localPort, "remote")).toBe("remote");
      expect(tunnel.urls).toEqual([`/t?wsTicket=ticket&port=${taken}`]);
    }),
  );

  it.effect("stops listening once stopped", () =>
    Effect.gen(function* () {
      const tunnel = yield* fakeTunnel;
      const forwarder = yield* makeForwarder;
      const forward = yield* forwarder.forward({
        environmentId,
        remotePort: yield* freePort,
        tunnelUrl: tunnel.url("ticket"),
      });
      yield* forwarder.stop(forward);
      expect(yield* forwarder.list).toEqual([]);
      expect(yield* roundTrip(forward.localPort, "gone")).toBe("refused");
    }),
  );

  it.effect("rejects a tunnel URL that is not a WebSocket URL", () =>
    Effect.gen(function* () {
      const forwarder = yield* makeForwarder;
      const error = yield* Effect.flip(
        forwarder.forward({ environmentId, remotePort: 3000, tunnelUrl: "https://example.com" }),
      );
      expect(error._tag).toBe("PortForwardError");
      expect(yield* forwarder.list).toEqual([]);
    }),
  );
});
