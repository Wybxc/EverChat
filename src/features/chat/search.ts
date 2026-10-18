function literalPattern(query: string) {
  const words = query.trim().split(/\s+/u);
  return query.trim()
    ? new RegExp(
        words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'),
        'giu',
      )
    : null;
}

export function countMatches(text: string, query: string): number {
  const pattern = literalPattern(query);
  if (!pattern) return 0;
  let count = 0;
  while (pattern.exec(text)) count++;
  return count;
}

export function matchAt(text: string, query: string, ordinal: number) {
  const pattern = literalPattern(query);
  if (!pattern || ordinal < 0) return null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (ordinal-- === 0) return { start: match.index, end: match.index + match[0].length };
  }
  return null;
}

type Segment = { node: Text; start: number; end: number; scope?: Element | null };
export interface SearchText {
  text: string;
  segments: Segment[];
}
const blockSelector = 'p,li,pre,h1,h2,h3,h4,h5,h6,td,th,blockquote';

// Keep inline formatting contiguous, with separators between paragraphs and table cells.
export function renderedText(root: HTMLElement): SearchText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
      return element?.closest('button,script,style,[aria-hidden="true"],[data-search-ignore]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts: string[] = [],
    segments: Segment[] = [];
  let length = 0,
    previousBlock: Element | null | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof HTMLBRElement) {
      parts.push('\n');
      length++;
    }
    if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue) continue;
    const block = node.parentElement?.closest(blockSelector) ?? root;
    if (previousBlock !== undefined && block !== previousBlock) {
      parts.push('\n');
      length++;
    }
    previousBlock = block;
    const text = node.nodeValue;
    segments.push({
      node: node as Text,
      start: length,
      end: length + text.length,
      scope: node.parentElement?.closest('[data-reasoning-part]'),
    });
    parts.push(text);
    length += text.length;
  }
  return { text: parts.join(''), segments };
}

// Separate ranges prevent a cross-fragment match from highlighting the intervening tool UI.
export function textRanges(source: SearchText, match: { start: number; end: number }): Range[] {
  const ranges: Range[] = [];
  let scope: Element | null | undefined;
  let current: Range | undefined;
  for (const segment of source.segments) {
    if (segment.end <= match.start || segment.start >= match.end) continue;
    if (!current || scope !== segment.scope) {
      current = document.createRange();
      current.setStart(segment.node, Math.max(0, match.start - segment.start));
      ranges.push(current);
      scope = segment.scope;
    }
    current.setEnd(segment.node, Math.min(segment.end, match.end) - segment.start);
  }
  return ranges;
}
