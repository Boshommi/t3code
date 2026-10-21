/**
 * Lets a desktop client reach a dev server bound only to this machine's
 * loopback. Each WebSocket on `/api/preview-tunnel?port=N` carries the bytes
 * of one TCP connection to localhost:N. The target host is fixed to loopback,
 * so the route cannot be used to reach anything else, and it needs the
 * permission to drive this environment's browser, which reaches the same
 * servers.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { AuthPreviewOperateScope } from "@t3tools/contracts";
import { PREVIEW_TUNNEL_PATH } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest } from "../auth/http.ts";

export function parseTunnelPort(raw: string | null): number | null {
  if (raw === null || !/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65_535 ? port : null;
}

// A server bound to `localhost` may listen on either family.
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"] as const;

/** Connects to the port on loopback; the socket is open once this succeeds. */
export const dialLoopback = (port: number) =>
  Effect.firstSuccessOf(
    LOOPBACK_ADDRESSES.map((host) =>
      Effect.gen(function* () {
        const socket = yield* NodeSocket.makeNet({ host, port, openTimeout: "2 seconds" });
        const reader = yield* socket.reader;
        return { socket, reader };
      }),
    ),
  );

interface OpenSocket {
  readonly socket: Socket.Socket;
  readonly reader: Socket.Reader;
}

const pump = (from: Socket.Reader, to: Socket.Writer) =>
  Effect.forever(Effect.flatMap(from.pull, (chunks) => to.writeAll(chunks)));

/** Copies bytes both ways until either side closes. */
const pipeSockets = Effect.fn("preview.loopbackTunnel.pipe")(
  function* (left: OpenSocket, right: OpenSocket) {
    const writeLeft = yield* left.socket.writer;
    const writeRight = yield* right.socket.writer;
    // A close fails the pull, which ends the race and tears both sides down.
    return yield* Effect.raceFirst(pump(left.reader, writeRight), pump(right.reader, writeLeft));
  },
  (effect) => effect.pipe(Effect.scoped, Effect.ignore),
);

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.upgrade?.toLowerCase() !== "websocket") {
    return HttpServerResponse.text("Upgrade Required", { status: 426 });
  }
  yield* authenticateMediaRequest(AuthPreviewOperateScope);
  const url = HttpServerRequest.toURL(request);
  const port = Option.isSome(url) ? parseTunnelPort(url.value.searchParams.get("port")) : null;
  if (port === null) return HttpServerResponse.text("Bad Request", { status: 400 });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Dial before upgrading so a closed port reads as a failed connection.
      const target = yield* dialLoopback(port);
      const client = yield* request.upgrade;
      yield* pipeSockets({ socket: client, reader: yield* client.reader }, target);
      return HttpServerResponse.empty();
    }),
  ).pipe(
    Effect.catchTags({
      SocketError: () => Effect.succeed(HttpServerResponse.text("Bad Gateway", { status: 502 })),
    }),
  );
});

export const routeLayer = HttpRouter.add("GET", PREVIEW_TUNNEL_PATH, handler);
