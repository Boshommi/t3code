import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

/**
 * A shadow home is an account-specific config directory whose entries link
 * back to a shared one, so several logins share conversations and settings
 * while each keeps its own credentials.
 */
export interface ShadowHomePolicy {
  /** Provider name used in error messages. */
  readonly label: string;
  /** Created in the shared home up front, so the CLI never makes a local copy first. */
  readonly knownSharedDirectories: ReadonlyArray<string>;
  /** Account-owned entries. They are never linked, and a stray link to them is removed. */
  readonly privateEntries: ReadonlySet<string>;
  /** The login file. It may be missing, but must never be a link into the shared home. */
  readonly credentialEntry: string;
  /** Entries each home keeps for itself and that are left untouched. */
  readonly localEntries: ReadonlySet<string>;
  /** What to do when a shared entry already exists locally as a real file or directory. */
  readonly onLocalCopy: (entryName: string) => "error" | "replace" | "keep";
}

const ShadowHomeContext = {
  label: Schema.String,
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class ShadowHomeFileSystemError extends Schema.TaggedError<ShadowHomeFileSystemError>()(
  "ShadowHomeFileSystemError",
  {
    ...ShadowHomeContext,
    operation: Schema.Literals(["readLink", "makeDirectory", "readDirectory", "remove", "symlink"]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `${this.label} shadow home filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class ShadowHomePathConflictError extends Schema.TaggedError<ShadowHomePathConflictError>()(
  "ShadowHomePathConflictError",
  ShadowHomeContext,
) {
  override get message(): string {
    return `${this.label} shadow home path '${this.effectiveHomePath}' must be different from the shared home path '${this.sharedHomePath}'.`;
  }
}

export class ShadowHomeEntryConflictError extends Schema.TaggedError<ShadowHomeEntryConflictError>()(
  "ShadowHomeEntryConflictError",
  {
    ...ShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot create ${this.label} shadow home entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink.`;
  }
}

export class ShadowHomePrivateEntrySymlinkError extends Schema.TaggedError<ShadowHomePrivateEntrySymlinkError>()(
  "ShadowHomePrivateEntrySymlinkError",
  {
    ...ShadowHomeContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `${this.label} shadow home private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

export const ShadowHomeError = Schema.Union([
  ShadowHomeFileSystemError,
  ShadowHomePathConflictError,
  ShadowHomeEntryConflictError,
  ShadowHomePrivateEntrySymlinkError,
]);
export type ShadowHomeError = typeof ShadowHomeError.Type;

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

interface ShadowHomeTarget {
  readonly label: string;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
}

export const materializeShadowHome = Effect.fn("materializeShadowHome")(function* (
  policy: ShadowHomePolicy,
  homes: { readonly sharedHomePath: string; readonly effectiveHomePath: string },
): Effect.fn.Return<void, ShadowHomeError, FileSystem.FileSystem | Path.Path> {
  const target: ShadowHomeTarget = { label: policy.label, ...homes };
  const { sharedHomePath, effectiveHomePath } = homes;
  if (sharedHomePath === effectiveHomePath) {
    return yield* new ShadowHomePathConflictError(target);
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const fileSystemError =
    (operation: ShadowHomeFileSystemError["operation"], filePath: string, extra = {}) =>
    (cause: PlatformError.PlatformError) =>
      new ShadowHomeFileSystemError({ ...target, operation, path: filePath, ...extra, cause });

  const readLinkState = (entryName: string, linkPath: string) =>
    fileSystem.readLink(linkPath).pipe(
      Effect.map((linkTarget): LinkState => ({ _tag: "Symlink", target: linkTarget })),
      Effect.catchTags({
        PlatformError: (cause) => {
          if (cause.reason._tag === "NotFound")
            return Effect.succeed<LinkState>({ _tag: "Missing" });
          if (isNotSymlinkError(cause)) return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
          return Effect.fail(fileSystemError("readLink", linkPath, { entryName })(cause));
        },
      }),
    );

  const remove = (entryName: string, filePath: string, recursive = false) =>
    fileSystem
      .remove(filePath, recursive ? { recursive: true } : undefined)
      .pipe(Effect.mapError(fileSystemError("remove", filePath, { entryName })));

  const ensureSymlink = Effect.fnUntraced(function* (entryName: string) {
    const linkTarget = path.join(sharedHomePath, entryName);
    const link = path.join(effectiveHomePath, entryName);
    const createLink = fileSystem
      .symlink(linkTarget, link)
      .pipe(
        Effect.mapError(fileSystemError("symlink", link, { targetPath: linkTarget, entryName })),
      );
    const state = yield* readLinkState(entryName, link);
    if (state._tag === "Missing") return yield* createLink;
    if (state._tag === "NotSymlink") {
      const decision = policy.onLocalCopy(entryName);
      if (decision === "keep") return;
      if (decision === "error") {
        return yield* new ShadowHomeEntryConflictError({
          ...target,
          entryName,
          linkPath: link,
          targetPath: linkTarget,
        });
      }
      yield* remove(entryName, link, true);
      return yield* createLink;
    }
    if (path.resolve(path.dirname(link), state.target) !== linkTarget) {
      yield* remove(entryName, link);
      yield* createLink;
    }
  });

  const makeDirectory = (directoryPath: string) =>
    fileSystem
      .makeDirectory(directoryPath, { recursive: true })
      .pipe(Effect.mapError(fileSystemError("makeDirectory", directoryPath)));

  yield* Effect.all(
    [
      makeDirectory(sharedHomePath),
      makeDirectory(effectiveHomePath),
      ...policy.knownSharedDirectories.map((directory) =>
        makeDirectory(path.join(sharedHomePath, directory)),
      ),
    ],
    { concurrency: "unbounded" },
  );

  const sharedEntryNames = yield* fileSystem
    .readDirectory(sharedHomePath)
    .pipe(Effect.mapError(fileSystemError("readDirectory", sharedHomePath)));
  const entries = new Set<string>(policy.knownSharedDirectories);
  for (const entryName of sharedEntryNames) {
    if (!policy.privateEntries.has(entryName) && !policy.localEntries.has(entryName)) {
      entries.add(entryName);
    }
  }

  yield* Effect.forEach(
    policy.privateEntries,
    Effect.fnUntraced(function* (entryName) {
      if (entryName === policy.credentialEntry) return;
      const privatePath = path.join(effectiveHomePath, entryName);
      const state = yield* readLinkState(entryName, privatePath);
      if (state._tag === "Symlink") yield* remove(entryName, privatePath);
    }),
    { discard: true },
  );

  yield* Effect.forEach(
    entries,
    (entryName) => (policy.privateEntries.has(entryName) ? Effect.void : ensureSymlink(entryName)),
    { discard: true },
  );

  const credentialPath = path.join(effectiveHomePath, policy.credentialEntry);
  const credentialState = yield* readLinkState(policy.credentialEntry, credentialPath);
  if (credentialState._tag === "Symlink") {
    return yield* new ShadowHomePrivateEntrySymlinkError({
      ...target,
      entryName: policy.credentialEntry,
      path: credentialPath,
    });
  }
});
