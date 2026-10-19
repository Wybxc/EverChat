import { t } from './locales';
import { PDF_PARSE_TIMEOUT, type PDFExtraction } from '../../../shared/attachments/pdf';
import { abortable } from '../../platform/abort';

export async function preparePdf(
  file: File,
  sourceSha256: string,
  signal: AbortSignal,
  progress: (page: number, pages: number) => void,
): Promise<PDFExtraction> {
  const timeout = new AbortController(),
    bounded = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(
    () => timeout.abort(new Error(t(($) => $.pdfTimeout))),
    PDF_PARSE_TIMEOUT,
  );
  try {
    const parser = await abortable(() => import('./chat-pdf'), bounded);
    clearTimeout(timer);
    return await parser.prepareChatPdf(file, sourceSha256, bounded, progress);
  } finally {
    clearTimeout(timer);
  }
}
