import Papa from 'papaparse';
import { MAX_DOCUMENT_BYTES, type DocumentPart } from '../../shared/attachments/documents';
import { problem } from '../../shared/errors/descriptor';
import { HttpError } from '../http/response';

export function extractDocument(
  bytes: Uint8Array,
  mediaType: Exclude<DocumentPart['mediaType'], 'application/pdf'>,
) {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES)
    throw new HttpError(
      413,
      '文本文件超过单次全文解析的内存保护大小，请拆分文件。',
      undefined,
      problem('TEXT_INVALID'),
    );
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new HttpError(415, '文本文件必须使用 UTF-8 编码。', undefined, problem('TEXT_INVALID'));
  }
  if (!text.trim())
    throw new HttpError(415, '文件没有可用于问答的文本。', undefined, problem('TEXT_INVALID'));
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
    throw new HttpError(
      415,
      '文件包含二进制或控制字符，请转换为 UTF-8 文本。',
      undefined,
      problem('TEXT_INVALID'),
    );
  let csv: DocumentPart['csv'];
  if (mediaType === 'text/csv') {
    let rows = 0,
      columns = 0;
    Papa.parse<string[]>(text, {
      delimiter: ',',
      dynamicTyping: false,
      skipEmptyLines: 'greedy',
      step(result, parser) {
        rows++;
        columns ||= result.data.length;
        const failure = result.errors.length
          ? 'CSV 引号或字段格式无效。'
          : result.data.length !== columns
            ? 'CSV 各行的列数必须一致。'
            : '';
        if (failure) {
          parser.abort();
          throw new HttpError(415, failure, undefined, problem('TEXT_INVALID'));
        }
      },
    });
    if (!rows)
      throw new HttpError(415, 'CSV 没有可用于问答的数据。', undefined, problem('TEXT_INVALID'));
    csv = { rows, columns };
  }
  return { text, ...(csv ? { csv } : {}) };
}
