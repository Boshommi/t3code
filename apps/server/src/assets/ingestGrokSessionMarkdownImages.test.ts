// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { ingestGrokSessionMarkdownImages } from "./ingestGrokSessionMarkdownImages.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-ingest-grok-images-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const SESSION_ID = "01a07e4e-b1fc-7173-afcc-8403670aa057";

function writeGrokSessionImage(input: {
  readonly root: string;
  readonly cwd: string;
  readonly fileName?: string;
  readonly bytes?: Buffer;
}): { readonly encodedPath: string; readonly decodedPath: string } {
  const encodedCwd = encodeURIComponent(input.cwd);
  const encodedPath = NodePath.join(
    input.root,
    "sessions",
    encodedCwd,
    SESSION_ID,
    "images",
    input.fileName ?? "1.jpg",
  );
  NodeFS.mkdirSync(NodePath.dirname(encodedPath), { recursive: true });
  NodeFS.writeFileSync(encodedPath, input.bytes ?? Buffer.from("jpeg-bytes"));
  const decodedPath = NodePath.join(
    input.root,
    "sessions",
    ...input.cwd.replace(/^\/+/, "").split("/"),
    SESSION_ID,
    "images",
    input.fileName ?? "1.jpg",
  );
  return { encodedPath, decodedPath };
}

describe("ingestGrokSessionMarkdownImages", () => {
  it.effect(
    "copies a Grok session image into the thread attachment store and rewrites markdown",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const grokRoot = yield* Effect.sync(() =>
          NodeFS.mkdtempSync(NodePath.join(config.baseDir, "grok-")),
        );
        const { encodedPath } = writeGrokSessionImage({ root: grokRoot, cwd: "/tmp/proj" });
        const result = yield* ingestGrokSessionMarkdownImages({
          threadId: "thread-1",
          text: `See ![diagram](${encodedPath})`,
        });

        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0]).toMatchObject({
          type: "image",
          name: "1.jpg",
          mimeType: "image/jpeg",
          sizeBytes: "jpeg-bytes".length,
        });
        expect(result.text).toContain(`![diagram](${config.attachmentsDir}/`);
        expect(result.text).not.toContain("/sessions/");
        expect(NodeFS.existsSync(encodedPath)).toBe(true);
        expect(
          NodeFS.readFileSync(
            NodePath.join(config.attachmentsDir, `${result.attachments[0]!.id}.jpg`),
          ),
        ).toEqual(Buffer.from("jpeg-bytes"));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reconstructs an encoded session path from decoded markdown", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const grokRoot = yield* Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(config.baseDir, "grok-")),
      );
      const { encodedPath, decodedPath } = writeGrokSessionImage({
        root: grokRoot,
        cwd: "/tmp/proj",
      });
      expect(NodeFS.existsSync(decodedPath)).toBe(false);

      const result = yield* ingestGrokSessionMarkdownImages({
        threadId: "thread-1",
        text: `![diagram](${decodedPath})`,
      });

      expect(result.attachments).toHaveLength(1);
      expect(result.text).toContain(config.attachmentsDir);
      expect(result.text).not.toContain(decodedPath);
      expect(NodeFS.existsSync(encodedPath)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("copies a repeated Grok image once and rewrites every markdown occurrence", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const sessionRoot = yield* Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(config.baseDir, "grok-")),
      );
      const { encodedPath } = writeGrokSessionImage({ root: sessionRoot, cwd: "/tmp/proj" });

      const result = yield* ingestGrokSessionMarkdownImages({
        threadId: "thread-1",
        text: `![one](${encodedPath})\n\n![two](${encodedPath})`,
      });

      expect(result.attachments).toHaveLength(1);
      expect(result.text).toContain("![one](");
      expect(result.text).toContain("![two](");
      expect(result.text).not.toContain("/sessions/");
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((name) => name.endsWith(".jpg")),
      ).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves the original destination when the Grok image is missing", () =>
    Effect.gen(function* () {
      const missing = `/tmp/missing-grok/sessions/${encodeURIComponent("/tmp/proj")}/${SESSION_ID}/images/1.jpg`;
      const result = yield* ingestGrokSessionMarkdownImages({
        threadId: "thread-1",
        text: `![gone](${missing})`,
      });
      expect(result.attachments).toEqual([]);
      expect(result.text).toBe(`![gone](${missing})`);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves the original destination when the Grok image is too large", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const grokRoot = yield* Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(config.baseDir, "grok-")),
      );
      const { encodedPath } = writeGrokSessionImage({
        root: grokRoot,
        cwd: "/tmp/proj",
        bytes: Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1, 1),
      });
      const result = yield* ingestGrokSessionMarkdownImages({
        threadId: "thread-1",
        text: `![huge](${encodedPath})`,
      });
      expect(result.attachments).toEqual([]);
      expect(result.text).toBe(`![huge](${encodedPath})`);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not copy ordinary workspace images or markdown links", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const workspaceImage = NodePath.join(config.baseDir, "diagram.jpg");
      NodeFS.writeFileSync(workspaceImage, "pixels");
      const grokRoot = yield* Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(config.baseDir, "grok-")),
      );
      const { encodedPath } = writeGrokSessionImage({ root: grokRoot, cwd: "/tmp/proj" });
      const text = `![workspace](${workspaceImage})\n[session](${encodedPath})`;
      const result = yield* ingestGrokSessionMarkdownImages({
        threadId: "thread-1",
        text,
      });
      expect(result.attachments).toEqual([]);
      expect(result.text).toBe(text);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rewrites only the images that can be copied", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const grokRoot = yield* Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(config.baseDir, "grok-")),
      );
      const { encodedPath } = writeGrokSessionImage({ root: grokRoot, cwd: "/tmp/proj" });
      const missing = `/tmp/missing-grok/sessions/${encodeURIComponent("/tmp/proj")}/${SESSION_ID}/images/2.jpg`;
      const result = yield* ingestGrokSessionMarkdownImages({
        threadId: "thread-1",
        text: `![ok](${encodedPath})\n![gone](${missing})`,
      });
      expect(result.attachments).toHaveLength(1);
      expect(result.text).toContain("![ok](");
      expect(result.text).toContain(config.attachmentsDir);
      expect(result.text).toContain(`![gone](${missing})`);
    }).pipe(Effect.provide(testLayer)),
  );
});
