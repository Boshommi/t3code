import * as Struct from "effect/Struct";
import * as Schema from "effect/Schema";
import { EnvironmentId, ForwardCompatibleArray } from "./baseSchemas.ts";
import { ComposerContextRecord } from "./composerContext.ts";
import { PastedTextAttachmentSource, SnapShotSource } from "./orchestration.ts";

export const PromptStashImage = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Finite,
  source: Schema.optional(SnapShotSource),
  dataUrl: Schema.String,
});
export const PromptStashFile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Finite,
  attachmentId: Schema.String,
  environmentId: EnvironmentId,
  source: Schema.optional(PastedTextAttachmentSource),
});
export const PromptStashEntry = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(PromptStashImage),
  files: Schema.optionalKey(Schema.Array(PromptStashFile)),
  droppedImageNames: Schema.Array(Schema.String),
  unreadableImageNames: Schema.optionalKey(Schema.Array(Schema.String)),
  pendingImageCount: Schema.optionalKey(Schema.Finite),
  records: Schema.optionalKey(ForwardCompatibleArray(ComposerContextRecord)),
});
export type PromptStashEntry = typeof PromptStashEntry.Type;

// List subscriptions carry metadata only. Image bytes and context records are fetched on restore.
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
