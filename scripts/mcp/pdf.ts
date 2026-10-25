import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  PDF_PARSER_VERSION,
  MAX_PDF_TEXT_BYTES,
  validatePdfText,
  type PDFExtraction,
} from '../../shared/attachments/pdf';

/** Local extraction only. PDF references are never resolved against the network. */
export async function extractMcpPdf(bytes: Uint8Array, sourceSha256: string) {
  const parser = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (parser.version !== PDF_PARSER_VERSION) throw new Error('PDF parser version mismatch');
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const task = parser.getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    useWasm: false,
    disableFontFace: true,
    enableXfa: false,
    useWorkerFetch: false,
    verbosity: 0,
    cMapUrl: join(root, 'cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: join(root, 'standard_fonts/'),
  });
  const timer = setTimeout(() => void task.destroy(), 30_000);
  try {
    const pdf = await task.promise,
      chunks: string[] = [],
      pageOffsets: number[] = [];
    let characters = 0,
      size = 0,
      hasText = false;
    const append = (text: string) => {
      size += Buffer.byteLength(text);
      if (size > MAX_PDF_TEXT_BYTES) throw new Error('PDF text exceeds extraction memory budget');
      chunks.push(text);
      characters += text.length;
    };
    for (let index = 1; index <= pdf.numPages; index++) {
      pageOffsets.push(characters);
      append(`${index === 1 ? '' : '\n\n'}[第 ${index} 页]\n`);
      const page = await pdf.getPage(index),
        reader = page.streamTextContent().getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          for (const item of next.value.items)
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
    if (!hasText) throw new Error('PDF has no extractable text');
    const result: PDFExtraction = {
      sourceSha256,
      text: chunks.join(''),
      pageOffsets,
      pdf: { pages: pdf.numPages, parserVersion: PDF_PARSER_VERSION },
    };
    validatePdfText(result);
    return result;
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}
