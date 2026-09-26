import { assert, it } from "@effect/vitest";
import type { PromptStashEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "./persistence/Migrations/054_PromptStash.ts";
import { makePromptStash } from "./promptStash.ts";

const entry = (id: string): PromptStashEntry => ({
  id,
  createdAt: "2026-09-26T00:00:00.000Z",
  prompt: `prompt ${id}`,
  attachments: [
    {
      id: "image",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 4,
      dataUrl: "data:image/png;base64,AAAA",
    },
  ],
  droppedImageNames: [],
});

it.layer(Layer.effectDiscard(migration).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())))(
  "prompt stash",
  (it) => {
    it.effect(
      "persists complete entries, merges concurrent saves, and keeps bytes out of list updates",
      () =>
        Effect.gen(function* () {
          const stash = yield* makePromptStash;
          yield* Effect.all([stash.save(entry("a")), stash.save(entry("b"))], {
            concurrency: "unbounded",
          });
          const restarted = yield* makePromptStash;
          assert.deepEqual(yield* restarted.get("a"), entry("a"));
          const list = yield* restarted.list;
          assert.equal(list.length, 2);
          assert.equal(list[0]?.imageCount, 1);
          assert.equal("attachments" in list[0]!, false);
        }),
    );
    it.effect("retrying a migration never overwrites an entry or resurrects a deleted one", () =>
      Effect.gen(function* () {
        const stash = yield* makePromptStash;
        yield* stash.save(entry("retry"));
        yield* stash.save({ ...entry("retry"), prompt: "stale local copy" });
        assert.equal((yield* stash.get("retry"))?.prompt, "prompt retry");
        yield* stash.remove("retry");
        yield* stash.save(entry("retry"));
        assert.equal(yield* stash.get("retry"), null);
        yield* stash.remove("never-saved");
        yield* stash.save(entry("never-saved"));
        assert.equal(yield* stash.get("never-saved"), null);
      }),
    );
    it.effect("subscribers see the initial list and changes committed while handling it", () =>
      Effect.gen(function* () {
        const stash = yield* makePromptStash;
        let received = 0;
        const snapshots = yield* stash.subscribe.pipe(
          Stream.tap(() => (++received === 1 ? stash.save(entry("streamed")) : Effect.void)),
          Stream.take(2),
          Stream.runCollect,
        );
        assert.equal(
          snapshots[0]?.some((item) => item.id === "streamed"),
          false,
        );
        assert.equal(
          snapshots[1]?.some((item) => item.id === "streamed"),
          true,
        );
      }),
    );
  },
);
