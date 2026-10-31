import { createHash } from 'node:crypto';
import { precedingPosition, type TextIndex } from '../../shared/attachments/text-index';
import { TEXT_SCAN_BYTES, type TextToolSource } from '../../shared/attachments/tools';

const hash = (data: string | ArrayBuffer) =>
  createHash('sha256')
    .update(typeof data === 'string' ? data : new Uint8Array(data))
    .digest('hex');
export const textDecode = (data: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);

export function textObjectMatches(
  object: Pick<R2Object, 'size'> & { checksums: Pick<R2Checksums, 'sha256'> },
  source: Pick<TextToolSource, 'bytes' | 'sourceSha256' | 'validatedOriginal'>,
) {
  const checksum = object.checksums.sha256;
  return (
    object.size === source.bytes &&
    (checksum
      ? Buffer.from(checksum).toString('hex') === source.sourceSha256
      : source.validatedOriginal === true)
  );
}

/** Never materializes the source. Each read has a fixed working set. */
export class TextReader {
  private cached?: TextIndex;
  constructor(
    private bucket: R2Bucket,
    readonly source: TextToolSource & { sourceSha256: string },
  ) {}
  async index() {
    if (this.cached) return this.cached;
    const object = await this.bucket.get(this.source.indexKey);
    if (!object) throw new Error('Text index is unavailable; run offline maintenance');
    // An index is small relative to the source; still bound corrupt objects before decoding.
    if (object.size > 512 * 1024) {
      await object.body.cancel();
      throw new Error('Invalid text index size');
    }
    const raw = await object.text();
    if (hash(raw) !== this.source.indexSha256) throw new Error('Text index integrity mismatch');
    const index = JSON.parse(raw) as TextIndex;
    if (index.version !== 1 || index.bytes !== this.source.bytes || !index.positions.length)
      throw new Error('Text index version mismatch');
    this.cached = index;
    return index;
  }
  async bytes(start: number, end: number) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.source.bytes ||
      end - start > TEXT_SCAN_BYTES + 4
    )
      throw new Error('Invalid bounded text range');
    if (start === end) return new Uint8Array();
    const object = await this.bucket.get(this.source.key, {
      range: { offset: start, length: end - start },
    });
    if (!object) throw new Error('Text source is unavailable');
    if (!textObjectMatches(object, this.source)) {
      await object.body.cancel();
      throw new Error('Text source integrity mismatch');
    }
    const data = new Uint8Array(await object.arrayBuffer());
    if (data.length !== end - start) throw new Error('Incomplete range response');
    return data;
  }
  async fragment(start: number, end: number) {
    const bytes = await this.bytes(start, Math.min(this.source.bytes, end + 3));
    let from = 0,
      to = Math.min(end - start, bytes.length);
    while (from < to && (bytes[from] & 0xc0) === 0x80) from++;
    if (start + to < this.source.bytes) while (to > from && (bytes[to] & 0xc0) === 0x80) to--;
    const text = textDecode(bytes.subarray(from, to));
    return {
      attachmentId: this.source.attachmentId,
      textSha256: this.source.textSha256,
      start: start + from,
      end: start + to,
      text,
      sha256: hash(text),
    };
  }
  async byteAt(character: number) {
    const index = await this.index();
    if (!Number.isSafeInteger(character) || character < 0 || character > index.characters)
      throw new Error('Invalid character offset');
    if (character === index.characters) return index.bytes;
    const point = [...index.positions].reverse().find((p) => p.characters <= character)!;
    const data = await this.bytes(
      point.byte,
      Math.min(index.bytes, point.byte + TEXT_SCAN_BYTES + 3),
    );
    let chars = point.characters;
    for (let i = 0; i < data.length; i++) {
      if ((data[i] & 0xc0) === 0x80) continue;
      if (chars === character) return point.byte + i;
      chars += data[i] >= 0xf0 ? 2 : 1;
      if (chars > character) throw new Error('Position splits a Unicode character');
    }
    throw new Error('Text index character coordinate mismatch');
  }
  async linePosition(line: number, checkpoint?: { byte: number; line: number }) {
    const index = await this.index();
    if (line > index.lines) throw new Error('Line is outside this file');
    const p = checkpoint ?? precedingPosition(index, 'line', line);
    if (p.line === line && p.byte === 0) return { byte: 0, line, found: true };
    const end = Math.min(index.bytes, p.byte + TEXT_SCAN_BYTES),
      data = await this.bytes(p.byte, end);
    let current = p.line;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 10 && ++current === line) return { byte: p.byte + i + 1, line, found: true };
    }
    if (end === index.bytes) throw new Error('Line is outside this file');
    return { byte: end, line: current, found: false };
  }
}
