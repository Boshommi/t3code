import {
  type ChatImageAttachment,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { createDeterministicAttachmentId } from "@t3tools/shared/attachmentIds";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { decodeMarkdownFilesystemPath } from "@t3tools/shared/markdownLinks";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSIONS_MARKER = "/sessions/";
const IMAGES_MARKER = "/images/";
const MARKDOWN_IMAGE_PATTERN =
  /!\[([^\]]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))((?:\s+["'][^"']*["'])?)\s*\)/g;

/** `<grok home>/sessions/<encoded cwd>/<session id>/images/<file>`, split at its parts. */
function parseGrokSessionImagePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  const sessionsIndex = normalized.indexOf(SESSIONS_MARKER);
  const imagesIndex = normalized.lastIndexOf(IMAGES_MARKER);
  if (sessionsIndex < 0 || imagesIndex <= sessionsIndex) return null;
  const sessionDirectory = normalized.slice(sessionsIndex + SESSIONS_MARKER.length, imagesIndex);
  const separator = sessionDirectory.lastIndexOf("/");
  if (separator <= 0) return null;
  const sessionId = sessionDirectory.slice(separator + 1);
  const cwd = sessionDirectory.slice(0, separator).replace(/^\/+/, "");
  if (!SESSION_ID_PATTERN.test(sessionId) || cwd.length === 0) return null;
  return { normalized, sessionsIndex, imagesIndex, sessionId, cwd };
}

/**
 * Grok names a session folder after its cwd as one `%2F`-encoded segment.
 * Rebuilds that on-disk path from a destination whose cwd was decoded into
 * nested folders; `null` when the path is not such a Grok session image.
 */
export function encodedGrokSessionImagePath(filePath: string): string | null {
  const parsed = parseGrokSessionImagePath(filePath);
  if (parsed === null || /%2F/i.test(parsed.cwd)) return null;
  const { normalized, sessionsIndex, imagesIndex, sessionId, cwd } = parsed;
  return `${normalized.slice(0, sessionsIndex + SESSIONS_MARKER.length)}${encodeURIComponent(
    `/${cwd}`,
  )}/${sessionId}${normalized.slice(imagesIndex)}`;
}

/** Where a markdown image destination may live on disk, if it names a Grok session image. */
export function grokSessionImagePathCandidates(destination: string): ReadonlyArray<string> {
  const decoded = decodeMarkdownFilesystemPath(destination.replaceAll("\\", "/"));
  if (parseGrokSessionImagePath(decoded) === null) return [];
  const encoded = encodedGrokSessionImagePath(decoded);
  return encoded === null ? [decoded] : [decoded, encoded];
}

/**
 * Copies the Grok session images a completed assistant message shows into the
 * thread's attachment store and points the markdown at the copies, so the
 * image outlives Grok's session folder and resolves for remote clients.
 * Anything that cannot be copied keeps its original destination.
 */
export const persistGrokSessionImages = Effect.fn("persistGrokSessionImages")(function* (input: {
  readonly threadId: string;
  readonly text: string;
}) {
  const attachments = new Map<string, ChatImageAttachment>();
  if (!input.text.includes("![") || !input.text.includes(IMAGES_MARKER)) {
    return { text: input.text, attachments: [...attachments.values()] };
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const host = yield* ProviderHost.ProviderHost;
  const copies = new Map<string, string>();

  const persist = Effect.fnUntraced(function* (destination: string) {
    for (const candidate of grokSessionImagePathCandidates(destination)) {
      const mimeType = mediaMimeTypeFromExtension(path.extname(candidate));
      if (mimeType === null || !isProviderSendTurnSupportedImageMimeType(mimeType)) return null;
      const bytes = yield* fileSystem.readFile(candidate).pipe(Effect.option);
      if (Option.isNone(bytes)) continue;
      if (bytes.value.length === 0 || bytes.value.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        return null;
      }
      const digest = Hex.encode(yield* crypto.digest("SHA-256", bytes.value));
      const id = createDeterministicAttachmentId(input.threadId, `grok-session-image:${digest}`);
      if (id === null) return null;
      const attachment: ChatImageAttachment = {
        type: "image",
        id,
        name: path.basename(candidate),
        mimeType,
        sizeBytes: bytes.value.length,
      };
      const filePath = host.resolveAttachmentPath(attachment);
      if (filePath === null) return null;
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFile(filePath, bytes.value);
      attachments.set(id, attachment);
      return filePath;
    }
    return null;
  });

  let text = "";
  let cursor = 0;
  for (const match of input.text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const [markup, alt = "", angleDestination, bareDestination, title = ""] = match;
    const destination = (angleDestination ?? bareDestination ?? "").trim();
    const copy =
      copies.get(destination) ??
      (yield* persist(destination).pipe(Effect.orElseSucceed(() => null)));
    if (copy === null) continue;
    copies.set(destination, copy);
    text += `${input.text.slice(cursor, match.index)}![${alt}](<${copy}>${title})`;
    cursor = match.index + markup.length;
  }
  return { text: text + input.text.slice(cursor), attachments: [...attachments.values()] };
});
