import { describe, expect, it } from "vite-plus/test";

import {
  appendProjectWorktreeExclude,
  excludeCoversProjectWorktrees,
  resolveDefaultWorktreePath,
  resolveMainWorkingTreeRoot,
  sanitizeWorktreeBranchSegment,
} from "./projectWorktreePath.ts";

describe("projectWorktreePath", () => {
  it("resolves the main working tree from a standard .git common dir", () => {
    expect(resolveMainWorkingTreeRoot("/repo/.git")).toBe("/repo");
    expect(resolveMainWorkingTreeRoot("/repo/.git/")).toBe("/repo");
    expect(resolveMainWorkingTreeRoot("/bare/repo.git")).toBeNull();
  });

  it("places new worktrees under the project's .t3/worktrees folder", () => {
    expect(
      resolveDefaultWorktreePath({
        gitCommonDir: "/Users/ada/src/app/.git",
        branchName: "feat/login",
        fallbackWorktreesDir: "/Users/ada/.t3/worktrees",
        repoName: "app",
      }),
    ).toBe("/Users/ada/src/app/.t3/worktrees/feat-login");
  });

  it("falls back to the T3 home worktrees dir for bare repositories", () => {
    expect(
      resolveDefaultWorktreePath({
        gitCommonDir: "/srv/app.git",
        branchName: "main",
        fallbackWorktreesDir: "/Users/ada/.t3/worktrees",
        repoName: "app",
      }),
    ).toBe("/Users/ada/.t3/worktrees/app/main");
  });

  it("sanitizes slashes in branch names", () => {
    expect(sanitizeWorktreeBranchSegment("feat/a/b")).toBe("feat-a-b");
  });

  it("does not rewrite an exclude that already covers .t3 worktrees", () => {
    expect(excludeCoversProjectWorktrees(".t3/\n")).toBe(true);
    expect(excludeCoversProjectWorktrees("# comment\n.t3/worktrees/\n")).toBe(true);
    expect(appendProjectWorktreeExclude("*~\n")).toBe("*~\n.t3/worktrees/\n");
    expect(appendProjectWorktreeExclude(".t3/worktrees/\n")).toBe(".t3/worktrees/\n");
  });
});
