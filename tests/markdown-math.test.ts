import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { math } from '@streamdown/math';
import { normalizeMathMarkdown } from '../src/features/chat/rendering/math';

const render = (text: string) => renderToStaticMarkup(createElement(Streamdown, { mode: 'static', plugins: { math } }, normalizeMathMarkdown(text)));

test('common TeX delimiters render as math with fractions, matrices and accessible MathML', () => {
  for (const text of [String.raw`$E=mc^2$`, String.raw`\(a^2+b^2=c^2\)`, String.raw`\[\frac{1}{2}\]`, String.raw`\[\begin{pmatrix}a&b\\c&d\end{pmatrix}\]`]) {
    const html = render(text);
    assert.match(html, /class="katex"/); assert.match(html, /<math /); assert.doesNotMatch(html, /katex-error/);
  }
  assert.match(render(String.raw`\[x^2\]`), /katex-display/);
  assert.doesNotMatch(render(String.raw`\(x^2\)`), /katex-display/);
});

test('prices do not swallow a later formula and escaped dollars stay literal', () => {
  const text = String.raw`价格 $5 和 $10；公式 $x^2$；转义 \$y$。`;
  const html = render(text);
  assert.equal((html.match(/class="katex"/gu) ?? []).length, 1);
  assert.match(html, /价格 \$5 和 \$10/); assert.match(html, /转义 \$y\$/);
  assert.match(render('$2+2=4$'), /class="katex"/);
});

test('Markdown code, fenced literals, indented code and link destinations stay untouched', () => {
  for (const literal of ['`$x$ \\(y\\)\\[z\\]`', '```text\n$x$\n\\[z\\]\n```', '~~~\n$x$\n~~~', '    $x$\n    \\(y\\)', '[link](https://example.test/$x$)', '<span title="$x$">']) {
    assert.equal(normalizeMathMarkdown(literal), literal);
  }
  assert.equal(normalizeMathMarkdown('[value $x$](https://example.test/$y$)'), '[value $$x$$](https://example.test/$y$)');
});

test('existing double-dollar math is unchanged and unfinished streamed delimiters remain safe', () => {
  for (const source of [String.raw`$$\text{\(literal\)}$$`, '$$\n\\int_0^1 x dx\n$$', '$x^', String.raw`\(\frac{1}`, String.raw`\[\begin{matrix}a`]) {
    assert.equal(normalizeMathMarkdown(source), source);
  }
  const chunks = ['\\', '(', '\\alpha', ' + ', '\\beta', '\\', ')'];
  let content = '';
  for (const chunk of chunks) { content += chunk; assert.doesNotThrow(() => render(content)); }
  assert.match(render(content), /class="katex"/);
  const unfinished = String.raw`\(`.repeat(10000);
  assert.equal(normalizeMathMarkdown(unfinished), unfinished);
});

test('display delimiters retain blockquote and list structure without including their markers in TeX', () => {
  for (const source of ['> \\[\n> \\frac{1}{2}\n> \\]', '> \\[x^2\\]', '- \\[x^2\\]']) {
    const html = render(source);
    assert.match(html, /katex-display/); assert.doesNotMatch(html, /katex-error/);
    assert.doesNotMatch(html, /<mo>&gt;<\/mo>/);
    assert.match(html, source.startsWith('>') ? /<blockquote/ : /<ul/);
  }
});
