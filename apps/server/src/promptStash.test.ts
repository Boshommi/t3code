import { assert, it } from "@effect/vitest";
import type { PromptStashEntry } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import migration from "./persistence/Migrations/069_PromptStash.ts";
import * as PromptStash from "./promptStash.ts";

const entry = (id: string): PromptStashEntry => ({
  id,
  createdAt: "2026-10-21T00:00:00.000Z",
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

const layer = it.layer(
  Layer.effectDiscard(migration).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  ),
);

layer("PromptStash", (it) => {
  it.effect("persists complete entries and keeps image bytes out of list updates", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.make;
      yield* Effect.all([stash.save(entry("a")), stash.save(entry("b"))], {
        concurrency: "unbounded",
      });
      const restarted = yield* PromptStash.make;
      assert.deepEqual(yield* restarted.get("a"), entry("a"));
      const list = yield* restarted.list;
      assert.deepEqual(
        list.map((summary) => summary.id),
        ["b", "a"],
      );
      assert.equal(list[0]?.imageCount, 1);
      assert.equal("attachments" in list[0]!, false);
    }),
  );

  it.effect("retried saves never overwrite an entry or resurrect a deleted one", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.make;
      yield* stash.save(entry("retry"));
      yield* stash.save({ ...entry("retry"), prompt: "stale local copy" });
      assert.equal((yield* stash.get("retry"))?.prompt, "prompt retry");
      yield* stash.remove("retry");
      yield* stash.save(entry("retry"));
      assert.equal(yield* stash.get("retry"), null);
      yield* stash.remove("never-saved");
      yield* stash.save(entry("never-saved"));
      assert.equal(yield* stash.get("never-saved"), null);
      assert.equal(
        (yield* stash.list).some((summary) => summary.id === "retry"),
        false,
      );
    }),
  );

  it.effect("subscribers see the current list, then changes saved while they handle it", () =>
    Effect.gen(function* () {
      const stash = yield* PromptStash.make;
      let received = 0;
      const snapshots = yield* stash.subscribe.pipe(
        Stream.tap(() => (++received === 1 ? stash.save(entry("streamed")) : Effect.void)),
        Stream.take(2),
        Stream.runCollect,
      );
      assert.equal(
        snapshots[0]?.some((summary) => summary.id === "streamed"),
        false,
      );
      assert.equal(
        snapshots[1]?.some((summary) => summary.id === "streamed"),
        true,
      );
    }),
  );
});
