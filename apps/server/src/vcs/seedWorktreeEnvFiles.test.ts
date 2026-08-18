import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  copyWorktreeEnvFiles,
  isWorktreeEnvFileName,
  selectWorktreeEnvRelativePaths,
} from "./seedWorktreeEnvFiles.ts";

describe("seedWorktreeEnvFiles", () => {
  it("accepts dotenv file names and rejects .envrc", () => {
    assert.isTrue(isWorktreeEnvFileName(".env"));
    assert.isTrue(isWorktreeEnvFileName(".env.local"));
    assert.isTrue(isWorktreeEnvFileName(".env.development.local"));
    assert.isFalse(isWorktreeEnvFileName(".envrc"));
    assert.isFalse(isWorktreeEnvFileName(".environment"));
    assert.isFalse(isWorktreeEnvFileName("env"));
  });

  it("keeps nested env paths and drops traversal or non-env names", () => {
    assert.deepEqual(
      selectWorktreeEnvRelativePaths([
        ".env",
        "apps/web/.env.local",
        ".envrc",
        "../.env",
        "/tmp/.env",
        "apps/web/.envrc",
        "apps/web/.env.local",
        "C:\\.env",
      ]),
      [".env", "apps/web/.env.local"],
    );
  });

  it.layer(NodeServices.layer)(
    "copies missing env files and leaves existing dest files alone",
    (it) => {
      it.effect("copies only the selected env files", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sourceCwd = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-seed-env-src-",
          });
          const worktreePath = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-seed-env-dest-",
          });

          yield* fileSystem.writeFileString(path.join(sourceCwd, ".env"), "ROOT=1\n");
          yield* fileSystem.makeDirectory(path.join(sourceCwd, "apps", "web"), { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(sourceCwd, "apps", "web", ".env.local"),
            "WEB=1\n",
          );
          yield* fileSystem.writeFileString(path.join(sourceCwd, ".envrc"), "export IGNORE=1\n");
          yield* fileSystem.writeFileString(path.join(worktreePath, ".env.example"), "EXAMPLE=1\n");

          yield* copyWorktreeEnvFiles({
            sourceCwd,
            worktreePath,
            relativePaths: [".env", "apps/web/.env.local", ".envrc", ".env.example"],
          });

          assert.equal(
            yield* fileSystem.readFileString(path.join(worktreePath, ".env")),
            "ROOT=1\n",
          );
          assert.equal(
            yield* fileSystem.readFileString(path.join(worktreePath, "apps", "web", ".env.local")),
            "WEB=1\n",
          );
          assert.equal(yield* fileSystem.exists(path.join(worktreePath, ".envrc")), false);
          assert.equal(
            yield* fileSystem.readFileString(path.join(worktreePath, ".env.example")),
            "EXAMPLE=1\n",
          );
        }),
      );

      it.effect("does not overwrite an env file already in the worktree", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sourceCwd = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-seed-env-src-",
          });
          const worktreePath = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-seed-env-dest-",
          });

          yield* fileSystem.writeFileString(path.join(sourceCwd, ".env"), "FROM_SOURCE=1\n");
          yield* fileSystem.writeFileString(path.join(worktreePath, ".env"), "ALREADY_THERE=1\n");

          yield* copyWorktreeEnvFiles({
            sourceCwd,
            worktreePath,
            relativePaths: [".env"],
          });

          assert.equal(
            yield* fileSystem.readFileString(path.join(worktreePath, ".env")),
            "ALREADY_THERE=1\n",
          );
        }),
      );
    },
  );
});
