import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { EnvironmentId, ForwardCompatibleArray } from "./baseSchemas.ts";
import { PastedTextAttachmentSource, SnapShotSource } from "./chatAttachment.ts";
import { ComposerContextRecord } from "./composerContext.ts";

// Servers persist entries and summaries as JSON in `prompt_stash`. Keep changes
// backward compatible: stored rows decode with the current schemas.

export const PromptStashImage = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Finite,
  source: Schema.optional(SnapShotSource),
  dataUrl: Schema.String,
});
export type PromptStashImage = typeof PromptStashImage.Type;

/** An upload owned by one environment; restoring elsewhere cannot reach its bytes. */
export const PromptStashFile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Finite,
  attachmentId: Schema.String,
  environmentId: EnvironmentId,
  source: Schema.optional(PastedTextAttachmentSource),
});
export type PromptStashFile = typeof PromptStashFile.Type;

export const PromptStashEntry = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(PromptStashImage),
  files: Schema.optionalKey(Schema.Array(PromptStashFile)),
  /** Images that exceeded the size budget when the prompt was saved. */
  droppedImageNames: Schema.Array(Schema.String),
  /** Images that could not be read when the prompt was saved. */
  unreadableImageNames: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Images still encoding in a browser-only entry. Server entries are saved complete. */
  pendingImageCount: Schema.optionalKey(Schema.Finite),
  /** Payloads behind the prompt's context links. */
  records: Schema.optionalKey(ForwardCompatibleArray(ComposerContextRecord)),
});
export type PromptStashEntry = typeof PromptStashEntry.Type;

/** List updates carry metadata only. Image bytes and context records are fetched on restore. */
export const PromptStashSummary = Schema.Struct({
  ...Struct.omit(PromptStashEntry.fields, ["attachments", "records"]),
  imageCount: Schema.Finite,
});
export type PromptStashSummary = typeof PromptStashSummary.Type;

export function summarizePromptStashEntry(entry: PromptStashEntry): PromptStashSummary {
  const { attachments, records: _records, ...summary } = entry;
  return { ...summary, imageCount: attachments.length };
}

export class PromptStashError extends Schema.TaggedError<PromptStashError>()("PromptStashError", {
  message: Schema.String,
}) {}
