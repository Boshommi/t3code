import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeKeychainService,
  discoverClaudeModels,
  resolveDiscoveredClaudeModels,
} from "./ClaudeModelDiscovery.ts";
import { SYNTHETIC_CLAUDE_MODEL_CATALOG } from "./ClaudeModelCatalog.testFixtures.ts";
import { providerModelsFromSettings } from "./providerSnapshot.ts";

const decodeSettings = Schema.decodeSync(ClaudeSettings);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const profile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  return { fs, path, directory, config: decodeSettings({ homePath: directory }) };
});
const respond = (status: number, body: unknown) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
  );
const forbidden = HttpClient.make(() => Effect.die("must not send a request"));

describe("resolveDiscoveredClaudeModels", () => {
  const manifest = SYNTHETIC_CLAUDE_MODEL_CATALOG.models.map((entry) => entry.model);
  it("uses endpoint availability, preserves known capabilities, and accepts gateway models", () => {
    const known = manifest[0]!;
    const models = resolveDiscoveredClaudeModels(
      [
        { id: known.slug, display_name: "Upstream title" },
        { id: "gateway-model", display_name: "Gateway Model" },
      ],
      manifest,
    );
    expect(models).toEqual([
      known,
      {
        slug: "gateway-model",
        name: "Gateway Model",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
    expect(resolveDiscoveredClaudeModels([], manifest)).toEqual([]);
    expect(resolveDiscoveredClaudeModels(undefined, manifest)).toBe(manifest);
  });
  it("keeps incompatible known models out and retains manually saved models", () => {
    const models = resolveDiscoveredClaudeModels(
      [{ id: "requires-new-cli" }, { id: "enabled-model" }],
      [],
      new Set(["requires-new-cli"]),
    );
    expect(
      providerModelsFromSettings(models, ["manual-model"], { optionDescriptors: [] }).map(
        (model) => [model.slug, model.isCustom],
      ),
    ).toEqual([
      ["enabled-model", false],
      ["manual-model", true],
    ]);
  });
  it("selects only the configured macOS keychain profile", () => {
    expect(claudeKeychainService({})).toBe("Claude Code-credentials");
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/abs/path" })).toBe(
      "Claude Code-credentials-6d80187b",
    );
    expect(
      claudeKeychainService({
        CLAUDE_CONFIG_DIR: "/other",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/abs/path",
      }),
    ).toBe("Claude Code-credentials-6d80187b");
    expect(
      claudeKeychainService({ CLAUDE_CONFIG_DIR: "/other", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }),
    ).toBe("Claude Code-credentials");
  });
});

effectIt.layer(NodeServices.layer)("discoverClaudeModels", (it) => {
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
      expect(
        yield* discoverClaudeModels(config, {}, cwd).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      ).toEqual([]);
    }),
  );
  it.effect("bounds optional discovery when the endpoint never responds", () =>
    Effect.gen(function* () {
      const { config } = yield* profile;
      const requested = yield* Deferred.make<void>();
      const client = HttpClient.make(() =>
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const fiber = yield* discoverClaudeModels(config, {
        ANTHROPIC_BASE_URL: "http://proxy.test",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
      yield* Deferred.await(requested);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toBeUndefined();
    }),
  );
  it.effect("uses the instance settings URL and token, then follows Anthropic pagination", () =>
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
      expect(
        yield* discoverClaudeModels(config, {}).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      ).toEqual([{ id: "model-a", display_name: "Model A" }, { id: "model-b" }]);
      expect(calls).toBe(2);
    }),
  );
  it.effect("reads a native subscription login only for the Anthropic endpoint", () =>
    Effect.gen(function* () {
      const { fs, path, directory, config } = yield* profile;
      yield* fs.writeFileString(
        path.join(directory, ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"subscription-token"}}',
      );
      const client = HttpClient.make((request) => {
        expect(request.url).toBe("https://api.anthropic.com/v1/models");
        expect(request.headers.authorization).toBe("Bearer subscription-token");
        expect(request.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ data: [{ id: "claude-model" }] })),
        );
      });
      expect(
        yield* discoverClaudeModels(config, {}).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(HostProcessPlatform, "linux"),
        ),
      ).toEqual([{ id: "claude-model" }]);
    }),
  );
  it.effect(
    "never sends a stored subscription token to a gateway and refreshes removed models",
    () =>
      Effect.gen(function* () {
        const { fs, path, directory, config } = yield* profile;
        yield* fs.writeFileString(
          path.join(directory, ".credentials.json"),
          '{"claudeAiOauth":{"accessToken":"must-stay-local"}}',
        );
        const env = { ANTHROPIC_BASE_URL: "http://proxy.test/v1" };
        let calls = 0;
        const client = HttpClient.make((request) => {
          expect(request.url).toBe("http://proxy.test/v1/models");
          expect(request.headers.authorization).toBeUndefined();
          expect(request.headers["x-api-key"]).toBeUndefined();
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                data:
                  calls++ === 0
                    ? [{ id: "claude-model" }, { id: "grok-model" }]
                    : [{ id: "claude-model" }],
              }),
            ),
          );
        });
        const discover = discoverClaudeModels(config, env).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        expect(yield* discover).toHaveLength(2);
        expect(yield* discover).toEqual([{ id: "claude-model" }]);
      }),
  );
  it.effect("isolates API keys and model responses between profiles", () =>
    Effect.gen(function* () {
      const first = yield* profile;
      const second = yield* profile;
      for (const [index, p] of [first, second].entries()) {
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
      for (const [index, p] of [first, second].entries()) {
        expect(
          yield* discoverClaudeModels(p.config, {}).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
          ),
        ).toEqual([{ id: `model-${index}` }]);
      }
    }),
  );
  it.effect("falls back on HTTP failures, malformed pages, or invalid pagination", () =>
    Effect.gen(function* () {
      const { config } = yield* profile;
      for (const client of [
        respond(401, {}),
        respond(404, {}),
        respond(200, { data: [{ id: "" }] }),
        respond(200, { data: [], has_more: true, last_id: "same-cursor" }),
      ]) {
        expect(
          yield* discoverClaudeModels(config, { ANTHROPIC_BASE_URL: "http://proxy.test" }).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
          ),
        ).toBeUndefined();
      }
    }),
  );
  it.effect("leaves cloud-specific provider discovery and unavailable logins on the manifest", () =>
    Effect.gen(function* () {
      const { config } = yield* profile;
      for (const env of [
        { CLAUDE_CODE_USE_BEDROCK: "1" },
        { CLAUDE_CODE_USE_VERTEX: "1" },
        { CLAUDE_CODE_USE_FOUNDRY: "1" },
        { ANTHROPIC_BASE_URL: "invalid URL" },
        {},
      ]) {
        expect(
          yield* discoverClaudeModels(config, env).pipe(
            Effect.provideService(HttpClient.HttpClient, forbidden),
            Effect.provideService(HostProcessPlatform, "linux"),
          ),
        ).toBeUndefined();
      }
    }),
  );
});
