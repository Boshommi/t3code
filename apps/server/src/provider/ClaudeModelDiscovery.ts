import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderModel } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess } from "effect/unstable/process";

import { makeClaudeEnvironment, resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { findRepositoryRoot, skillOverrideSettingsPaths } from "./Drivers/ClaudeSkills.ts";
import { spawnAndCollect } from "./providerSnapshot.ts";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const Settings = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  apiKeyHelper: Schema.optional(Schema.String),
});
const Credentials = Schema.Struct({
  claudeAiOauth: Schema.optional(Schema.Struct({ accessToken: Schema.optional(Schema.String) })),
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
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(Credentials));
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

/** Mirror Claude's profile selector; never fall back to another profile's login. */
export function claudeKeychainService(environment: NodeJS.ProcessEnv): string {
  const selector = environment.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? environment.CLAUDE_CONFIG_DIR;
  const suffix = selector
    ? `-${NodeCrypto.createHash("sha256").update(selector.normalize("NFC")).digest("hex").slice(0, 8)}`
    : "";
  return `Claude Code-credentials${suffix}`;
}

const requireForKeyring = NodeModule.createRequire(import.meta.url);
const pendingKeychainReads = new Map<string, Promise<string>>();
const readKeychainCredentials = (service: string) =>
  Effect.tryPromise(async () => {
    const { AsyncEntry } = requireForKeyring(
      "@napi-rs/keyring",
    ) as typeof import("@napi-rs/keyring");
    // A timed-out prompt can still be open. Reuse it instead of opening another on refresh.
    let pending = pendingKeychainReads.get(service);
    if (!pending) {
      pending = new AsyncEntry(service, NodeOS.userInfo().username)
        .getPassword()
        .then((value) => value ?? "{}")
        .finally(() => pendingKeychainReads.delete(service));
      pendingKeychainReads.set(service, pending);
    }
    return await pending;
  });

/** Optional discovery must not turn an unavailable model endpoint into a failed provider. */
export const discoverClaudeModels = Effect.fn("discoverClaudeModels")(
  function* (config: ClaudeSettings, environment: NodeJS.ProcessEnv, cwd?: string) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcessPlatform;
    const configDir = yield* resolveClaudeHomePath(config, environment);
    const repositoryRoot = cwd ? yield* findRepositoryRoot(cwd) : undefined;
    const settingsPaths = skillOverrideSettingsPaths(
      path,
      configDir,
      cwd,
      platform,
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
      () => new URL(env.ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_BASE_URL),
    );
    if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") return undefined;
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
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    else if (apiKey) headers["x-api-key"] = apiKey;
    else if (baseUrl.origin === ANTHROPIC_BASE_URL) {
      // Stored subscription credentials belong to Anthropic, never to a custom gateway.
      const raw =
        platform === "darwin"
          ? yield* readKeychainCredentials(claudeKeychainService(env))
          : yield* fs.readFileString(path.join(configDir, ".credentials.json"));
      const credentials = yield* decodeCredentials(raw);
      const token = credentials.claudeAiOauth?.accessToken?.trim();
      if (!token) return undefined;
      headers.authorization = `Bearer ${token}`;
      headers["anthropic-beta"] = "oauth-2025-04-20";
    }
    if (authToken && baseUrl.origin === ANTHROPIC_BASE_URL) {
      headers["anthropic-beta"] = "oauth-2025-04-20";
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
  // HTTP errors contain request headers; never log them or put them in snapshots.
  Effect.orElseSucceed(() => undefined),
);

/** Discovery owns availability; the manifest supplies presentation and CLI capabilities. */
export function resolveDiscoveredClaudeModels(
  discovered: ReadonlyArray<DiscoveredClaudeModel> | undefined,
  manifestModels: ReadonlyArray<ServerProviderModel>,
  incompatibleSlugs: ReadonlySet<string> = new Set(),
): ReadonlyArray<ServerProviderModel> {
  if (discovered === undefined) return manifestModels;
  const metadata = new Map(manifestModels.map((model) => [model.slug, model]));
  return discovered
    .filter((model) => !incompatibleSlugs.has(model.id))
    .map(
      (model) =>
        metadata.get(model.id) ?? {
          slug: model.id,
          name: model.display_name?.trim() || model.id,
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
    );
}
