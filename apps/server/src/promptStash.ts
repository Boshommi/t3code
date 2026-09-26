import {
  PromptStashEntry,
  PromptStashSummary,
  PromptStashError,
  summarizePromptStashEntry,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(PromptStashEntry));
const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(PromptStashEntry));
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(PromptStashSummary));
const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(PromptStashSummary));
const storageError = () => new PromptStashError({ message: "Could not access saved prompts." });

export const makePromptStash = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const writes = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>({ capacity: 1 });
  const list = Effect.gen(function* () {
    const rows = yield* sql<{ summary_json: string }>`
      SELECT summary_json FROM prompt_stash WHERE entry_json IS NOT NULL ORDER BY created_at DESC, id DESC
    `;
    return yield* Effect.forEach(rows, (row) => decodeSummary(row.summary_json));
  }).pipe(Effect.mapError(storageError));
  const get = Effect.fn("PromptStash.get")(function* (id: string) {
    const rows = yield* sql<{
      entry_json: string | null;
    }>`SELECT entry_json FROM prompt_stash WHERE id = ${id}`;
    return rows[0]?.entry_json ? yield* decodeEntry(rows[0].entry_json) : null;
  }, Effect.mapError(storageError));
  const save = Effect.fn("PromptStash.save")(
    function* (entry: PromptStashEntry) {
      // Saved prompts are immutable. IDs make both migration retries and response-loss retries safe.
      const entryJson = yield* encodeEntry(entry);
      const summaryJson = yield* encodeSummary(summarizePromptStashEntry(entry));
      yield* sql`INSERT OR IGNORE INTO prompt_stash (id, created_at, entry_json, summary_json)
      VALUES (${entry.id}, ${entry.createdAt}, ${entryJson}, ${summaryJson})`;
      yield* PubSub.publish(changes, undefined);
    },
    writes.withPermits(1),
    Effect.mapError(storageError),
    Effect.asVoid,
  );
  const remove = Effect.fn("PromptStash.remove")(
    function* (id: string) {
      yield* sql`INSERT INTO prompt_stash (id, created_at, entry_json, summary_json)
      VALUES (${id}, '', NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET entry_json = NULL, summary_json = NULL`;
      yield* PubSub.publish(changes, undefined);
    },
    writes.withPermits(1),
    Effect.mapError(storageError),
    Effect.asVoid,
  );
  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(list),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
      );
    }),
  );
  return { list, get, save, remove, subscribe };
});

export class PromptStash extends Context.Service<
  PromptStash,
  Effect.Success<typeof makePromptStash>
>()("t3/promptStash") {}
export const layer = Layer.effect(PromptStash, makePromptStash);
