import { PDF_PARSE_TIMEOUT, type PDFExtraction } from '../../../shared/attachments/pdf';
import { abortable } from '../../platform/abort';

export async function preparePdf(file: File, sourceSha256: string, signal: AbortSignal, progress: (page: number, pages: number) => void): Promise<PDFExtraction> {
  const timeout = new AbortController(), bounded = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(new Error('PDF 解析超过 30 秒，请拆分文件后重试。')), PDF_PARSE_TIMEOUT);
  try {
    const parser = await abortable(() => import('./chat-pdf'), bounded);
    return await parser.prepareChatPdf(file, sourceSha256, bounded, progress);
  } finally { clearTimeout(timer); }
}
