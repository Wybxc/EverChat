/** Storage coordinates are UTF-8 bytes, never JS string or message offsets. */
export const TEXT_INDEX_VERSION = 1;
export const TEXT_INDEX_STRIDE = 64 * 1024;
export interface TextPosition {
  byte: number;
  line: number;
  characters: number;
}
export interface TextIndex {
  version: 1;
  bytes: number;
  characters: number;
  lines: number;
  positions: TextPosition[];
}

/** Incremental validation and a sparse index; keeps no document text. */
export class TextIndexer {
  hasText = false;
  private decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private bytes = 0;
  private characters = 0;
  private lines = 1;
  private next = TEXT_INDEX_STRIDE;
  private positions: TextPosition[] = [{ byte: 0, line: 1, characters: 0 }];
  private finished = false;
  append(data: Uint8Array) {
    if (this.finished) throw new Error('Text index is already complete');
    // The fatal streaming decoder checks overlong sequences, surrogates and EOF.
    if (this.decoder.decode(data, { stream: true }).trim()) this.hasText = true;
    for (const byte of data) {
      if ((byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 0x7f)
        throw new Error('Text contains binary or control characters');
      if ((byte & 0xc0) !== 0x80) {
        if (this.bytes >= this.next) {
          this.positions.push({ byte: this.bytes, line: this.lines, characters: this.characters });
          this.next = this.bytes + TEXT_INDEX_STRIDE;
        }
        this.characters += byte >= 0xf0 ? 2 : 1;
      }
      if (byte === 10) this.lines++;
      this.bytes++;
    }
  }
  finish(): TextIndex {
    if (this.finished) throw new Error('Text index is already complete');
    this.decoder.decode();
    this.finished = true;
    return {
      version: TEXT_INDEX_VERSION,
      bytes: this.bytes,
      characters: this.characters,
      lines: this.lines,
      positions: this.positions,
    };
  }
}

export function indexText(bytes: Uint8Array): TextIndex {
  const builder = new TextIndexer();
  builder.append(bytes);
  return builder.finish();
}

export function precedingPosition(index: TextIndex, coordinate: 'byte' | 'line', value: number) {
  let low = 0,
    high = index.positions.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (
      coordinate === 'line'
        ? index.positions[middle].line < value
        : index.positions[middle].byte <= value
    )
      low = middle;
    else high = middle;
  }
  return index.positions[low];
}

export function sampleTextRanges(bytes: number, count: number, span: number) {
  if (![bytes, count, span].every(Number.isSafeInteger) || bytes < 0 || count < 1 || span < 1)
    throw new Error('Invalid sample range');
  const size = Math.min(bytes, span),
    ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < Math.min(count, Math.ceil(bytes / span)); i++) {
    const n = Math.min(count, Math.ceil(bytes / span));
    const start = n === 1 ? 0 : Math.floor((i * (bytes - size)) / (n - 1));
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = start + size;
    else ranges.push({ start, end: start + size });
  }
  return ranges;
}

/** KMP state makes literal search resumable across arbitrary storage boundaries. */
export class LiteralScanner {
  private patterns: {
    id: string;
    bytes: Uint8Array;
    table: number[];
    matched: number;
    count: number;
  }[];
  constructor(
    patterns: { id: string; literal: string }[],
    counts: Record<string, number> = {},
    states: Record<string, number> = {},
  ) {
    if (!patterns.length || new Set(patterns.map((p) => p.id)).size !== patterns.length)
      throw new Error('Search patterns need unique IDs');
    this.patterns = patterns.map(({ id, literal }) => {
      const bytes = new TextEncoder().encode(literal);
      if (!bytes.length) throw new Error('Empty search pattern');
      const table = Array<number>(bytes.length).fill(0);
      for (let i = 1, j = 0; i < bytes.length; i++) {
        while (j && bytes[i] !== bytes[j]) j = table[j - 1];
        if (bytes[i] === bytes[j]) j++;
        table[i] = j;
      }
      return {
        id,
        bytes,
        table,
        matched: Object.hasOwn(states, id) ? states[id] : 0,
        count: Object.hasOwn(counts, id) ? counts[id] : 0,
      };
    });
  }
  scan(
    data: Uint8Array,
    offset: number,
    onMatch?: (id: string, start: number, end: number) => void,
    stopAfterByte?: () => boolean,
  ) {
    for (let i = 0; i < data.length; i++) {
      for (const p of this.patterns) {
        while (p.matched && data[i] !== p.bytes[p.matched]) p.matched = p.table[p.matched - 1];
        if (data[i] === p.bytes[p.matched]) p.matched++;
        if (p.matched === p.bytes.length) {
          p.count++;
          onMatch?.(p.id, offset + i + 1 - p.bytes.length, offset + i + 1);
          p.matched = p.table[p.matched - 1];
        }
      }
      if (stopAfterByte?.()) return offset + i + 1;
    }
    return offset + data.length;
  }
  checkpoint() {
    return {
      counts: Object.fromEntries(this.patterns.map((p) => [p.id, p.count])),
      states: Object.fromEntries(this.patterns.map((p) => [p.id, p.matched])),
    };
  }
}
