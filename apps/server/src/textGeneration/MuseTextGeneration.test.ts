// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MuseSettings, ProviderInstanceId } from "@t3tools/contracts";

import { execScriptSource, writeFakeCli } from "../testUtils/fakeCli.ts";
import { makeMuseTextGeneration } from "./MuseTextGeneration.ts";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockHostPath = NodePath.join(__dirname, "../../scripts/msp-mock-host.ts");

async function makeMockMuse(responseText: string) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-textgen-"));
  const requestLogPath = NodePath.join(dir, "requests.ndjson");
  const command = writeFakeCli({
    directory: dir,
    name: "fake-muse",
    env: { T3_MSP_REQUEST_LOG_PATH: requestLogPath, T3_MSP_RESPONSE_TEXT: responseText },
    source: execScriptSource({ scriptPath: mockHostPath, expectedArgs: ["serve"] }),
  });
  return { command, requestLogPath, dir };
}

it.layer(NodeServices.layer)("MuseTextGeneration", (it) => {
  it.effect("generates a thread title through a tool-less session in a private data home", () =>
    Effect.gen(function* () {
      const { command, requestLogPath, dir } = yield* Effect.promise(() =>
        makeMockMuse('Sure! {"title": "Retry websocket reconnects"}'),
      );
      const dataHome = NodePath.join(dir, "data-home");
      const textGeneration = yield* makeMuseTextGeneration(
        decodeMuseSettings({ binaryPath: command }),
        process.env,
        { dataHome },
      );
      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Add retry with backoff to the websocket reconnect",
        modelSelection: {
          instanceId: ProviderInstanceId.make("muse"),
          model: "muse-spark-1.3",
          options: [{ id: "reasoningEffort", value: "minimal" }],
        },
      });
      assert.equal(result.title, "Retry websocket reconnects");
      const raw = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      const requests = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      const start = requests.find((request) => request.method === "session/start");
      assert.equal(start?.params.approvalMode, "denyUnmatched");
      assert.equal(start?.params.modelId, "muse-spark-1.3");
      assert.equal(start?.params.providerId, "meta");
      const turn = requests.find((request) => request.method === "turn/start");
      assert.equal(turn?.params.reasoningEffort, "minimal");
    }),
  );

  it.effect("fails cleanly when the model returns no JSON", () =>
    Effect.gen(function* () {
      const { command } = yield* Effect.promise(() => makeMockMuse("no json here"));
      const textGeneration = yield* makeMuseTextGeneration(
        decodeMuseSettings({ binaryPath: command }),
      );
      const failure = yield* textGeneration
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "muse-spark-1.3" },
        })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "TextGenerationError");
      assert.equal(failure.operation, "generateBranchName");
    }),
  );
});
