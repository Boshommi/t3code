import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import {
  formatClaudeVersionUpgradeMessage,
  resolveClaudeModelsForVersion,
  resolveClaudeUpdateRequiredModels,
} from "./ClaudeModelCatalog.ts";
import { SYNTHETIC_CLAUDE_MODEL_CATALOG } from "./ClaudeModelCatalog.testFixtures.ts";
import { applyDiscoveredClaudeModels, discoverClaudeModels } from "./ClaudeModelDiscovery.ts";

const decodeSettings = Schema.decodeSync(ClaudeSettings);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const profile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-models-" });
  return { fs, path, directory, config: decodeSettings({ homePath: directory }) };
});
const reply = (body: unknown, status = 200) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
  );
const forbidden = HttpClient.make(() => Effect.die("must not send a request"));
const discover = (
  config: ClaudeSettings,
  env: NodeJS.ProcessEnv,
  client: HttpClient.HttpClient,
  cwd?: string,
) =>
  discoverClaudeModels(config, env, cwd).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    // Keep the machine-wide managed settings path off the developer's machine.
    Effect.provideService(HostProcess.Platform, "linux"),
  );

describe("applyDiscoveredClaudeModels", () => {
  const catalog = SYNTHETIC_CLAUDE_MODEL_CATALOG;
  const [known, other] = catalog.models;

  it("keeps the manifest when discovery has no answer", () => {
    expect(applyDiscoveredClaudeModels(catalog, undefined)).toBe(catalog);
  });

  it("lists only served models, reusing manifest metadata and accepting gateway models", () => {
    const applied = applyDiscoveredClaudeModels(catalog, [
      { id: "gateway-model", display_name: "Gateway Model" },
      { id: known!.model.slug, display_name: "Upstream title" },
    ]);
    expect(applied.models.map((entry) => entry.model)).toEqual([
      {
        slug: "gateway-model",
        name: "Gateway Model",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
      known!.model,
    ]);
    expect(applied.models[1]).toBe(known);
    expect(applyDiscoveredClaudeModels(catalog, []).models).toEqual([]);
  });

  it("keeps CLI compatibility for known models the endpoint serves", () => {
    const gated = {
      models: [
        { ...known!, compatibility: { minVersion: "2.0.0" } },
        { ...other!, compatibility: { minVersion: "3.0.0" } },
      ],
    };
    const applied = applyDiscoveredClaudeModels(gated, [
      { id: known!.model.slug },
      { id: "gateway-model" },
    ]);
    expect(resolveClaudeModelsForVersion(applied, "1.0.0").map((model) => model.slug)).toEqual([
      "gateway-model",
    ]);
    // A model the endpoint does not serve is neither offered nor advertised as an upgrade.
    expect(resolveClaudeUpdateRequiredModels(applied, "1.0.0").map((model) => model.slug)).toEqual([
      known!.model.slug,
    ]);
    expect(formatClaudeVersionUpgradeMessage(applied, "1.0.0")).toContain("v2.0.0");
  });
});

it.layer(NodeServices.layer)("discoverClaudeModels", (it) => {
  it.effect("uses project-local settings and a configured API key helper", () =>
    Effect.gen(function* () {
      const { fs, path, directory, config } = yield* profile;
      const cwd = path.join(directory, "project");
      yield* fs.makeDirectory(path.join(cwd, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "settings.json"),
        '{"env":{"ANTHROPIC_BASE_URL":"http://user.test"}}',
      );
      yield* fs.writeFileString(
        path.join(cwd, ".claude", "settings.local.json"),
        '// Claude settings accept comments\n{"env":{"ANTHROPIC_BASE_URL":"http://project.test"},"apiKeyHelper":"echo helper-key"}',
      );
      const client = HttpClient.make((request) => {
        expect(request.url).toBe("http://project.test/v1/models");
        expect(request.headers["x-api-key"]).toBe("helper-key");
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: [] })));
      });
      expect(yield* discover(config, {}, client, cwd)).toEqual([]);
    }),
  );

  it.effect("uses the instance settings URL and token, then follows pagination", () =>
    Effect.gen(function* () {
      const { fs, path, directory, config } = yield* profile;
      yield* fs.writeFileString(
        path.join(directory, "settings.json"),
        yield* encodeJson({
          env: {
            ANTHROPIC_BASE_URL: "http://proxy.test/anthropic/",
            ANTHROPIC_AUTH_TOKEN: "proxy-token",
          },
        }),
      );
      let calls = 0;
      const client = HttpClient.make((request) => {
        expect(request.url).toBe("http://proxy.test/anthropic/v1/models");
        expect(request.headers.authorization).toBe("Bearer proxy-token");
        expect(request.headers["anthropic-version"]).toBe("2023-06-01");
        expect(request.headers["anthropic-beta"]).toBeUndefined();
        expect(UrlParams.toString(request.urlParams)).toBe(calls === 0 ? "" : "after_id=model-a");
        calls++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              calls === 1
                ? {
                    data: [{ id: "model-a", display_name: "Model A" }],
                    has_more: true,
                    last_id: "model-a",
                  }
                : { data: [{ id: "model-b" }], has_more: false },
            ),
          ),
        );
      });
      expect(yield* discover(config, {}, client)).toEqual([
        { id: "model-a", display_name: "Model A" },
        { id: "model-b" },
      ]);
      expect(calls).toBe(2);
    }),
  );

  it.effect("never sends a stored subscription login to a gateway", () =>
    Effect.gen(function* () {
      const { fs, path, directory, config } = yield* profile;
      yield* fs.writeFileString(
        path.join(directory, ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"must-stay-local"}}',
      );
      const client = HttpClient.make((request) => {
        expect(request.url).toBe("http://proxy.test/v1/models");
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers["x-api-key"]).toBeUndefined();
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ data: [{ id: "claude-model" }] })),
        );
      });
      expect(
        yield* discover(config, { ANTHROPIC_BASE_URL: "http://proxy.test/v1" }, client),
      ).toEqual([{ id: "claude-model" }]);
    }),
  );

  it.effect("asks the Anthropic API only with explicitly configured credentials", () =>
    Effect.gen(function* () {
      const { config } = yield* profile;
      const client = HttpClient.make((request) => {
        expect(request.url).toBe("https://api.anthropic.com/v1/models");
        expect(request.headers["x-api-key"]).toBe("api-key");
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ data: [{ id: "claude-model" }] })),
        );
      });
      expect(yield* discover(config, { ANTHROPIC_API_KEY: "api-key" }, client)).toEqual([
        { id: "claude-model" },
      ]);
    }),
  );

  it.effect("isolates API keys and model responses between profiles", () =>
    Effect.gen(function* () {
      const profiles = [yield* profile, yield* profile];
      for (const [index, p] of profiles.entries()) {
        yield* p.fs.writeFileString(
          p.path.join(p.directory, "settings.json"),
          yield* encodeJson({
            env: {
              ANTHROPIC_BASE_URL: `http://profile-${index}.test`,
              ANTHROPIC_API_KEY: `key-${index}`,
            },
          }),
        );
      }
      const client = HttpClient.make((request) => {
        const index = request.url.includes("profile-0") ? 0 : 1;
        expect(request.headers["x-api-key"]).toBe(`key-${index}`);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ data: [{ id: `model-${index}` }] })),
        );
      });
      for (const [index, p] of profiles.entries()) {
        expect(yield* discover(p.config, {}, client)).toEqual([{ id: `model-${index}` }]);
      }
    }),
  );

  it.effect("bounds discovery when the endpoint never responds", () =>
    Effect.gen(function* () {
      const { config } = yield* profile;
      const requested = yield* Deferred.make<void>();
      const client = HttpClient.make(() =>
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const fiber = yield* discover(
        config,
        { ANTHROPIC_BASE_URL: "http://proxy.test" },
        client,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toBeUndefined();
    }),
  );

  it.effect("falls back on HTTP failures, malformed pages, or looping pagination", () =>
    Effect.gen(function* () {
      const { config } = yield* profile;
      for (const client of [
        reply({}, 401),
        reply({}, 404),
        reply({ data: [{ id: "" }] }),
        reply({ data: [], has_more: true, last_id: "same-cursor" }),
      ]) {
        expect(
          yield* discover(config, { ANTHROPIC_BASE_URL: "http://proxy.test" }, client),
        ).toBeUndefined();
      }
    }),
  );

  it.effect("leaves subscription logins and cloud providers on the manifest", () =>
    Effect.gen(function* () {
      const { config } = yield* profile;
      for (const env of [
        {},
        { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
        { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "key" },
        { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_API_KEY: "key" },
        { CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_API_KEY: "key" },
        { ANTHROPIC_BASE_URL: "invalid URL" },
      ]) {
        expect(yield* discover(config, env, forbidden)).toBeUndefined();
      }
    }),
  );
});
