import {
  PromptStashEntry,
  PromptStashError,
  PromptStashSummary,
  summarizePromptStashEntry,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

const EntryJson = Schema.fromJsonString(PromptStashEntry);
const SummaryJson = Schema.fromJsonString(PromptStashSummary);
const decodeEntry = Schema.decodeUnknownEffect(EntryJson);
const encodeEntry = Schema.encodeEffect(EntryJson);
const decodeSummary = Schema.decodeUnknownEffect(SummaryJson);
const encodeSummary = Schema.encodeEffect(SummaryJson);
const storageError = () => new PromptStashError({ message: "Could not access saved prompts." });

/**
 * Saved composer prompts shared by every client of this environment. List rows keep a summary
 * beside the full entry so subscriptions never carry image bytes.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.sliding<void>(1);

  const list = Effect.gen(function* () {
    const rows = yield* sql<{ readonly summary_json: string }>`
      SELECT summary_json FROM prompt_stash
      WHERE entry_json IS NOT NULL
      ORDER BY created_at DESC, id DESC
    `;
    return yield* Effect.forEach(rows, (row) => decodeSummary(row.summary_json));
  }).pipe(Effect.mapError(storageError));

  const get = Effect.fn("PromptStash.get")(function* (id: string) {
    const rows = yield* sql<{ readonly entry_json: string | null }>`
      SELECT entry_json FROM prompt_stash WHERE id = ${id}
    `;
    const entryJson = rows[0]?.entry_json;
    return entryJson ? yield* decodeEntry(entryJson) : null;
  }, Effect.mapError(storageError));

  const save = Effect.fn("PromptStash.save")(function* (entry: PromptStashEntry) {
    // Entries are immutable and deletions leave a tombstone, so a retried save (a resumed local
    // migration, a lost response, a repeated copy) never overwrites or resurrects anything.
    const entryJson = yield* encodeEntry(entry);
    const summaryJson = yield* encodeSummary(summarizePromptStashEntry(entry));
    yield* sql`
      INSERT OR IGNORE INTO prompt_stash (id, created_at, entry_json, summary_json)
      VALUES (${entry.id}, ${entry.createdAt}, ${entryJson}, ${summaryJson})
    `;
    yield* PubSub.publish(changes, undefined);
  }, Effect.mapError(storageError));

  const remove = Effect.fn("PromptStash.remove")(function* (id: string) {
    yield* sql`
      INSERT INTO prompt_stash (id, created_at, entry_json, summary_json)
      VALUES (${id}, '', NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET entry_json = NULL, summary_json = NULL
    `;
    yield* PubSub.publish(changes, undefined);
  }, Effect.mapError(storageError));

  /** The current list, then the list again after every change. */
  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before the first read so a write that lands in between is not missed.
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(list),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
      );
    }),
  );

  return { list, get, save, remove, subscribe };
});

export class PromptStash extends Context.Service<PromptStash, Effect.Success<typeof make>>()(
  "t3/promptStash",
) {}

export const layer = Layer.effect(PromptStash, make);
