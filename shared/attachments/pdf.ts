import * as v from 'valibot';
import { MAX_SQL_PAYLOAD_BYTES } from '../conversation/limits';
import { AppError, problem } from '../errors/descriptor';
import { attachmentInputSchema, MAX_CONVERSATION_ATTACHMENT_BYTES } from './files';

export const PDF_PARSER_VERSION = '6.4.299';
export const PDF_PARSE_TIMEOUT = 30_000;
// Derived text consumes the same conversation storage budget as original attachments.
export const MAX_PDF_TEXT_BYTES = MAX_CONVERSATION_ATTACHMENT_BYTES;
export const pdfMetadataSchema = v.strictObject({
  pages: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  parserVersion: v.literal(PDF_PARSER_VERSION),
});
export const pdfExtractionSchema = v.strictObject({
  sourceSha256: attachmentInputSchema.entries.sha256,
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PDF_TEXT_BYTES)),
  pdf: pdfMetadataSchema,
  pageOffsets: v.optional(
    v.pipe(
      v.array(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
      v.check((offsets) => JSON.stringify(offsets).length <= MAX_SQL_PAYLOAD_BYTES - 1024),
    ),
  ),
});
export type PDFExtraction = v.InferOutput<typeof pdfExtractionSchema>;
export type PDFMetadata = v.InferOutput<typeof pdfMetadataSchema>;

export function validatePdfText(input: PDFExtraction) {
  const { text, pageOffsets, pdf } = input;
  if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
    throw new AppError(problem('PDF_INVALID'), 'PDF 提取文本包含无效字符。');
  if (new TextEncoder().encode(text).length > MAX_PDF_TEXT_BYTES)
    throw new AppError(problem('STORAGE_FULL'), 'PDF 全文超过此对话 32 MiB 的附件存储容量。');
  if (
    pageOffsets &&
    (pageOffsets.length !== pdf.pages ||
      pageOffsets[0] !== 0 ||
      pageOffsets.some(
        (offset, i) => offset >= text.length || (i > 0 && offset <= pageOffsets[i - 1]),
      ))
  )
    throw new AppError(problem('PDF_INVALID'), 'PDF 页码索引无效。');
}
