// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment === PENDING_ATTACHMENT_THREAD_SEGMENT ? "_pending" : segment;
}

/** The same thread and key always name the same attachment, so a retry reuses its file. */
export function createDeterministicAttachmentId(
  threadId: string,
  stableKey: string,
): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) return null;
  const hash = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([threadId, stableKey]))
    .digest("hex")
    .slice(0, 32);
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
  return `${threadSegment}-${uuid}`;
}
