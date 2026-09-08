// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { type ChatImageAttachment, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { grokSessionMediaPathCandidates } from "./grokSessionMediaPath.ts";

function markdownImagePattern(): RegExp {
  return /!\[([^\]]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))((?:\s+["'][^"']*["'])?)\s*\)/g;
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const resolvedFile = NodePath.resolve(filePath);
  const resolvedDirectory = NodePath.resolve(directory);
  return (
    resolvedFile === resolvedDirectory ||
    resolvedFile.startsWith(`${resolvedDirectory}${NodePath.sep}`)
  );
}

function markdownImageMarkup(input: {
  readonly alt: string;
  readonly path: string;
  readonly title: string;
  readonly angleBrackets: boolean;
}): string {
  const destination =
    input.angleBrackets || /[\s()]/.test(input.path) ? `<${input.path}>` : input.path;
  return `![${input.alt}](${destination}${input.title})`;
}

/**
 * Copies Grok session images referenced in assistant markdown into the thread
 * attachment store and rewrites those image destinations to the copies.
 */
export const ingestGrokSessionMarkdownImages = Effect.fn("ingestGrokSessionMarkdownImages")(
  function* (input: { readonly threadId: string; readonly text: string }) {
    if (
      input.text.length === 0 ||
      !input.text.includes("![") ||
      !input.text.includes("/sessions/") ||
      !input.text.includes("/images/")
    ) {
      return { text: input.text, attachments: [] as ReadonlyArray<ChatImageAttachment> };
    }

    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const destByHref = new Map<string, string>();
    const copiedBySource = new Map<string, { destPath: string; attachment: ChatImageAttachment }>();
    const attachments: ChatImageAttachment[] = [];

    const copySource = (href: string) =>
      Effect.gen(function* () {
        const cachedHref = destByHref.get(href);
        if (cachedHref !== undefined) {
          return cachedHref;
        }

        let resolvedSource: string | null = null;
        let sizeBytes = 0;
        for (const candidate of grokSessionMediaPathCandidates(href)) {
          const exists = yield* fileSystem
            .exists(candidate)
            .pipe(Effect.orElseSucceed(() => false));
          if (!exists) {
            continue;
          }
          const info = yield* fileSystem.stat(candidate).pipe(Effect.orElseSucceed(() => null));
          if (info === null || info.type !== "File") {
            continue;
          }
          const size = Number(info.size);
          if (!Number.isFinite(size) || size <= 0 || size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            continue;
          }
          resolvedSource = candidate;
          sizeBytes = size;
          break;
        }

        if (
          resolvedSource === null ||
          isInsideDirectory(resolvedSource, serverConfig.attachmentsDir)
        ) {
          return null;
        }

        const cachedSource = copiedBySource.get(resolvedSource);
        if (cachedSource !== undefined) {
          destByHref.set(href, cachedSource.destPath);
          return cachedSource.destPath;
        }

        const mimeType = mediaMimeTypeFromExtension(NodePath.extname(resolvedSource));
        if (mimeType === null || !mimeType.startsWith("image/")) {
          return null;
        }

        const attachmentId = createAttachmentId(input.threadId);
        if (attachmentId === null) {
          return null;
        }

        const name = NodePath.basename(resolvedSource);
        if (name.length === 0 || name.length > 255) {
          return null;
        }

        const attachment: ChatImageAttachment = {
          type: "image",
          id: attachmentId,
          name,
          mimeType,
          sizeBytes,
        };
        const destPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (destPath === null) {
          return null;
        }

        yield* fileSystem
          .makeDirectory(NodePath.dirname(destPath), { recursive: true })
          .pipe(Effect.ignore);
        const copied = yield* fileSystem.copyFile(resolvedSource, destPath).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!copied) {
          return null;
        }

        copiedBySource.set(resolvedSource, { destPath, attachment });
        destByHref.set(href, destPath);
        attachments.push(attachment);
        return destPath;
      });

    let cursor = 0;
    let rewritten = "";
    let copiedAny = false;
    for (const match of input.text.matchAll(markdownImagePattern())) {
      const matchIndex = match.index ?? 0;
      rewritten += input.text.slice(cursor, matchIndex);
      const alt = match[1] ?? "";
      const angleHref = match[2];
      const bareHref = match[3];
      const title = match[4] ?? "";
      const href = (angleHref ?? bareHref ?? "").trim();
      const destPath =
        href.length > 0 && grokSessionMediaPathCandidates(href).length > 0
          ? yield* copySource(href)
          : null;
      if (destPath !== null) {
        copiedAny = true;
        rewritten += markdownImageMarkup({
          alt,
          path: destPath,
          title,
          angleBrackets: angleHref !== undefined,
        });
      } else {
        rewritten += match[0];
      }
      cursor = matchIndex + match[0].length;
    }
    rewritten += input.text.slice(cursor);

    return {
      text: copiedAny ? rewritten : input.text,
      attachments,
    };
  },
);
