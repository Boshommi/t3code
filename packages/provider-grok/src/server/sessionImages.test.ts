import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  encodedGrokSessionImagePath,
  grokSessionImagePathCandidates,
  persistGrokSessionImages,
} from "./sessionImages.ts";

const SESSION_ID = "01a07e4e-b1fc-7173-afcc-8403670aa057";
const encoded = `/home/me/.grok/sessions/%2Fhome%2Fme%2Fproj/${SESSION_ID}/images/1.jpg`;
const decoded = `/home/me/.grok/sessions/home/me/proj/${SESSION_ID}/images/1.jpg`;

describe("Grok session image paths", () => {
  it("rebuilds the encoded session folder from a decoded destination", () => {
    assert.equal(encodedGrokSessionImagePath(decoded), encoded);
    // decodeURIComponent of the leading %2F leaves an empty segment.
    assert.equal(
      encodedGrokSessionImagePath(
        `/home/me/.grok/sessions//home/me/proj/${SESSION_ID}/images/1.jpg`,
      ),
      encoded,
    );
    assert.equal(encodedGrokSessionImagePath(encoded), null);
  });

  it("only recognizes Grok session images", () => {
    assert.deepEqual(grokSessionImagePathCandidates(encoded), [encoded]);
    assert.deepEqual(grokSessionImagePathCandidates(decoded), [decoded, encoded]);
    assert.deepEqual(grokSessionImagePathCandidates("/tmp/images/1.jpg"), []);
    assert.deepEqual(grokSessionImagePathCandidates("/repo/sessions/notes/images/1.jpg"), []);
  });
});

it.layer(Layer.provideMerge(TestProviderHost.layer(), NodeServices.layer))(
  "persistGrokSessionImages",
  (it) => {
    it.effect(
      "copies session images into the thread's attachments and points markdown at them",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const grokHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-home-" });
          const imageDirectory = path.join(
            grokHome,
            "sessions",
            encodeURIComponent("/home/me/proj"),
            SESSION_ID,
            "images",
          );
          yield* fs.makeDirectory(imageDirectory, { recursive: true });
          yield* fs.writeFileString(path.join(imageDirectory, "1.png"), "png-bytes");
          const sessionImage = `${grokHome}/sessions/%2Fhome%2Fme%2Fproj/${SESSION_ID}/images/1.png`;
          const decodedImage = `${grokHome}/sessions/home/me/proj/${SESSION_ID}/images/1.png`;
          const missing = `${grokHome}/sessions/%2Fhome/${SESSION_ID}/images/missing.png`;
          const text = [
            `![chart](${sessionImage} "Chart")`,
            `Same file again: ![again](<${decodedImage}>)`,
            `![gone](${missing}) ![web](https://example.com/images/1.png)`,
          ].join("\n");

          const result = yield* persistGrokSessionImages({ threadId: "thread-1", text });

          assert.equal(result.attachments.length, 1);
          const [attachment] = result.attachments;
          assert.deepInclude(attachment, {
            type: "image",
            name: "1.png",
            mimeType: "image/png",
            sizeBytes: 9,
          });
          assert.match(attachment!.id, /^thread-1-/);
          const host = yield* ProviderHost.ProviderHost;
          const stored = path.join(host.paths.attachmentsDir, attachment!.id);
          assert.equal(yield* fs.readFileString(stored), "png-bytes");
          assert.equal(
            result.text,
            [
              `![chart](<${stored}> "Chart")`,
              `Same file again: ![again](<${stored}>)`,
              `![gone](${missing}) ![web](https://example.com/images/1.png)`,
            ].join("\n"),
          );
          // Completing the same message again reuses the stored copy.
          assert.deepEqual(yield* persistGrokSessionImages({ threadId: "thread-1", text }), result);
        }),
    );

    it.effect("leaves messages without session images untouched", () =>
      Effect.gen(function* () {
        const text = "![shot](/tmp/images/1.png) and plain prose";
        assert.deepEqual(yield* persistGrokSessionImages({ threadId: "thread-1", text }), {
          text,
          attachments: [],
        });
      }),
    );
  },
);
