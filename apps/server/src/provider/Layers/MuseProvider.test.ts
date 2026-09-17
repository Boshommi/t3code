// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MuseSettings } from "@t3tools/contracts";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  buildMuseModelsFromCatalog,
  checkMuseProviderStatus,
  MUSE_MODEL_CAPABILITIES,
} from "./MuseProvider.ts";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockHostPath = NodePath.join(__dirname, "../../../scripts/msp-mock-host.ts");

/** `muse --version` prints a version line; `muse serve` becomes the mock host. */
async function makeFakeMuse(options?: {
  readonly versionExitCode?: number;
  readonly env?: Record<string, string>;
}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-provider-"));
  const command = writeFakeCli({
    directory: dir,
    name: "fake-muse",
    ...(options?.env ? { env: options.env } : {}),
    source: [
      'import { pathToFileURL } from "node:url";',
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") {',
      '  process.stdout.write("muse 1.0.3-R2198.1\\n");',
      `  process.exit(${options?.versionExitCode ?? 0});`,
      "}",
      `await import(pathToFileURL(${JSON.stringify(mockHostPath)}).href);`,
      "",
    ].join("\n"),
  });
  return { command, dir };
}

async function makeConfigHome(withCredential: boolean) {
  const configHome = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-config-"));
  if (withCredential) {
    await NodeFSP.mkdir(NodePath.join(configHome, "muse"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(configHome, "muse", "auth.json"), "{}", "utf8");
  }
  return configHome;
}

it("marks Muse's own default model and keeps the reasoning descriptor", () => {
  const models = buildMuseModelsFromCatalog([
    { modelId: "muse-spark-1.3", displayLabel: "muse-spark-1.3", isDefault: false },
    { modelId: "muse-spark-1.3-contributor", isDefault: true },
    { modelId: "muse-spark-1.3", isDefault: false },
  ]);
  assert.deepEqual(
    models.map((model) => [model.slug, model.name, model.isDefault ?? false]),
    [
      ["muse-spark-1.3", "Muse Spark 1.3", false],
      ["muse-spark-1.3-contributor", "Muse Spark 1.3 (contributor)", true],
    ],
  );
  assert.equal(models[0]?.capabilities, MUSE_MODEL_CAPABILITIES);
  assert.equal(MUSE_MODEL_CAPABILITIES.optionDescriptors?.[0]?.id, "reasoningEffort");
});

it("falls back to T3's default, then the first row, when the catalog marks none", () => {
  const preferred = buildMuseModelsFromCatalog([
    { modelId: "muse-spark-1.2", displayLabel: "Spark 1.2" },
    { modelId: "muse-spark-1.3", displayLabel: "muse-spark-1.3" },
  ]);
  assert.deepEqual(
    preferred.map((model) => [model.slug, model.name, model.isDefault ?? false]),
    [
      ["muse-spark-1.2", "Spark 1.2", false],
      ["muse-spark-1.3", "Muse Spark 1.3", true],
    ],
  );
  const first = buildMuseModelsFromCatalog([{ modelId: "muse-spark-1.2" }]);
  assert.equal(first[0]?.isDefault, true);
  assert.deepEqual(buildMuseModelsFromCatalog([]), []);
});

it.layer(NodeServices.layer)("checkMuseProviderStatus", (it) => {
  it.effect("reports a logged-in install with models from the host catalog", () =>
    Effect.gen(function* () {
      const { command } = yield* Effect.promise(() => makeFakeMuse());
      const configHome = yield* Effect.promise(() => makeConfigHome(true));
      const snapshot = yield* checkMuseProviderStatus(
        decodeMuseSettings({ enabled: true, binaryPath: command }),
        {
          ...process.env,
          XDG_CONFIG_HOME: configHome,
          META_API_KEY: "",
        },
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.version, "1.0.3");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.equal(snapshot.auth.type, "cached_token");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["muse-spark-1.3", "muse-spark-1.3-contributor"],
      );
      assert.isTrue(
        snapshot.models.find((model) => model.isDefault)?.slug === "muse-spark-1.3-contributor",
      );
      // A fresh host has observed no provider frame yet: a failed read, not "unsupported".
      assert.equal(snapshot.usageLimits?.unavailable?.reason, "probeFailed");
    }),
  );

  it.effect("marks T3's default when the 1.3 catalog marks none and reads observed usage", () =>
    Effect.gen(function* () {
      const { command } = yield* Effect.promise(() =>
        makeFakeMuse({ env: { T3_MSP_CATALOG_DEFAULT: "0", T3_MSP_USAGE_PREOBSERVED: "1" } }),
      );
      const configHome = yield* Effect.promise(() => makeConfigHome(true));
      const snapshot = yield* checkMuseProviderStatus(
        decodeMuseSettings({ enabled: true, binaryPath: command }),
        { ...process.env, XDG_CONFIG_HOME: configHome, META_API_KEY: "" },
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.models.find((model) => model.isDefault)?.slug, "muse-spark-1.3");
      assert.isUndefined(snapshot.usageLimits?.unavailable);
      assert.deepEqual(
        snapshot.usageLimits?.windows.map((window) => [window.id, window.usedPercent]),
        [
          ["window", 37],
          ["weekly", 12],
        ],
      );
    }),
  );

  it.effect("reports an installed but logged-out CLI without listing models", () =>
    Effect.gen(function* () {
      const { command } = yield* Effect.promise(() => makeFakeMuse());
      const configHome = yield* Effect.promise(() => makeConfigHome(false));
      const snapshot = yield* checkMuseProviderStatus(
        decodeMuseSettings({ enabled: true, binaryPath: command }),
        {
          ...process.env,
          XDG_CONFIG_HOME: configHome,
          META_API_KEY: "",
        },
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.include(snapshot.message ?? "", "muse login");
    }),
  );

  it.effect("treats an API key as authentication", () =>
    Effect.gen(function* () {
      const { command } = yield* Effect.promise(() => makeFakeMuse());
      const configHome = yield* Effect.promise(() => makeConfigHome(false));
      const snapshot = yield* checkMuseProviderStatus(
        decodeMuseSettings({ enabled: true, binaryPath: command }),
        {
          ...process.env,
          XDG_CONFIG_HOME: configHome,
          META_API_KEY: "key",
        },
      );
      assert.equal(snapshot.auth.type, "api_key");
      assert.equal(snapshot.status, "ready");
    }),
  );

  it.effect("reports a missing binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkMuseProviderStatus(
        decodeMuseSettings({ enabled: true, binaryPath: "/definitely/missing/muse" }),
        process.env,
      );
      assert.equal(snapshot.installed, false);
      assert.equal(snapshot.status, "error");
    }),
  );

  it.effect("stays disabled without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkMuseProviderStatus(
        decodeMuseSettings({ enabled: false, binaryPath: "/definitely/missing/muse" }),
        process.env,
      );
      assert.equal(snapshot.status, "disabled");
      assert.equal(snapshot.models[0]?.slug, "muse-spark-1.3");
    }),
  );
});
