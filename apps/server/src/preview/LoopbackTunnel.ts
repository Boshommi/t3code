import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  parsePreviewTunnelPort,
  PREVIEW_LOOPBACK_TUNNEL_PATH,
} from "@t3tools/shared/previewLoopbackForward";
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import type * as Socket from "effect/unstable/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";

export class PreviewLoopbackTunnelError extends Schema.TaggedErrorClass<PreviewLoopbackTunnelError>()(
  "PreviewLoopbackTunnelError",
  {
    port: Schema.Number,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not open a loopback preview tunnel to 127.0.0.1:${String(this.port)}: ${this.detail}`;
  }
}

export const connectLoopback = (port: number) =>
  Effect.callback<NodeNet.Socket, PreviewLoopbackTunnelError>((resume) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (effect: Effect.Effect<NodeNet.Socket, PreviewLoopbackTunnelError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    socket.setTimeout(500);
    socket.once("timeout", () => {
      settle(
        Effect.fail(
          new PreviewLoopbackTunnelError({
            port,
            detail: "Remote loopback port refused the connection.",
          }),
        ),
      );
    });
    socket.once("connect", () => {
      settle(Effect.succeed(socket));
    });
    socket.once("error", (cause) => {
      settle(
        Effect.fail(
          new PreviewLoopbackTunnelError({
            port,
            detail: "Remote loopback port refused the connection.",
            cause,
          }),
        ),
      );
    });
    return Effect.sync(() => {
      socket.destroy();
    });
  });

export const pipeWebSocketToLoopback = (websocket: Socket.Socket, port: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const tcp = yield* connectLoopback(port);
      const writeWs = yield* websocket.writer;
      const outbound = yield* Queue.unbounded<Uint8Array>();
      tcp.on("data", (buffer: Buffer) => {
        Queue.offerUnsafe(outbound, new Uint8Array(buffer));
      });
      const tcpClosed = Effect.callback<void>((resume) => {
        const done = () => resume(Effect.void);
        tcp.once("close", done);
        tcp.once("end", done);
        tcp.once("error", done);
      });
      const pumpTcp = Queue.take(outbound).pipe(
        Effect.flatMap((chunk) => writeWs(chunk)),
        Effect.forever,
        Effect.asVoid,
      );
      yield* Effect.race(
        websocket.run((chunk) => {
          tcp.write(Buffer.from(chunk));
        }),
        Effect.race(pumpTcp, tcpClosed),
      ).pipe(Effect.ensuring(Effect.sync(() => tcp.destroy())));
    }),
  );

export const previewLoopbackTunnelRouteLayer = HttpRouter.add(
  "GET",
  PREVIEW_LOOPBACK_TUNNEL_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
      return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
    }
    const requestUrl = HttpServerRequest.toURL(request);
    const port = Option.isSome(requestUrl) ? parsePreviewTunnelPort(requestUrl.value) : null;
    if (port === null) {
      return HttpServerResponse.text("A valid preview tunnel port is required.", { status: 400 });
    }
    const websocket = yield* request.upgrade;
    yield* pipeWebSocketToLoopback(websocket, port).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Preview loopback tunnel ended", {
          port,
          cause,
        }),
      ),
    );
    return HttpServerResponse.empty();
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
