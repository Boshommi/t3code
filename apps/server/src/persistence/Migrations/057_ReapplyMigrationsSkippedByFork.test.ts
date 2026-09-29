import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateSideMessages from "./055_ProjectionThreadSideMessages.ts";
import migratePromptStash from "./056_PromptStash.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "057_ReapplyMigrationsSkippedByFork",
  (it) => {
    it.effect("repairs a database that recorded the fork's old 053 and 054", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* migrateSideMessages;
        yield* migratePromptStash;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (53, 'ProjectionThreadSideMessages'), (54, 'PromptStash')
        `;

        yield* runMigrations();

        const tables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_files_viewed'
        `;
        assert.lengthOf(tables, 1);
        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
        assert.isTrue(columns.some((column) => column.name === "auto_settle_disabled_at"));
      }),
    );
  },
);
