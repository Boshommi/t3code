import { useAtomValue } from "@effect/atom-react";
import {
  type DesktopPreviewBridge,
  type DesktopPreviewWebviewConfig,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";

const PREVIEW_CONFIG_STALE_TIME_MS = 5 * 60_000;
const PREVIEW_CONFIG_IDLE_TTL_MS = 10 * 60_000;

export class PreviewWebviewBridgeUnavailableError extends Schema.TaggedErrorClass<PreviewWebviewBridgeUnavailableError>()(
  "PreviewWebviewBridgeUnavailableError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `Desktop preview configuration is unavailable for environment "${this.environmentId}".`;
  }
}

export class PreviewWebviewConfigLoadError extends Schema.TaggedErrorClass<PreviewWebviewConfigLoadError>()(
  "PreviewWebviewConfigLoadError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load desktop preview configuration for environment "${this.environmentId}".`;
  }
}

export const PreviewWebviewConfigError = Schema.Union([
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
]);
export type PreviewWebviewConfigError = typeof PreviewWebviewConfigError.Type;

type PreviewConfigBridge = Pick<DesktopPreviewBridge, "getPreviewConfig">;

export const loadPreviewWebviewConfig = (
  environmentId: EnvironmentId,
  profileId?: string,
  bridge: PreviewConfigBridge | null = previewBridge,
  environmentIsLoopback = true,
): Effect.Effect<DesktopPreviewWebviewConfig, PreviewWebviewConfigError> => {
  if (bridge === null) {
    return Effect.fail(new PreviewWebviewBridgeUnavailableError({ environmentId }));
  }

  return Effect.tryPromise({
    try: () => bridge.getPreviewConfig(environmentId, profileId, environmentIsLoopback),
    catch: (cause) => new PreviewWebviewConfigLoadError({ environmentId, cause }),
  });
};

/**
 * `Atom.family` keys on its argument, so environment, profile, and locality
 * are folded into one string: passing an object would allocate a fresh entry
 * on every render.
 *
 * The profile is the middle field, so an id containing the delimiter
 * round-trips whole instead of being truncated into a different profile's key.
 * `BrowserProfileId` rejects control characters, which is what makes the
 * environment side of the split unambiguous. Locality is the last field.
 */
const CONFIG_KEY_DELIMITER = "\u0000";

const configKey = (
  environmentId: EnvironmentId,
  profileId: string | undefined,
  environmentIsLoopback: boolean,
): string =>
  `${environmentId}${CONFIG_KEY_DELIMITER}${profileId ?? ""}${CONFIG_KEY_DELIMITER}${environmentIsLoopback ? "loopback" : "remote"}`;

const parseConfigKey = (
  key: string,
): { environmentId: EnvironmentId; profileId?: string; environmentIsLoopback: boolean } => {
  const first = key.indexOf(CONFIG_KEY_DELIMITER);
  const environmentId = (first === -1 ? key : key.slice(0, first)) as EnvironmentId;
  const rest = first === -1 ? "" : key.slice(first + CONFIG_KEY_DELIMITER.length);
  const last = rest.lastIndexOf(CONFIG_KEY_DELIMITER);
  const profileId = last === -1 ? rest : rest.slice(0, last);
  const locality = last === -1 ? "loopback" : rest.slice(last + CONFIG_KEY_DELIMITER.length);
  return {
    environmentId,
    ...(profileId === "" ? {} : { profileId }),
    environmentIsLoopback: locality !== "remote",
  };
};

const previewWebviewConfigAtom = Atom.family((key: string) => {
  const { environmentId, profileId, environmentIsLoopback } = parseConfigKey(key);
  return Atom.make(
    loadPreviewWebviewConfig(environmentId, profileId, previewBridge, environmentIsLoopback),
  ).pipe(
    Atom.swr({
      staleTime: PREVIEW_CONFIG_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PREVIEW_CONFIG_IDLE_TTL_MS),
    Atom.withLabel(`preview:webview-config:${key}`),
  );
});

export function usePreviewWebviewConfig(
  environmentId: EnvironmentId,
  profileId?: string,
  environmentIsLoopback = true,
): DesktopPreviewWebviewConfig | null {
  const result = useAtomValue(
    previewWebviewConfigAtom(configKey(environmentId, profileId, environmentIsLoopback)),
  );
  return Option.getOrNull(AsyncResult.value(result));
}
