import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Extend this boundary when a feature is migrated. Resources and user content are excluded.
const migrated = [
  'src/app/*.{ts,tsx}',
  'src/components/*.tsx',
  'src/components/ui/*.tsx',
  'src/features/chat/*.{ts,tsx}',
  'src/features/library/*.{ts,tsx}',
  'src/features/providers/*.tsx',
  'src/features/presets/*.tsx',
  'src/features/web-tools/*.tsx',
  'src/features/usage/*.tsx',
  'src/features/attachments/*.tsx',
  'src/features/sharing/*.tsx',
  'src/features/chat/rendering/*.tsx',
  'src/features/backup/*.tsx',
  'src/features/notifications/*.tsx',
  'src/platform/pwa/*.tsx',
  'src/platform/{api,xhr,storage,autosave}.ts',
];
const literalTerms = new Set([
  'EverChat',
  'Markdown',
  'HTML',
  'JSON',
  'ZIP',
  'Temperature',
  'Top P',
  'Tokens',
  'ID',
  'Token',
  'Tavily',
  'DeepSeek Search / Fetch',
  'https://api.example.com/v1',
  'claude-sonnet-4-6',
]);
const displayAttributes = new Set([
  'aria-label',
  'aria-description',
  'placeholder',
  'title',
  'label',
]);

test('migrated UI has no hardcoded copy in JSX text, accessible names or Chinese expressions', () => {
  const failures: string[] = [];
  for (const file of migrated.flatMap((pattern) => globSync(pattern))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node) {
      const text =
        ts.isJsxText(node) ||
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
          ? node.text.trim().replace(/\s+/g, ' ')
          : '';
      const jsxCopy =
        ts.isJsxText(node) ||
        (node.parent &&
          ts.isJsxAttribute(node.parent) &&
          displayAttributes.has(node.parent.name.getText(source)));
      if (
        text &&
        !literalTerms.has(text) &&
        (/\p{Script=Han}/u.test(text) || (jsxCopy && /\p{Letter}/u.test(text)))
      ) {
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        failures.push(`${file}:${location.line + 1}: ${text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(
    failures,
    [],
    `Move UI copy into typed translation resources:\n${failures.join('\n')}`,
  );
});
