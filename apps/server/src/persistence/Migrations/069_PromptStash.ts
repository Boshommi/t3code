import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork databases already have this table from their own migration 56.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Null payloads are tombstones: a retried local migration cannot resurrect a deletion.
  yield* sql`CREATE TABLE IF NOT EXISTS prompt_stash (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    entry_json TEXT,
    summary_json TEXT
  )`;
});
