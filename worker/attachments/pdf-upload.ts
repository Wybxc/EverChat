import * as v from 'valibot';
import { ATTACHMENT_UPLOAD_TIMEOUT } from '../../shared/attachments/files';
import {
  MAX_PDF_TEXT_BYTES,
  pdfExtractionSchema,
  type PDFExtraction,
} from '../../shared/attachments/pdf';
import { MAX_SQL_PAYLOAD_BYTES } from '../../shared/conversation/limits';
import { problem } from '../../shared/errors/descriptor';
import { HttpError } from '../http/response';

/** Small JSON metadata line followed by UTF-8 text; the Free Worker passes it through natively. */
export async function readPdfUpload(body: ReadableStream<Uint8Array>): Promise<PDFExtraction> {
  const reader = body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let header = '',
    text = '',
    metadata: unknown,
    size = 0,
    expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, ATTACHMENT_UPLOAD_TIMEOUT);
  try {
    while (true) {
      const next = await reader.read();
      if (expired)
        throw new HttpError(
          408,
          'PDF 全文上传超时，请重试。',
          undefined,
          problem('REQUEST_TIMEOUT'),
        );
      if (next.done) break;
      let value = next.value;
      if (metadata === undefined) {
        const newline = value.indexOf(10),
          head = newline < 0 ? value : value.subarray(0, newline);
        header += decoder.decode(head, { stream: newline < 0 });
        if (header.length > MAX_SQL_PAYLOAD_BYTES)
          throw new HttpError(
            413,
            'PDF 页码索引超过元数据存储容量。',
            undefined,
            problem('STORAGE_FULL'),
          );
        if (newline < 0) continue;
        metadata = JSON.parse(header);
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
          throw new HttpError(400, 'PDF 提取元数据无效。', undefined, problem('PDF_INVALID'));
        value = value.subarray(newline + 1);
      }
      size += value.byteLength;
      if (size > MAX_PDF_TEXT_BYTES)
        throw new HttpError(
          507,
          'PDF 全文超过此对话 32 MiB 的附件存储容量。',
          undefined,
          problem('STORAGE_FULL'),
        );
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const result = v.safeParse(pdfExtractionSchema, { ...(metadata as object), text });
    if (!result.success)
      throw new HttpError(
        400,
        'PDF 提取结果无效，请重新选择文件。',
        undefined,
        problem('PDF_INVALID'),
      );
    return result.output;
  } catch (error) {
    throw error instanceof HttpError
      ? error
      : new HttpError(400, 'PDF 全文编码或元数据无效。', undefined, problem('PDF_INVALID'));
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
