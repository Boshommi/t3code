import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const WORKTREE_ENV_FILE_PATHSPECS = [":(glob)**/.env", ":(glob)**/.env.*"] as const;

export function isWorktreeEnvFileName(fileName: string): boolean {
  return fileName === ".env" || fileName.startsWith(".env.");
}

export function worktreeEnvFilePathspecs(): ReadonlyArray<string> {
  return WORKTREE_ENV_FILE_PATHSPECS;
}

// Git --full-name paths use `/`. Reject anything that would write outside the
// new worktree or is not an env file.
export function selectWorktreeEnvRelativePaths(relativePaths: Iterable<string>): string[] {
  const selected = new Set<string>();
  for (const relativePath of relativePaths) {
    const normalized = normalizeWorktreeEnvRelativePath(relativePath);
    if (normalized === null) {
      continue;
    }
    const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
    if (!isWorktreeEnvFileName(fileName)) {
      continue;
    }
    selected.add(normalized);
  }
  return [...selected];
}

export const copyWorktreeEnvFiles = Effect.fn("copyWorktreeEnvFiles")(function* (input: {
  readonly sourceCwd: string;
  readonly worktreePath: string;
  readonly relativePaths: ReadonlyArray<string>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (input.sourceCwd === input.worktreePath) {
    return;
  }

  for (const relativePath of selectWorktreeEnvRelativePaths(input.relativePaths)) {
    const segments = relativePath.split("/");
    const sourcePath = path.join(input.sourceCwd, ...segments);
    const destinationPath = path.join(input.worktreePath, ...segments);
    const sourceExists = yield* fileSystem.exists(sourcePath);
    if (!sourceExists) {
      continue;
    }
    const destinationExists = yield* fileSystem.exists(destinationPath);
    if (destinationExists) {
      continue;
    }
    yield* fileSystem.makeDirectory(path.dirname(destinationPath), { recursive: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Failed to create worktree env file directory", {
          destinationPath,
          cause: error,
        }),
      ),
    );
    yield* fileSystem.copyFile(sourcePath, destinationPath).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Failed to copy worktree env file", {
          sourcePath,
          destinationPath,
          cause: error,
        }),
      ),
    );
  }
});

function normalizeWorktreeEnvRelativePath(relativePath: string): string | null {
  const trimmed = relativePath.trim().replaceAll("\\", "/");
  if (trimmed.length === 0 || trimmed.startsWith("/") || trimmed.includes(":")) {
    return null;
  }
  const segments = trimmed.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    return null;
  }
  return segments.join("/");
}
