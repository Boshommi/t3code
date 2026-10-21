/**
 * Port forwards from a remote environment, like `ssh -L`: a listener on this
 * computer's 127.0.0.1 whose every connection opens its own WebSocket to the
 * environment's `/api/preview-tunnel`, which connects to the remote's
 * loopback. The in-app browser and the system browser then both reach a
 * remote dev server at `localhost`, keeping the origin its CORS, OAuth, and
 * secure-context checks expect.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type { DesktopPortForward, EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";
import * as NodeNet from "node:net";

export class PortForwardError extends Schema.TaggedError<PortForwardError>()("PortForwardError", {
  remotePort: Schema.Number,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

interface ForwardTarget {
  readonly environmentId: EnvironmentId;
  readonly remotePort: number;
}

interface Entry {
  readonly forward: DesktopPortForward;
  readonly scope: Scope.Closeable;
}

export class PortForwarder extends Context.Service<
  PortForwarder,
  {
    /** Starts a forward, or returns the running one; either way refreshes the ticket. */
    readonly forward: (
      input: ForwardTarget & { readonly tunnelUrl: string },
    ) => Effect.Effect<DesktopPortForward, PortForwardError>;
    readonly stop: (input: ForwardTarget) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<DesktopPortForward>>;
  }
>()("@t3tools/desktop/preview/PortForwarder") {}

const keyOf = ({ environmentId, remotePort }: ForwardTarget) => `${environmentId}:${remotePort}`;

export function tunnelUrlForPort(tunnelUrl: string, remotePort: number): string | null {
  if (!URL.canParse(tunnelUrl)) return null;
  const url = new URL(tunnelUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
  url.searchParams.set("port", String(remotePort));
  return url.href;
}

const listen = (server: NodeNet.Server, port: number) =>
  Effect.callback<number, NodeJS.ErrnoException>((resume) => {
    const onError = (cause: NodeJS.ErrnoException) => resume(Effect.fail(cause));
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", onError);
      const address = server.address();
      resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : port));
    });
  });

const pump =
  /* Byte pumping runs for the connection's life; its span adds nothing to the tunnel's. */
  Effect.fnUntraced(function* (from: Socket.Socket, to: Socket.Socket) {
    const { pull } = yield* from.reader;
    const write = yield* to.writer;
    return yield* Effect.forever(Effect.flatMap(pull, (chunks) => write.writeAll(chunks)));
  });

/** Copies bytes both ways until either side closes. */
const pipeSockets = Effect.fn("desktop.preview.portForward.pipe")(
  function* (left: Socket.Socket, right: Socket.Socket) {
    // A close fails the pull, which ends the race and tears both sides down.
    return yield* Effect.raceFirst(pump(left, right), pump(right, left));
  },
  (effect) => effect.pipe(Effect.scoped, Effect.ignore),
);

export const make = Effect.gen(function* () {
  const entries = new Map<string, Entry>();
  const tunnelUrls = new Map<EnvironmentId, string>();
  const startLock = yield* Semaphore.make(1);
  const webSockets = yield* Effect.context<Socket.WebSocketConstructor>();

  yield* Effect.addFinalizer(() =>
    Effect.forEach(entries.values(), (entry) => Scope.close(entry.scope, Exit.void), {
      discard: true,
    }),
  );

  const tunnel = Effect.fn("desktop.preview.portForward.tunnel")(
    function* (target: ForwardTarget, local: NodeNet.Socket) {
      const environmentUrl = tunnelUrls.get(target.environmentId);
      const url =
        environmentUrl === undefined ? null : tunnelUrlForPort(environmentUrl, target.remotePort);
      if (url === null) return;
      const remote = yield* Socket.makeWebSocket(url, { openTimeout: "10 seconds" });
      yield* pipeSockets(yield* NodeSocket.fromDuplex(Effect.succeed(local)), remote);
    },
    (effect, _target, local) =>
      effect.pipe(
        Effect.provideContext(webSockets),
        Effect.ensuring(Effect.sync(() => local.destroy())),
      ),
  );

  const start = Effect.fn("desktop.preview.portForward.start")(function* (target: ForwardTarget) {
    const scope = yield* Scope.make();
    const run = yield* FiberSet.makeRuntime().pipe(Scope.provide(scope));
    const server = NodeNet.createServer((local) => {
      // Errors end the tunnel through the socket's close; none should crash main.
      local.on("error", () => undefined);
      run(tunnel(target, local));
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => server.close()),
    );
    // The same port keeps the page's origin; any free one when it is taken here.
    const localPort = yield* listen(server, target.remotePort).pipe(
      Effect.catchIf(
        (cause) => cause.code === "EADDRINUSE",
        () => listen(server, 0),
      ),
      Effect.mapError(
        (cause) =>
          new PortForwardError({
            remotePort: target.remotePort,
            detail: `Could not forward port ${target.remotePort} to this computer.`,
            cause,
          }),
      ),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const entry: Entry = { forward: { ...target, localPort }, scope };
    entries.set(keyOf(target), entry);
    return entry.forward;
  });

  const forward = Effect.fn("desktop.preview.portForward.forward")(function* ({
    tunnelUrl,
    ...target
  }: ForwardTarget & { readonly tunnelUrl: string }) {
    if (tunnelUrlForPort(tunnelUrl, target.remotePort) === null) {
      return yield* new PortForwardError({
        remotePort: target.remotePort,
        detail: "The environment did not provide a tunnel URL.",
      });
    }
    tunnelUrls.set(target.environmentId, tunnelUrl);
    return entries.get(keyOf(target))?.forward ?? (yield* start(target));
  }, startLock.withPermits(1));

  const stop: PortForwarder["Service"]["stop"] = (target) =>
    Effect.suspend(() => {
      const entry = entries.get(keyOf(target));
      if (entry === undefined) return Effect.void;
      entries.delete(keyOf(target));
      return Scope.close(entry.scope, Exit.void);
    });

  return PortForwarder.of({
    forward,
    stop,
    list: Effect.sync(() => Array.from(entries.values(), (entry) => entry.forward)),
  });
});

export const layer = Layer.effect(PortForwarder, make).pipe(
  Layer.provide(NodeSocket.layerWebSocketConstructor),
);
