import Papa from 'papaparse';
import { MAX_CSV_COLUMNS, MAX_CSV_ROWS, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARACTERS, type DocumentPart } from '../shared/documents';
import { HttpError } from './http';

export function extractDocument(bytes: Uint8Array, mediaType: DocumentPart['mediaType']) {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw new HttpError(413, '文本文件最多 128 KiB，请拆分文件或选择片段。');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new HttpError(415, '文本文件必须使用 UTF-8 编码。'); }
  if (!text.trim()) throw new HttpError(415, '文件没有可用于问答的文本。');
  if (text.length > MAX_DOCUMENT_CHARACTERS) throw new HttpError(413, '文件最多 64,000 字符，请拆分文件或选择片段。');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new HttpError(415, '文件包含二进制或控制字符，请转换为 UTF-8 文本。');
  let csv: DocumentPart['csv'];
  if (mediaType === 'text/csv') {
    let rows = 0, columns = 0;
    Papa.parse<string[]>(text, { delimiter: ',', dynamicTyping: false, skipEmptyLines: 'greedy', step(result, parser) {
      rows++; columns ||= result.data.length;
      const failure = result.errors.length ? 'CSV 引号或字段格式无效。'
        : rows > MAX_CSV_ROWS || result.data.length > MAX_CSV_COLUMNS ? 'CSV 最多 2,000 行、100 列，请拆分文件。'
        : result.data.length !== columns ? 'CSV 各行的列数必须一致。' : '';
      if (failure) { parser.abort(); throw new HttpError(415, failure); }
    } });
    if (!rows) throw new HttpError(415, 'CSV 没有可用于问答的数据。');
    csv = { rows, columns };
  }
  return { text, ...(csv ? { csv } : {}) };
}
