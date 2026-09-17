/**
 * MuseProvider — install, login, and model discovery for Meta's Muse Code CLI.
 *
 * The health check runs `muse --version`, reads login state from the credential
 * file Muse writes, and lists models plus subscription usage over a throwaway
 * MSP host. Neither read needs a session, so the probe never opens a browser
 * or touches the workspace.
 *
 * @module provider/Layers/MuseProvider
 */
import {
  MUSE_DEFAULT_MODEL,
  type CustomModelSetting,
  type ModelCapabilities,
  type MuseSettings,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { withMspHost } from "../msp/MspConnection.ts";
import {
  MSP_DEFAULT_REASONING_EFFORT,
  MSP_REASONING_EFFORTS,
  MspModelListResult,
  MspUsageReadResult,
  type MspModelCatalogEntry,
  type MspSubscriptionUsage,
} from "../msp/MspProtocol.ts";
import { museUsageToLimits } from "./museUsageLimits.ts";

const MUSE_PRESENTATION = {
  displayName: "Muse Code",
  showInteractionModeToggle: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// A handshake plus one catalog read, both local.
const MUSE_MODEL_LIST_TIMEOUT_MS = 10_000;
export const MUSE_API_KEY_ENV = "META_API_KEY";
const MUSE_CREDENTIAL_FILE = "auth.json";

const REASONING_EFFORT_LABELS: Record<(typeof MSP_REASONING_EFFORTS)[number], string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

/** Every Muse model accepts a per-turn reasoning effort, so the descriptor is static. */
export const MUSE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "reasoningEffort",
      label: "Reasoning",
      options: MSP_REASONING_EFFORTS.map((value) => ({
        value,
        label: REASONING_EFFORT_LABELS[value],
        ...(value === MSP_DEFAULT_REASONING_EFFORT ? { isDefault: true } : {}),
      })),
    }),
  ],
});

const MUSE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: MUSE_DEFAULT_MODEL,
    name: "Muse Spark 1.3",
    isCustom: false,
    isDefault: true,
    capabilities: MUSE_MODEL_CAPABILITIES,
  },
];

function museModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = MUSE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], MUSE_MODEL_CAPABILITIES);
}

function displayNameFromMuseModelId(modelId: string): string {
  const contributor = modelId.endsWith("-contributor");
  const base = contributor ? modelId.slice(0, -"-contributor".length) : modelId;
  const name = base
    .split("-")
    .map((part) => (part === "muse" ? "Muse" : part === "spark" ? "Spark" : part))
    .join(" ");
  return contributor ? `${name} (contributor)` : name;
}

/**
 * Catalog entries from `model/list`. Muse's catalog may mark no default row
 * at all (1.3 ships a bundled catalog that does not), so T3's own default
 * wins when listed and the first row otherwise. A label that merely repeats
 * the id is prettified.
 */
export function buildMuseModelsFromCatalog(
  entries: ReadonlyArray<MspModelCatalogEntry>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models = entries.flatMap((entry): ServerProviderModel[] => {
    const slug = entry.modelId.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    const label = entry.displayLabel?.trim();
    return [
      {
        slug,
        name: label && label !== slug ? label : displayNameFromMuseModelId(slug),
        isCustom: false,
        ...(entry.isDefault ? { isDefault: true } : {}),
        capabilities: MUSE_MODEL_CAPABILITIES,
      },
    ];
  });
  if (models.length === 0 || models.some((model) => model.isDefault)) return models;
  const preferred = models.findIndex((model) => model.slug === MUSE_DEFAULT_MODEL);
  const index = preferred === -1 ? 0 : preferred;
  return models.map((model, position) =>
    position === index ? { ...model, isDefault: true } : model,
  );
}

export function buildInitialMuseProviderSnapshot(
  museSettings: MuseSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = museModelsFromSettings(museSettings.customModels);
    if (!museSettings.enabled) {
      return buildServerProvider({
        presentation: MUSE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Muse Code is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Muse Code CLI availability...",
      },
    });
  });
}

const runMuseCliCommand = (
  museSettings: MuseSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = museSettings.binaryPath || "muse";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Muse stores its browser login under `$XDG_CONFIG_HOME/muse/auth.json`, falling
 * back to `~/.config/muse`. Its presence is the only login signal that does not
 * require a session, which could open a browser.
 */
export const museCredentialPath = (environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const configHome = environment.XDG_CONFIG_HOME?.trim();
    const home = environment.HOME?.trim() || environment.USERPROFILE?.trim();
    if (configHome) return path.join(configHome, "muse", MUSE_CREDENTIAL_FILE);
    if (home) return path.join(home, ".config", "muse", MUSE_CREDENTIAL_FILE);
    return undefined;
  });

const detectMuseAuth = (environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* (): Generator<
    Effect.Effect<unknown, never, FileSystem.FileSystem | Path.Path>,
    ServerProviderAuth,
    unknown
  > {
    if (environment[MUSE_API_KEY_ENV]?.trim()) {
      return { status: "authenticated", type: "api_key", label: "Meta API key" };
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const credentialPath = yield* museCredentialPath(environment);
    if (!credentialPath) return { status: "unknown" };
    const exists = yield* fileSystem.exists(credentialPath).pipe(Effect.orElseSucceed(() => false));
    return exists
      ? { status: "authenticated", type: "cached_token", label: "Meta account" }
      : { status: "unauthenticated" };
  });

interface MuseCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly usage: MspSubscriptionUsage | undefined;
}

const discoverMuseCatalog = (
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  withMspHost(
    {
      command: museSettings.binaryPath || "muse",
      args: ["serve", "--no-session-log"],
      cwd,
      env: environment,
      clientVersion: "0.0.0",
    },
    (connection) =>
      Effect.gen(function* (): Generator<Effect.Effect<unknown, unknown>, MuseCatalog, unknown> {
        const catalog = yield* connection.request("model/list", {}, MspModelListResult);
        // Hosts older than 1.3 have no usage surface; the models still count.
        const usage = yield* connection
          .request("usage/read", {}, MspUsageReadResult)
          .pipe(Effect.orElseSucceed((): MspUsageReadResult => ({})));
        return { models: buildMuseModelsFromCatalog(catalog.models), usage: usage.usage };
      }),
  );

export const checkMuseProviderStatus = Effect.fn("checkMuseProviderStatus")(function* (
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = museModelsFromSettings(museSettings.customModels);

  if (!museSettings.enabled) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Muse Code is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runMuseCliCommand(museSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Muse Code CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Muse Code CLI (`muse`) is not installed or not on PATH."
          : "Failed to execute Muse Code CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse Code CLI is installed but timed out while running `muse --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse Code CLI is installed but failed to run.",
      },
    });
  }

  const auth = yield* detectMuseAuth(environment);
  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Muse Code CLI is installed but not logged in. Run `muse login`.",
      },
    });
  }

  const catalogExit = yield* discoverMuseCatalog(museSettings, environment, cwd).pipe(
    Effect.timeoutOption(MUSE_MODEL_LIST_TIMEOUT_MS),
    Effect.exit,
  );
  const catalog = Exit.isSuccess(catalogExit)
    ? Option.getOrUndefined(catalogExit.value)
    : undefined;
  const listFailed = catalog === undefined;
  if (listFailed) {
    yield* Effect.logWarning("Muse Code model listing failed or timed out.", {
      errorTag: Exit.isFailure(catalogExit) ? causeErrorTag(catalogExit.cause) : "Timeout",
    });
  }
  const models =
    catalog && catalog.models.length > 0
      ? museModelsFromSettings(museSettings.customModels, catalog.models)
      : fallbackModels;

  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      status: listFailed ? "warning" : "ready",
      auth,
      usageLimits: museUsageToLimits(catalog?.usage, checkedAt),
      ...(listFailed
        ? {
            message:
              "Muse Code is installed but model listing failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichMuseSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Muse Code version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
