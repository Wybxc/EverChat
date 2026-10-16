import { fromMarkdown } from 'mdast-util-from-markdown';

type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] };

/** Convert common model delimiters to remark-math's double-dollar syntax, outside literal Markdown. */
export function normalizeMathMarkdown(source: string): string {
  const ranges: [number, number][] = [];
  const visit = (node: Node) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (['code', 'inlineCode', 'html', 'image', 'definition'].includes(node.type)) {
      ranges.push([start, end]); return;
    }
    for (const child of node.children ?? []) visit(child);
    // Link destinations are literal URLs; math is allowed only in their visible label.
    if (node.type === 'link' || node.type === 'linkReference') {
      const labelEnd = node.children?.at(-1)?.position?.end.offset;
      if (labelEnd !== undefined) ranges.push([labelEnd, end]);
    }
  };
  visit(fromMarkdown(source));
  ranges.sort(([a], [b]) => a - b);
  let result = '', cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    result += normalizeText(source.slice(cursor, start)) + source.slice(start, end); cursor = end;
  }
  return result + normalizeText(source.slice(cursor));
}

function normalizeText(text: string): string {
  let result = '', i = 0;
  const exhausted = new Set<string>();
  const closing = (delimiter: string, from: number) => {
    if (exhausted.has(delimiter)) return -1;
    for (let at = from; at < text.length; at++) {
      if (text.startsWith(delimiter, at)) return at;
      if (text[at] === '\\') at++;
    }
    exhausted.add(delimiter);
    return -1;
  };
  while (i < text.length) {
    const bracket = text.startsWith('\\(', i) ? ')' : text.startsWith('\\[', i) ? ']' : null;
    if (bracket) {
      const end = closing(`\\${bracket}`, i + 2);
      if (end >= 0) {
        const body = text.slice(i + 2, end);
        if (bracket === ')') result += `$$${body}$$`;
        else if (/^\r?\n/u.test(body) && /\r?\n[\t >]*$/u.test(body)) result += `$$${body}$$`;
        else {
          // Preserve quote/list indentation when a display formula occupies one source line.
          const prefix = text.slice(text.lastIndexOf('\n', i - 1) + 1, i).replace(/(?:[-+*]|\d+[.)])[\t ]+$/u, (marker) => ' '.repeat(marker.length));
          result += /^[\t >]*$/u.test(prefix) ? `$$\n${prefix}${body.trim()}\n${prefix}$$` : `\n\n$$\n${body.trim()}\n$$\n\n`;
        }
        i = end + 2; continue;
      }
    }
    if (text[i] === '\\') { result += text.slice(i, i + 2); i += 2; continue; }
    if (text.startsWith('$$', i)) {
      const end = closing('$$', i + 2);
      // Existing math, including an unfinished streamed block, must keep its own TeX escapes.
      const until = end < 0 ? text.length : end + 2;
      result += text.slice(i, until); i = until; continue;
    }
    if (text[i] === '$' && text[i + 1] && !/\s/u.test(text[i + 1])) {
      const end = closing('$', i + 1), body = text.slice(i + 1, end);
      const numericMath = !/^\d/u.test(body) || /^\d[\da-zA-Z.,]*$/u.test(body) || /[=+*/^_<>-]|\\[a-zA-Z]+/u.test(body);
      // The first delimiter must close this pair. Do not consume later formulas after a price.
      if (end > i + 1 && numericMath && !/[\r\n]/u.test(body) && !/\s/u.test(text[end - 1]) && !/[\d$]/u.test(text[end + 1] ?? '')) {
        result += `$$${body}$$`; i = end + 1; continue;
      }
    }
    result += text[i++];
  }
  return result;
}
