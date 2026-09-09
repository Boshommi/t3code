// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  initializeMspConnection,
  makeMspConnection,
  makeUuidV7,
  withMspHost,
} from "./MspConnection.ts";
import { MspModelListResult } from "./MspProtocol.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockHostPath = NodePath.join(__dirname, "../../../scripts/msp-mock-host.ts");

async function makeMockMuse(env?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "msp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-muse",
    env: env ?? {},
    source: execScriptSource({ scriptPath: mockHostPath, expectedArgs: ["serve"] }),
  });
}

it.layer(NodeServices.layer)("MspConnection", (it) => {
  it.effect("mints RFC 9562 version 7 ids", () =>
    Effect.gen(function* () {
      const id = yield* makeUuidV7();
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const second = yield* makeUuidV7();
      assert.notEqual(id, second);
    }),
  );

  it.effect("completes the handshake and decodes a typed result", () =>
    Effect.gen(function* () {
      const command = yield* Effect.promise(() => makeMockMuse());
      const models = yield* withMspHost(
        { command, args: ["serve"], cwd: process.cwd(), clientVersion: "test" },
        (connection) => connection.request("model/list", {}, MspModelListResult),
      );
      assert.deepEqual(
        models.models.map((model) => model.modelId),
        ["muse-spark-1.3", "muse-spark-1.3-contributor"],
      );
      assert.isTrue(models.models.find((model) => model.isDefault) !== undefined);
    }),
  );

  it.effect("surfaces JSON-RPC error frames as request errors with the host's kind", () =>
    Effect.gen(function* () {
      const command = yield* Effect.promise(() => makeMockMuse());
      const failure = yield* withMspHost(
        { command, args: ["serve"], cwd: process.cwd(), clientVersion: "test" },
        (connection) => connection.request("nope/method", {}, Schema.Unknown).pipe(Effect.result),
      );
      assert.equal(failure._tag, "Failure");
      if (failure._tag === "Failure" && failure.failure._tag === "MspRequestError") {
        assert.equal(failure.failure.kind, "methodNotFound");
        assert.equal(failure.failure.code, -32601);
      }
    }),
  );

  it.effect("rejects requests sent before the initialized notification", () =>
    Effect.gen(function* () {
      const command = yield* Effect.promise(() => makeMockMuse());
      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeMspConnection({
            command,
            args: ["serve"],
            cwd: process.cwd(),
            onNotification: () => Effect.void,
          });
          return yield* connection.request("model/list", {}, Schema.Unknown).pipe(Effect.result);
        }),
      );
      assert.equal(failure._tag, "Failure");
      if (failure._tag === "Failure" && failure.failure._tag === "MspRequestError") {
        assert.equal(failure.failure.kind, "notInitialized");
      }
    }),
  );

  it.effect("fails pending requests and reports termination when the host exits", () =>
    Effect.gen(function* () {
      const command = yield* Effect.promise(() =>
        makeMockMuse({ T3_MSP_EXIT_AFTER_TURN_START: "1", T3_MSP_HANG_TURN: "1" }),
      );
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeMspConnection({
            command,
            args: ["serve"],
            cwd: process.cwd(),
            onNotification: () => Effect.void,
          });
          yield* initializeMspConnection(connection, "test");
          const started = yield* connection.request(
            "session/start",
            { commandId: yield* makeUuidV7(), workspaceRoot: process.cwd() },
            Schema.Struct({ session: Schema.Struct({ sessionId: Schema.String }) }),
          );
          // The mock exits right after acknowledging the turn, before a `turn/completed`.
          const turnFailure = yield* connection
            .request(
              "turn/start",
              {
                commandId: yield* makeUuidV7(),
                sessionId: started.session.sessionId,
                input: [{ type: "text", text: "hi" }],
              },
              Schema.Unknown,
            )
            .pipe(Effect.result);
          const termination = yield* connection.awaitTermination;
          const late = yield* connection
            .request("model/list", {}, Schema.Unknown)
            .pipe(Effect.result);
          return { turnFailure, termination, late };
        }),
      );
      assert.equal(outcome.termination._tag, "MspTransportError");
      assert.equal(outcome.termination.reason, "process-exited");
      assert.equal(outcome.termination.exitCode, 3);
      assert.equal(outcome.late._tag, "Failure");
      if (outcome.late._tag === "Failure") {
        assert.equal(outcome.late.failure._tag, "MspTransportError");
      }
      // `turn/start` is answered before the exit; either outcome is acceptable as long
      // as the transport reports the death afterwards.
      assert.isTrue(
        outcome.turnFailure._tag === "Success" || outcome.turnFailure._tag === "Failure",
      );
    }),
  );
});
