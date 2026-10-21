import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import ProjectionThreadSideMessages from "./Migrations/068_ProjectionThreadSideMessages.ts";
import PromptStash from "./Migrations/069_PromptStash.ts";

// A database from the fork: its own tables at 53-56, then 57 replaying upstream's 53 and 54.
const seedForkDatabase = (history: ReadonlyArray<readonly [number, string]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* ProjectionThreadSideMessages;
    yield* PromptStash;
    for (const [id, name] of history) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
    }
    yield* sql`
      INSERT INTO prompt_stash (id, created_at, entry_json, summary_json)
      VALUES ('saved-1', '2026-10-01', '{}', '{}')
    `;
  });

describe("fork database upgrade", () => {
  it.effect.each([
    [
      "with the renumbered fork migrations",
      [
        [53, "ProjectionThreadSideMessages"],
        [54, "PromptStash"],
        [55, "ProjectionThreadSideMessages"],
        [56, "PromptStash"],
        [57, "ReapplyMigrationsSkippedByFork"],
      ],
    ],
    [
      "created after upstream's 53 and 54",
      [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [55, "ProjectionThreadSideMessages"],
        [56, "PromptStash"],
      ],
    ],
  ] as const)("upgrades a fork database %s and keeps its data", ([, history]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkDatabase(history);

      const executed = yield* runMigrations();

      assert.deepStrictEqual(executed.slice(0, 2), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
      ]);
      assert.deepStrictEqual(executed.at(-1), [69, "PromptStash"]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        recorded.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(yield* sql`SELECT id FROM prompt_stash`, [{ id: "saved-1" }]);
      assert.strictEqual((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses a fork database with migrations it does not recognize", () =>
    Effect.gen(function* () {
      yield* seedForkDatabase([
        [55, "ProjectionThreadSideMessages"],
        [58, "SomethingElse"],
      ]);
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
