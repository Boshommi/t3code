# Worktrees

A new worktree is a separate checkout of your project, so the agent can work on a branch without
touching your current files.

T3 Code creates one when you start a thread in **New worktree** mode, check out a pull request into
a worktree, or create a worktree from Git actions.

Git does not include ignored files. After the checkout exists, T3 Code copies `.env` and `.env.*`
files from the project you added — including nested files like `apps/web/.env.local` — so the new
tree has the same local secrets. Files that are already in the worktree are left alone. Setup
scripts run after that copy.
