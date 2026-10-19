import type { PDFDocumentLoadingTask, PDFWorker } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import { MAX_ATTACHMENT_BYTES } from '../../../shared/attachments/files';
import {
  MAX_PDF_TEXT_BYTES,
  PDF_PARSER_VERSION,
  PDF_PARSE_TIMEOUT,
  type PDFExtraction,
} from '../../../shared/attachments/pdf';
import { UiError, uiMessage } from '../../platform/i18n/messages';

const assets = {
  cMapUrl: import.meta.glob<string>('/node_modules/pdfjs-dist/cmaps/*.bcmap', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
  standardFontDataUrl: import.meta.glob<string>(
    '/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
    { eager: true, query: '?url', import: 'default' },
  ),
};
const resource = Object.fromEntries(
  Object.entries(assets).map(([kind, files]) => [
    kind,
    new Map(Object.entries(files).map(([path, url]) => [path.split('/').at(-1)!, url])),
  ]),
);

/** Only bundled, named font resources can be fetched; PDF data comes from the local File. */
function binaryFactory(signal: AbortSignal) {
  return class {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      const url = resource[kind]?.get(filename);
      if (!url) throw new UiError(uiMessage('attachments', 'fontMissing'));
      const response = await fetch(url, { signal, credentials: 'same-origin' });
      if (!response.ok) throw new UiError(uiMessage('attachments', 'fontFailed'));
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}
export async function prepareChatPdf(
  file: File,
  sourceSha256: string,
  signal: AbortSignal,
  progress: (page: number, pages: number) => void = () => {},
): Promise<PDFExtraction> {
  if (!file.size || file.size > MAX_ATTACHMENT_BYTES)
    throw new UiError(uiMessage('attachments', 'pdfTooLarge'));
  const abort = new AbortController(),
    onAbort = () => abort.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const heartbeat = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => abort.abort(new UiError(uiMessage('attachments', 'pdfStalled'))),
      PDF_PARSE_TIMEOUT,
    );
  };
  heartbeat();
  let worker: Worker | undefined,
    task: PDFDocumentLoadingTask | undefined,
    parser: PDFWorker | undefined;
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  const cancel = () => {
    worker?.terminate();
    rejectAborted(abort.signal.reason);
  };
  abort.signal.addEventListener('abort', cancel, { once: true });
  if (abort.signal.aborted) cancel();
  const extracting: Promise<PDFExtraction> = (async () => {
    abort.signal.throwIfAborted();
    const pdfjs = await import('pdfjs-dist');
    abort.signal.throwIfAborted();
    if (pdfjs.version !== PDF_PARSER_VERSION)
      throw new UiError(uiMessage('attachments', 'pdfVersionMismatch'));
    const data = new Uint8Array(await file.arrayBuffer());
    abort.signal.throwIfAborted();
    worker = new Worker(workerUrl, { type: 'module' });
    parser = pdfjs.PDFWorker.create({ port: worker });
    task = pdfjs.getDocument({
      data,
      worker: parser,
      stopAtErrors: true,
      useWasm: false,
      disableFontFace: true,
      enableXfa: false,
      useWorkerFetch: false,
      BinaryDataFactory: binaryFactory(abort.signal),
      verbosity: 0,
    });
    const document = await task.promise;
    abort.signal.throwIfAborted();
    const chunks: string[] = [],
      pageOffsets: number[] = [],
      encoder = new TextEncoder();
    let characters = 0,
      bytes = 0,
      hasText = false;
    const append = (value: string) => {
      bytes += encoder.encode(value).length;
      if (bytes > MAX_PDF_TEXT_BYTES) throw new UiError(uiMessage('attachments', 'pdfCapacity'));
      chunks.push(value);
      characters += value.length;
    };
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      abort.signal.throwIfAborted();
      heartbeat();
      progress(pageNumber, document.numPages);
      pageOffsets.push(characters);
      const page = await document.getPage(pageNumber),
        reader = page.streamTextContent().getReader();
      append(`${pageNumber === 1 ? '' : '\n\n'}[第 ${pageNumber} 页]\n`);
      try {
        while (true) {
          const { done, value } = await reader.read();
          abort.signal.throwIfAborted();
          heartbeat();
          if (done) break;
          for (const item of (value as TextContent).items)
            if ('str' in item) {
              hasText ||= Boolean(item.str.trim());
              append(item.str + (item.hasEOL ? '\n' : ' '));
            }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        page.cleanup();
      }
    }
    if (!hasText) throw new UiError(uiMessage('attachments', 'pdfNoText'));
    return {
      sourceSha256,
      text: chunks.join(''),
      pageOffsets,
      pdf: { pages: document.numPages, parserVersion: PDF_PARSER_VERSION },
    };
  })();
  try {
    return await Promise.race([extracting, aborted]);
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException')
      throw new UiError(uiMessage('attachments', 'pdfPassword'));
    if (abort.signal.aborted) throw abort.signal.reason;
    if (error instanceof UiError) throw error;
    throw new UiError(uiMessage('attachments', 'pdfInvalid'));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    abort.signal.removeEventListener('abort', cancel);
    void task?.destroy().catch(() => {});
    parser?.destroy();
    worker?.terminate();
  }
}
