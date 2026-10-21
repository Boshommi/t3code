import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";

/**
 * An empty setting (the default) puts each project's worktrees inside its main
 * checkout at `<checkout>/.t3/worktrees/<branch>`, falling back to `defaultDir` when
 * the git folder is not `<checkout>/.git`. This folder stays managed after the setting changes.
 */
export const PROJECT_WORKTREES_SEGMENTS = [".t3", "worktrees"] as const;

export function projectWorktreesDirectory(projectRoot: string, path: Path.Path): string {
  return path.join(projectRoot, ...PROJECT_WORKTREES_SEGMENTS);
}

/** `info/exclude` text that keeps in-project worktrees out of the main checkout's status. */
export function withProjectWorktreesExcluded(excludeText: string): string {
  const covered = new Set([".t3", ".t3/worktrees"]);
  const isCovered = excludeText
    .split(/\r?\n/)
    .some((line) => covered.has(line.trim().replace(/^\//, "").replace(/\/$/, "")));
  if (isCovered) return excludeText;
  const separator = excludeText === "" || excludeText.endsWith("\n") ? "" : "\n";
  return `${excludeText}${separator}/${PROJECT_WORKTREES_SEGMENTS.join("/")}/\n`;
}

/**
 * Where an absolute setting puts worktrees: `<folder>/<repo>/<branch>`. The empty
 * default resolves to `defaultDir` here, its fallback when there is no main checkout.
 * Null when the setting is not an absolute path on this machine, such as `D:\worktrees`
 * configured for a Windows server and synced to a Linux one, or when it is a filesystem root,
 * which would make every path on that drive look managed.
 */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
  home: string,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePath(setting, home);
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  return isFilesystemRoot(resolved, path) ? null : resolved;
}

/** Callers re-check after resolving symlinks: a link can point at a root. */
export function isFilesystemRoot(directory: string, path: Path.Path): boolean {
  return path.dirname(directory) === directory;
}

export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
  },
  defaultDir: string,
  path: Path.Path,
  home: string,
): ReadonlyArray<string> {
  const directories = new Set([defaultDir]);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path, home);
    if (directory !== null) directories.add(directory);
  }
  return [...directories];
}

/**
 * A thread's path and branch can come from a client, so a missing worktree is
 * only recreated where the server would have put it, compared by real path:
 * `<managed worktrees folder>/<repo>/<branch>`, or `<project>/.t3/worktrees/<branch>`
 * for the thread's own project, whose root the caller reads from the server's store.
 */
export const makeIsManagedWorktreePath = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  // Where git would create `target`: the real path of its nearest existing
  // ancestor plus the missing rest, since git follows symlinks on the way.
  const realLocation = (target: string): Effect.Effect<string> =>
    fileSystem.realPath(target).pipe(
      Effect.catch(() => {
        const parent = path.dirname(target);
        return parent === target
          ? Effect.succeed(target)
          : Effect.map(realLocation(parent), (real) => path.join(real, path.basename(target)));
      }),
    );

  const isWithin = (root: string, candidate: string, depth: number) => {
    if (isFilesystemRoot(root, path)) return false;
    const relative = path.relative(root, candidate);
    const segments = relative.split(path.sep);
    return (
      !path.isAbsolute(relative) &&
      segments.length === depth &&
      segments.every((segment) => segment !== "" && segment !== "..")
    );
  };

  return Effect.fn("worktreesDirectory.isManagedWorktreePath")(function* (
    worktreePath: string,
    projectRoot: string,
  ) {
    // git resolves a relative path against the project, not the server cwd.
    if (!path.isAbsolute(worktreePath)) return false;
    // Server-made paths are normalized. A `..` would be applied after git
    // follows a symlink but before realPath does, so the two disagree.
    if (path.resolve(worktreePath) !== worktreePath) return false;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => ({
        worktreesDirectory: "",
        previousWorktreesDirectories: [],
      })),
    );
    const roots = yield* Effect.forEach(
      managedWorktreesDirectories(
        settings,
        serverConfig.worktreesDir,
        path,
        yield* HostProcess.HomeDirectory,
      ),
      realLocation,
    );
    const candidate = yield* realLocation(worktreePath);
    if (roots.some((root) => isWithin(root, candidate, 2))) return true;
    if (!path.isAbsolute(projectRoot)) return false;
    // Lexical below the project's real root, so a `.t3` symlink in the repo cannot point it elsewhere.
    const realProjectRoot = yield* realLocation(path.resolve(projectRoot));
    return isWithin(projectWorktreesDirectory(realProjectRoot, path), candidate, 1);
  });
});
