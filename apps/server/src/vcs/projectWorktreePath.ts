import * as NodePath from "node:path";

import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

export const PROJECT_WORKTREE_DIR_SEGMENTS = [".t3", "worktrees"] as const;
export const PROJECT_WORKTREE_EXCLUDE_PATTERN = ".t3/worktrees/";

export function sanitizeWorktreeBranchSegment(branchName: string): string {
  return branchName.replace(/\//g, "-");
}

export function resolveMainWorkingTreeRoot(gitCommonDir: string): string | null {
  const normalized = gitCommonDir.replace(/[\\/]+$/, "");
  if (NodePath.basename(normalized) !== ".git") {
    return null;
  }
  const parent = NodePath.dirname(normalized);
  return parent.length > 0 && parent !== normalized ? parent : null;
}

export function resolveDefaultWorktreePath(input: {
  readonly gitCommonDir: string;
  readonly branchName: string;
  readonly fallbackWorktreesDir: string;
  readonly repoName: string;
}): string {
  const sanitizedBranch = sanitizeWorktreeBranchSegment(input.branchName);
  const mainRoot = resolveMainWorkingTreeRoot(input.gitCommonDir);
  if (mainRoot !== null) {
    return NodePath.join(mainRoot, ...PROJECT_WORKTREE_DIR_SEGMENTS, sanitizedBranch);
  }
  return NodePath.join(input.fallbackWorktreesDir, input.repoName, sanitizedBranch);
}

export function excludeCoversProjectWorktrees(excludeText: string): boolean {
  return excludeText.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === ".t3" ||
      trimmed === ".t3/" ||
      trimmed === ".t3/worktrees" ||
      trimmed === ".t3/worktrees/" ||
      trimmed === "/.t3/worktrees/"
    );
  });
}

export function appendProjectWorktreeExclude(excludeText: string): string {
  if (excludeCoversProjectWorktrees(excludeText)) {
    return excludeText.endsWith("\n") || excludeText.length === 0
      ? excludeText
      : `${excludeText}\n`;
  }
  const withoutTrailingBlank = excludeText.replace(/(?:\r?\n)+$/, "");
  const prefix = withoutTrailingBlank.length === 0 ? "" : `${withoutTrailingBlank}\n`;
  return `${prefix}${PROJECT_WORKTREE_EXCLUDE_PATTERN}\n`;
}

export const ensureProjectWorktreeExclude = Effect.fn("ensureProjectWorktreeExclude")(function* (
  gitCommonDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const excludePath = path.join(gitCommonDir, "info", "exclude");
  yield* fileSystem.makeDirectory(path.dirname(excludePath), { recursive: true });
  const existing = yield* fileSystem
    .readFileString(excludePath)
    .pipe(Effect.orElseSucceed(() => ""));
  const next = appendProjectWorktreeExclude(existing);
  if (next === existing) {
    return;
  }
  yield* fileSystem.writeFileString(excludePath, next);
});
