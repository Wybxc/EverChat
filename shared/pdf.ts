import * as v from 'valibot';
import { attachmentInputSchema } from './attachments';

export const PDF_PARSER_VERSION = '6.4.299';
export const MAX_PDF_PAGES = 50, PDF_PARSE_TIMEOUT = 30_000;
export const pdfMetadataSchema = v.strictObject({
  pages: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_PDF_PAGES)),
  parserVersion: v.literal(PDF_PARSER_VERSION),
});
export const pdfExtractionSchema = v.strictObject({
  sourceSha256: attachmentInputSchema.entries.sha256,
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(64_000)),
  pdf: pdfMetadataSchema,
});
export type PDFExtraction = v.InferOutput<typeof pdfExtractionSchema>;
export type PDFMetadata = v.InferOutput<typeof pdfMetadataSchema>;
