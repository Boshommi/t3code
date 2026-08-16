import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  loadPreviewWebviewConfig,
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
} from "./previewWebviewConfigState";

const environmentId = EnvironmentId.make("environment-1");

describe("loadPreviewWebviewConfig", () => {
  it.effect("reports a structurally distinct missing-bridge failure", () =>
    Effect.gen(function* () {
      const error = yield* loadPreviewWebviewConfig(environmentId, undefined, null).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(PreviewWebviewBridgeUnavailableError);
      expect(error.environmentId).toBe(environmentId);
      expect(error.message).toContain(environmentId);
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves the bridge rejection as the load failure cause", () =>
    Effect.gen(function* () {
      const cause = new Error("ipc unavailable");
      const error = yield* loadPreviewWebviewConfig(environmentId, undefined, {
        getPreviewConfig: () => Promise.reject(cause),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(PreviewWebviewConfigLoadError);
      expect(error.environmentId).toBe(environmentId);
      expect(error.cause).toBe(cause);
      expect(error.message).not.toContain(cause.message);
    }),
  );

  it.effect("forwards the environment id, profile, and locality to the bridge", () =>
    Effect.gen(function* () {
      let requested: {
        environmentId: EnvironmentId;
        profileId: string | undefined;
        environmentIsLoopback: boolean | undefined;
      } | null = null;
      const config = {
        partition: "persist:test-preview",
        webPreferences: "sandbox=yes",
        preloadUrl: null,
      };
      const result = yield* loadPreviewWebviewConfig(
        environmentId,
        "work",
        {
          getPreviewConfig: (requestedEnvironmentId, profileId, environmentIsLoopback) => {
            requested = {
              environmentId: requestedEnvironmentId,
              profileId,
              environmentIsLoopback,
            };
            return Promise.resolve(config);
          },
        },
        false,
      );

      // The partition is derived in main from environment + profile; SOCKS
      // attach depends on whether this environment is already loopback.
      expect(requested).toEqual({
        environmentId,
        profileId: "work",
        environmentIsLoopback: false,
      });
      expect(result).toEqual(config);
    }),
  );

  it.effect("defaults to a local session so desktop does not attach the loopback proxy", () =>
    Effect.gen(function* () {
      let requestedLoopback: boolean | undefined;
      yield* loadPreviewWebviewConfig(environmentId, undefined, {
        getPreviewConfig: (_input, _profileId, environmentIsLoopback) => {
          requestedLoopback = environmentIsLoopback;
          return Promise.resolve({
            partition: "persist:test-preview",
            webPreferences: "sandbox=yes",
            preloadUrl: null,
          });
        },
      });

      expect(requestedLoopback).toBe(true);
    }),
  );
});
