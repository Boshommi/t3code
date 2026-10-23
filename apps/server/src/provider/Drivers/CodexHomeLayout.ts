import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { materializeShadowHome, type ShadowHomePolicy } from "./ShadowHome.ts";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
] as const;

const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json"]);
// Finder maintains metadata separately for each directory, including shadow homes.
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp", ".DS_Store"]);
// Codex creates these runtime locks itself when it starts in a shadow home before the shared
// home has one. They guard shared state, so a local copy is replaced with the shared link.
const REPLACEABLE_SHARED_RUNTIME_ENTRIES = new Set(["mcp-oauth-locks", ".sqlite-maintenance.lock"]);

function resolveHomePath(path: Path.Path, home: string, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0 ? expandHomePath(value, home) : path.join(home, ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const sharedHomePath = resolveHomePath(path, home, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath, home));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

const CODEX_SHADOW_HOME_POLICY: ShadowHomePolicy = {
  label: "Codex",
  knownSharedDirectories: KNOWN_SHARED_DIRECTORIES,
  privateEntries: PRIVATE_ENTRY_NAMES,
  credentialEntry: "auth.json",
  localEntries: SHADOW_LOCAL_ENTRY_NAMES,
  onLocalCopy: (entryName) =>
    REPLACEABLE_SHARED_RUNTIME_ENTRIES.has(entryName) ? "replace" : "error",
};

export {
  ShadowHomeEntryConflictError as CodexShadowHomeEntryConflictError,
  ShadowHomeError as CodexShadowHomeError,
  ShadowHomeFileSystemError as CodexShadowHomeFileSystemError,
  ShadowHomePathConflictError as CodexShadowHomePathConflictError,
  ShadowHomePrivateEntrySymlinkError as CodexShadowHomePrivateEntrySymlinkError,
} from "./ShadowHome.ts";

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
) {
  if (layout.mode !== "authOverlay" || !layout.effectiveHomePath) return;
  yield* materializeShadowHome(CODEX_SHADOW_HOME_POLICY, {
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath: layout.effectiveHomePath,
  });
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
