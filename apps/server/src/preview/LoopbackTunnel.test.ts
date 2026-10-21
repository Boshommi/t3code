import { describe, expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";
import * as NodeNet from "node:net";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as LoopbackTunnel from "./LoopbackTunnel.ts";

const listenEcho = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer((socket) => socket.pipe(socket));
    server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.succeed(server)));
  }),
  (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
).pipe(
  Effect.map((server) => {
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing echo port");
    return address.port;
  }),
);

const serveTunnel = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.build(
    HttpRouter.serve(LoopbackTunnel.routeLayer, { disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "test",
              method: "bearer-access-token",
              scopes,
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
    ),
  ).pipe(
    Effect.map((services) =>
      HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address).replace(
        /^http/,
        "ws",
      ),
    ),
  );

const openTunnel = (origin: string, port: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new WebSocket(`${origin}/api/preview-tunnel?port=${port}&wsTicket=test`);
      socket.binaryType = "arraybuffer";
      return socket;
    }),
    (socket) => Effect.sync(() => socket.close()),
  );

/** Resolves with the first message, or "refused" when the upgrade fails. */
const firstMessage = (socket: WebSocket, send?: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        socket.addEventListener("open", () => {
          if (send !== undefined) socket.send(new TextEncoder().encode(send));
        });
        socket.addEventListener("message", ({ data }) =>
          resolve(new TextDecoder().decode(data as ArrayBuffer)),
        );
        socket.addEventListener("error", () => resolve("refused"));
      }),
  );

describe("LoopbackTunnel", () => {
  it.effect("carries bytes to and from a loopback port", () =>
    Effect.gen(function* () {
      const port = yield* listenEcho;
      const origin = yield* serveTunnel([AuthPreviewOperateScope]);
      const socket = yield* openTunnel(origin, port);
      expect(yield* firstMessage(socket, "GET / HTTP/1.1\r\n")).toBe("GET / HTTP/1.1\r\n");
    }),
  );

  it.effect("refuses sessions that cannot operate the preview", () =>
    Effect.gen(function* () {
      const port = yield* listenEcho;
      const origin = yield* serveTunnel([AuthOrchestrationReadScope]);
      expect(yield* firstMessage(yield* openTunnel(origin, port), "ping")).toBe("refused");
    }),
  );

  it.effect("refuses a port nothing listens on", () =>
    Effect.gen(function* () {
      const origin = yield* serveTunnel([AuthPreviewOperateScope]);
      // Port 1 is privileged and unused on test machines.
      expect(yield* firstMessage(yield* openTunnel(origin, 1), "ping")).toBe("refused");
    }),
  );

  it.each([
    ["5173", 5173],
    ["65535", 65535],
    ["0", null],
    ["65536", null],
    ["-1", null],
    ["80abc", null],
    ["", null],
    [null, null],
  ])("parses port %s as %s", (raw, port) => {
    expect(LoopbackTunnel.parseTunnelPort(raw)).toBe(port);
  });
});
