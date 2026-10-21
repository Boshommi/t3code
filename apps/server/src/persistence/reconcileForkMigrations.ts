import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

// Builds of the Boshommi fork recorded their own migrations at 53-57, ids that
// upstream later gave to its own schema. Their tables are recreated under new
// ids (68, 69), so drop the fork rows and record upstream's 53 and 54 instead.
// Both are idempotent, and the fork's 57 already applied them on most databases.
const FORK_MIGRATION_NAMES = new Set([
  "ProjectionThreadSideMessages",
  "PromptStash",
  "ReapplyMigrationsSkippedByFork",
]);

export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53
      `;
      // This build's 68 and 69 reuse two of these names, so only 53-57 identify a fork.
      const isForkRow = (row: (typeof history)[number]) =>
        row.migration_id <= 57 && FORK_MIGRATION_NAMES.has(row.name);
      if (!history.some(isForkRow)) return [];
      const valid = history.every(
        (row) =>
          isForkRow(row) ||
          (row.migration_id === 53 && row.name === "PullRequestFilesViewed") ||
          (row.migration_id === 54 && row.name === "ProjectionThreadsAutoSettleDisabledAt"),
      );
      if (!valid) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade a fork database with unexpected later migrations.",
        });
      }
      yield* PullRequestFilesViewed;
      yield* AutoSettleDisabledAt;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 53`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (53, 'PullRequestFilesViewed'), (54, 'ProjectionThreadsAutoSettleDisabledAt')
      `;
      return [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
      ] as const satisfies ReadonlyArray<readonly [number, string]>;
    }),
  );
});
