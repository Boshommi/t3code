/**
 * MspConnection — one `muse serve` process and the JSON-RPC 2.0 peer on its stdio.
 *
 * MSP frames are newline-delimited JSON. The host never sends requests to the
 * client: approvals and questions arrive as notifications and are answered by
 * client requests, so this peer only correlates responses and fans out
 * notifications. The child process lives in the scope this is built in.
 *
 * @module provider/msp/MspConnection
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { MSP_CLIENT_NAME, MspErrorData, MspInitializeResult } from "./MspProtocol.ts";

export class MspSpawnError extends Schema.TaggedErrorClass<MspSpawnError>()("MspSpawnError", {
  command: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Failed to start Muse Code host '${this.command}'.`;
  }
}

/** The host answered a request with a JSON-RPC error frame. */
export class MspRequestError extends Schema.TaggedErrorClass<MspRequestError>()("MspRequestError", {
  method: Schema.String,
  code: Schema.optional(Schema.Number),
  detail: Schema.String,
  kind: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Muse Code request ${this.method} failed: ${this.detail}`;
  }
}

/** The host process ended or its stdio broke; every pending request fails with this. */
export class MspTransportError extends Schema.TaggedErrorClass<MspTransportError>()(
  "MspTransportError",
  {
    reason: Schema.Literals(["process-exited", "stream-ended", "write-failed", "read-failed"]),
    exitCode: Schema.optional(Schema.Number),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const suffix = this.exitCode === undefined ? "" : ` (exit code ${this.exitCode})`;
    return `Muse Code host connection lost: ${this.reason}${suffix}${this.detail ? `: ${this.detail}` : ""}`;
  }
}

export type MspError = MspRequestError | MspTransportError;

export interface MspNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface MspConnectionLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly payload: unknown;
}

export interface MspConnectionOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onNotification: (notification: MspNotification) => Effect.Effect<void>;
  readonly onStderr?: (chunk: string) => Effect.Effect<void>;
  readonly onLog?: (event: MspConnectionLogEvent) => Effect.Effect<void>;
  readonly onTermination?: (error: MspTransportError) => Effect.Effect<void>;
}

export interface MspConnection {
  readonly pid: number;
  readonly request: <A, I>(
    method: string,
    params: unknown,
    resultSchema: Schema.Codec<A, I>,
  ) => Effect.Effect<A, MspError>;
  readonly notify: (method: string, params: unknown) => Effect.Effect<void, MspError>;
  /** Resolves once the host is gone, for callers that want to observe the exit. */
  readonly awaitTermination: Effect.Effect<MspTransportError>;
  readonly isTerminated: Effect.Effect<boolean>;
}

const encoder = new TextEncoder();
const JsonRpcId = Schema.Union([Schema.Number, Schema.String]);
const isJsonRpcId = Schema.is(JsonRpcId);
const JsonRpcErrorFrame = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
const decodeErrorData = Schema.decodeUnknownOption(MspErrorData);
const decodeErrorFrame = Schema.decodeUnknownOption(JsonRpcErrorFrame);
const decodeJsonLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const MAX_STDERR_CHUNK = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PendingRequest {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, MspError>;
}

/**
 * RFC 9562 UUIDv7. MSP requires client-minted command ids in this form and the
 * host rejects anything else, so this cannot fall back to v4.
 */
export const makeUuidV7 = Effect.fn("makeUuidV7")(function* () {
  const crypto = yield* Crypto.Crypto;
  const now = yield* Clock.currentTimeMillis;
  const random = yield* crypto.randomBytes(10);
  const bytes = new Uint8Array(16);
  let time = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes.set(random, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

export const makeMspConnection = Effect.fn("makeMspConnection")(function* (
  options: MspConnectionOptions,
): Effect.fn.Return<
  MspConnection,
  MspSpawnError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const spawnCommand = yield* resolveSpawnCommand(options.command, options.args, {
    ...(options.env ? { env: options.env } : {}),
    extendEnv: true,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: options.cwd,
        ...(options.env ? { env: options.env } : {}),
        extendEnv: true,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(Effect.mapError((cause) => new MspSpawnError({ command: options.command, cause })));

  const outgoing = yield* Queue.unbounded<string, Cause.Done<void>>();
  const pending = yield* Ref.make(new Map<number, PendingRequest>());
  const nextId = yield* Ref.make(1);
  const termination = yield* Deferred.make<MspTransportError>();
  const terminationRef = yield* Ref.make(Option.none<MspTransportError>());

  const log = (event: MspConnectionLogEvent) => options.onLog?.(event) ?? Effect.void;

  const terminate = (error: MspTransportError) =>
    Ref.modify(terminationRef, (current) =>
      Option.isSome(current)
        ? ([Effect.void, current] as const)
        : ([
            Effect.gen(function* () {
              const requests = yield* Ref.getAndSet(pending, new Map());
              yield* Effect.forEach(
                [...requests.values()],
                ({ deferred }) => Deferred.fail(deferred, error),
                { discard: true },
              );
              yield* Queue.end(outgoing);
              yield* Deferred.succeed(termination, error);
              if (options.onTermination) {
                yield* options.onTermination(error);
              }
            }),
            Option.some(error),
          ] as const),
    ).pipe(Effect.flatten);

  const send = (message: Record<string, unknown>) =>
    Effect.gen(function* () {
      const closed = yield* Ref.get(terminationRef);
      if (Option.isSome(closed)) {
        return yield* closed.value;
      }
      yield* log({ direction: "outgoing", payload: message });
      const accepted = yield* Queue.offer(outgoing, `${encodeJson(message)}\n`);
      if (!accepted) {
        return yield* new MspTransportError({ reason: "write-failed" });
      }
    });

  const handleResponse = (id: number, frame: Record<string, unknown>) =>
    Ref.modify(pending, (current) => {
      const request = current.get(id);
      if (!request) {
        return [Effect.void, current] as const;
      }
      const next = new Map(current);
      next.delete(id);
      const errorFrame = decodeErrorFrame(frame.error);
      if (Option.isSome(errorFrame)) {
        const data = decodeErrorData(errorFrame.value.data);
        return [
          Deferred.fail(
            request.deferred,
            new MspRequestError({
              method: request.method,
              code: errorFrame.value.code,
              detail: errorFrame.value.message,
              ...(Option.isSome(data) && data.value.kind !== undefined
                ? { kind: data.value.kind }
                : {}),
              ...(Option.isSome(data) && data.value.retryable !== undefined
                ? { retryable: data.value.retryable }
                : {}),
            }),
          ),
          next,
        ] as const;
      }
      return [Deferred.succeed(request.deferred, frame.result), next] as const;
    }).pipe(Effect.flatten);

  const handleLine = (line: string) =>
    Effect.gen(function* () {
      if (line.trim().length === 0) {
        return;
      }
      const decoded = yield* decodeJsonLine(line).pipe(Effect.option);
      if (Option.isNone(decoded) || !isRecord(decoded.value)) {
        // Muse prints human-readable diagnostics to stdout before the first frame in
        // some failure modes; those lines are not protocol traffic.
        yield* log({ direction: "incoming", payload: { unparsed: line.slice(0, 500) } });
        return;
      }
      const frame = decoded.value;
      yield* log({ direction: "incoming", payload: frame });
      if (typeof frame.method === "string") {
        if (isJsonRpcId(frame.id)) {
          // MSP v1 never sends server-initiated requests. Refuse loudly instead of hanging the host.
          yield* send({
            jsonrpc: "2.0",
            id: frame.id,
            error: { code: -32601, message: "T3 Code does not serve MSP requests." },
          }).pipe(Effect.ignore);
          return;
        }
        yield* options.onNotification({ method: frame.method, params: frame.params });
        return;
      }
      if (typeof frame.id === "number") {
        yield* handleResponse(frame.id, frame);
      }
    });

  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(handleLine),
    Effect.matchEffect({
      onFailure: (cause) =>
        terminate(new MspTransportError({ reason: "read-failed", detail: cause.message, cause })),
      onSuccess: () =>
        child.exitCode.pipe(
          Effect.map(
            (code) => new MspTransportError({ reason: "process-exited", exitCode: Number(code) }),
          ),
          Effect.orElseSucceed(() => new MspTransportError({ reason: "stream-ended" })),
          Effect.flatMap(terminate),
        ),
    }),
    Effect.forkIn(scope),
  );

  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      options.onStderr ? options.onStderr(chunk.slice(-MAX_STDERR_CHUNK)) : Effect.void,
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(Sink.mapInput(child.stdin, (chunk: string) => encoder.encode(chunk))),
    Effect.matchEffect({
      onFailure: (cause) =>
        terminate(new MspTransportError({ reason: "write-failed", detail: cause.message, cause })),
      onSuccess: () => Effect.void,
    }),
    Effect.forkIn(scope),
  );

  const request: MspConnection["request"] = (method, params, resultSchema) =>
    Effect.gen(function* () {
      const id = yield* Ref.getAndUpdate(nextId, (current) => current + 1);
      const deferred = yield* Deferred.make<unknown, MspError>();
      yield* Ref.update(pending, (current) => new Map(current).set(id, { method, deferred }));
      yield* send({ jsonrpc: "2.0", id, method, params }).pipe(
        Effect.tapError(() =>
          Ref.update(pending, (current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          }),
        ),
      );
      const raw = yield* Deferred.await(deferred).pipe(
        Effect.onInterrupt(() =>
          Ref.update(pending, (current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          }),
        ),
      );
      return yield* Schema.decodeUnknownEffect(resultSchema)(raw).pipe(
        Effect.mapError(
          (cause) =>
            new MspRequestError({
              method,
              detail: `Unexpected result shape: ${cause.message}`,
              cause,
            }),
        ),
      );
    });

  const notify: MspConnection["notify"] = (method, params) =>
    send({ jsonrpc: "2.0", method, params });

  return {
    pid: Number(child.pid),
    request,
    notify,
    awaitTermination: Deferred.await(termination),
    isTerminated: Ref.get(terminationRef).pipe(Effect.map(Option.isSome)),
  } satisfies MspConnection;
});

/** LSP-style handshake: `initialize` request, then the `initialized` notification. */
export const initializeMspConnection = Effect.fn("initializeMspConnection")(function* (
  connection: MspConnection,
  clientVersion: string,
) {
  const result = yield* connection.request(
    "initialize",
    { clientInfo: { name: MSP_CLIENT_NAME, title: "T3 Code", version: clientVersion } },
    MspInitializeResult,
  );
  yield* connection.notify("initialized", {});
  return result;
});

export interface MspHostInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly clientVersion: string;
  readonly onNotification?: (notification: MspNotification) => Effect.Effect<void>;
}

/**
 * Spawns a throwaway host, completes the handshake, and hands the connection to
 * `use`. The process dies with the scope this runs in. Model probes and text
 * generation use this; chat threads keep their own long-lived host.
 */
export const withMspHost = <A, E, R>(
  input: MspHostInput,
  use: (connection: MspConnection) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MspSpawnError | MspError, R | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const connection = yield* makeMspConnection({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      ...(input.env ? { env: input.env } : {}),
      onNotification: input.onNotification ?? (() => Effect.void),
    });
    yield* initializeMspConnection(connection, input.clientVersion);
    return yield* use(connection);
  }).pipe(Effect.scoped);
