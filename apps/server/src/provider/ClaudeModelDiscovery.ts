import type { ClaudeSettings } from "@t3tools/contracts";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess } from "effect/process";

import type { ClaudeModelCatalog } from "./ClaudeModelCatalog.ts";
import { makeClaudeEnvironment, resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { findRepositoryRoot, skillOverrideSettingsPaths } from "./Drivers/ClaudeSkills.ts";

const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";
const Settings = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  apiKeyHelper: Schema.optional(Schema.String),
});
const Model = Schema.Struct({
  id: Schema.Trimmed.check(Schema.isMinLength(1)),
  display_name: Schema.optional(Schema.String),
});
const ModelPage = Schema.Struct({
  data: Schema.Array(Model),
  has_more: Schema.optional(Schema.Boolean),
  last_id: Schema.optional(Schema.NullOr(Schema.String)),
});
export type DiscoveredClaudeModel = typeof Model.Type;
const decodeSettings = Schema.decodeEffect(fromLenientJson(Settings));
const decodeModelPage = HttpClientResponse.schemaBodyJson(ModelPage);

const readSettings = Effect.fn("ClaudeModelDiscovery.readSettings")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
    Effect.flatMap(decodeSettings),
  );
});

/**
 * Lists the models a configured API serves (`ANTHROPIC_BASE_URL` gateway, or
 * explicit API credentials), resolving env and `apiKeyHelper` from the same
 * settings files Claude Code reads. `undefined` means "no answer": a plain
 * subscription login, a cloud provider, or any failure keeps the manifest.
 */
export const discoverClaudeModels = Effect.fn("discoverClaudeModels")(
  function* (config: ClaudeSettings, environment: NodeJS.ProcessEnv, cwd?: string) {
    const path = yield* Path.Path;
    const configDir = yield* resolveClaudeHomePath(config, environment);
    const repositoryRoot = cwd ? yield* findRepositoryRoot(cwd) : undefined;
    const settingsPaths = skillOverrideSettingsPaths(
      path,
      configDir,
      cwd,
      yield* HostProcess.Platform,
      environment,
      repositoryRoot,
    );
    const env = { ...(yield* makeClaudeEnvironment(config, environment)) };
    let apiKeyHelper: string | undefined;
    for (const file of settingsPaths) {
      const settings = yield* readSettings(file);
      Object.assign(env, settings.env);
      apiKeyHelper = settings.apiKeyHelper ?? apiKeyHelper;
    }
    if (
      env.CLAUDE_CODE_USE_BEDROCK === "1" ||
      env.CLAUDE_CODE_USE_VERTEX === "1" ||
      env.CLAUDE_CODE_USE_FOUNDRY === "1"
    )
      return undefined;

    const baseUrl = yield* Effect.try(
      () => new URL(env.ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_API_ORIGIN),
    );
    if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") return undefined;
    const firstParty = baseUrl.origin === ANTHROPIC_API_ORIGIN;
    const basePath = baseUrl.pathname.replace(/\/+$/, "");
    baseUrl.pathname = basePath + (basePath.endsWith("/v1") ? "/models" : "/v1/models");
    baseUrl.search = "";
    baseUrl.hash = "";

    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
    const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    let apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!authToken && !apiKey && apiKeyHelper?.trim()) {
      const result = yield* spawnAndCollect(
        apiKeyHelper,
        ChildProcess.make(apiKeyHelper, { shell: true, env, ...(cwd ? { cwd } : {}) }),
      );
      if (result.code !== 0) return undefined;
      apiKey = result.stdout.trim();
    }
    if (authToken) {
      headers.authorization = `Bearer ${authToken}`;
      if (firstParty) headers["anthropic-beta"] = "oauth-2025-04-20";
    } else if (apiKey) {
      headers["x-api-key"] = apiKey;
    } else if (firstParty) {
      // A subscription login has no configured API to ask; the manifest owns it.
      return undefined;
    }

    const client = yield* HttpClient.HttpClient;
    const models = new Map<string, DiscoveredClaudeModel>();
    const cursors = new Set<string>();
    let afterId: string | undefined;
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const response = yield* client.execute(
        HttpClientRequest.get(baseUrl.toString(), {
          headers,
          ...(afterId ? { urlParams: { after_id: afterId } } : {}),
        }),
      );
      const page = yield* decodeModelPage(yield* HttpClientResponse.filterStatusOk(response));
      for (const model of page.data) models.set(model.id, model);
      if (!page.has_more) return [...models.values()];
      if (!page.last_id || cursors.has(page.last_id)) return undefined;
      cursors.add(page.last_id);
      afterId = page.last_id;
    }
    return undefined;
  },
  Effect.timeout("10 seconds"),
  // HTTP errors carry request headers; never log them or put them in snapshots.
  Effect.orElseSucceed(() => undefined),
);

/**
 * The endpoint owns availability and order; the manifest still supplies
 * presentation, capabilities, and CLI compatibility for the models it knows.
 */
export function applyDiscoveredClaudeModels(
  catalog: ClaudeModelCatalog,
  discovered: ReadonlyArray<DiscoveredClaudeModel> | undefined,
): ClaudeModelCatalog {
  if (discovered === undefined) return catalog;
  const known = new Map(catalog.models.map((entry) => [entry.model.slug, entry]));
  return {
    models: discovered.map(
      (model) =>
        known.get(model.id) ?? {
          model: {
            slug: model.id,
            name: model.display_name?.trim() || model.id,
            isCustom: false,
            capabilities: { optionDescriptors: [] },
          },
          runtime: {},
          compatibility: {},
        },
    ),
  };
}
