import * as v from 'valibot';
import { attachmentInputSchema } from '../../shared/attachments/files';
import { documentRangesSchema } from '../../shared/attachments/documents';
import { pdfExtractionSchema, MAX_PDF_TEXT_BYTES } from '../../shared/attachments/pdf';

const ref = v.pipe(v.string(), v.minLength(1), v.maxLength(2048));
const uuid = attachmentInputSchema.entries.id;
const fileMetadata = {
  clientFileId: uuid,
  name: attachmentInputSchema.entries.name,
  mediaType: attachmentInputSchema.entries.mediaType,
  purpose: v.picklist(['image', 'document']),
  replaces: v.optional(ref),
  versionNote: v.optional(v.pipe(v.string(), v.maxLength(1000))),
};
const derivedSchema = v.strictObject({
  size: v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.maxValue(MAX_PDF_TEXT_BYTES + 2_000_000),
  ),
  sha256: attachmentInputSchema.entries.sha256,
});
export const attachmentsPrepareSchema = v.strictObject({
  uploadId: uuid,
  continuation: v.optional(ref),
  files: v.pipe(
    v.array(
      v.strictObject({
        ...fileMetadata,
        size: attachmentInputSchema.entries.size,
        sha256: attachmentInputSchema.entries.sha256,
        pdfText: v.optional(derivedSchema),
      }),
    ),
    v.minLength(1),
  ),
});
export type AttachmentsPrepareArguments = v.InferOutput<typeof attachmentsPrepareSchema>;
export const attachmentsPutSchema = v.strictObject({
  uploadId: uuid,
  continuation: v.optional(ref),
  files: v.pipe(
    v.array(
      v.pipe(
        v.strictObject({
          ...fileMetadata,
          text: v.optional(v.string()),
          dataBase64: v.optional(v.string()),
          extraction: v.optional(pdfExtractionSchema),
        }),
        v.check((file) => (file.text === undefined) !== (file.dataBase64 === undefined)),
      ),
    ),
    v.minLength(1),
  ),
});
export type AttachmentsPutArguments = v.InferOutput<typeof attachmentsPutSchema>;
const pageRange = v.strictObject({
  start: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  end: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
export const selectedAttachmentSchema = v.strictObject({
  attachmentRef: ref,
  mode: v.optional(v.picklist(['reuse', 'replace', 'include_both']), 'reuse'),
  selection: v.optional(
    v.pipe(
      v.strictObject({
        ranges: v.optional(documentRangesSchema),
        pageRanges: v.optional(v.pipe(v.array(pageRange), v.minLength(1))),
      }),
      v.check((s) => (s.ranges === undefined) !== (s.pageRanges === undefined)),
    ),
  ),
});
export type SelectedAttachment = v.InferOutput<typeof selectedAttachmentSchema>;
export const attachmentsGetSchema = v.pipe(
  v.strictObject({
    uploadRef: v.optional(ref),
    attachmentRef: v.optional(ref),
    view: v.optional(v.picklist(['metadata', 'text', 'uploads']), 'metadata'),
    cursor: v.optional(ref),
  }),
  v.check((s) => (s.uploadRef === undefined) !== (s.attachmentRef === undefined)),
);
export type AttachmentsGetArguments = v.InferOutput<typeof attachmentsGetSchema>;
export const attachmentsDeleteSchema = v.strictObject({
  attachmentRefs: v.pipe(v.array(ref), v.minLength(1)),
});
const fileResult = v.strictObject({
  clientFileId: uuid,
  attachmentRef: ref,
  documentRef: ref,
  versionRef: ref,
  supersedes: v.nullable(ref),
  versionNote: v.nullable(v.string()),
  createdAt: v.number(),
  name: v.string(),
  mediaType: v.string(),
  size: v.number(),
  sha256: v.string(),
  purpose: v.string(),
  uploadStatus: v.string(),
  inputStatus: v.string(),
  error: v.nullable(v.string()),
  parsed: v.nullable(v.record(v.string(), v.unknown())),
  uploads: v.array(
    v.strictObject({
      kind: v.picklist(['original', 'pdf-text']),
      method: v.literal('PUT'),
      url: v.string(),
      headers: v.record(v.string(), v.string()),
      expiresAt: v.number(),
    }),
  ),
});
export const attachmentsResultSchema = v.strictObject({
  uploadRef: v.nullable(ref),
  conversationId: uuid,
  url: v.string(),
  files: v.array(fileResult),
  text: v.nullable(v.string()),
  textUnit: v.nullable(v.literal('utf8_bytes')),
  hasMore: v.boolean(),
  nextCursor: v.nullable(ref),
});
export type AttachmentsResult = v.InferOutput<typeof attachmentsResultSchema>;
export const attachmentsDeleteResultSchema = v.strictObject({
  files: v.array(
    v.strictObject({
      attachmentRef: ref,
      deleted: v.boolean(),
      error: v.nullable(
        v.strictObject({
          code: v.string(),
          message: v.string(),
          stage: v.string(),
          retryable: v.boolean(),
          httpStatus: v.optional(v.number()),
        }),
      ),
    }),
  ),
});
