import { PDF_PARSE_TIMEOUT, type PDFExtraction } from '../../../shared/attachments/pdf';
import { abortable } from '../../platform/abort';
import { UiError, uiMessage } from '../../platform/i18n/messages';

export async function preparePdf(
  file: File,
  sourceSha256: string,
  signal: AbortSignal,
  progress: (page: number, pages: number) => void,
): Promise<PDFExtraction> {
  const timeout = new AbortController(),
    bounded = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(
    () => timeout.abort(new UiError(uiMessage('attachments', 'pdfTimeout'))),
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
