import assert from 'node:assert/strict';
import { providerStreams } from '../../support/providers/streams';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as v from 'valibot';
import {
  assertDocumentContext,
  documentPartSchema,
  documentPrompt,
  documentSource,
  documentKey,
  estimateDocumentTokens,
  type DocumentPart,
} from '../../../shared/attachments/documents';
import { messageFiles, messagePartsSchema } from '../../../shared/conversation/content';
import {
  assertContextFits,
  buildContext,
  contextHistory,
  contextSource,
} from '../../../shared/conversation/context-budget';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../../shared/conversation/settings';
import { summaryContext, summaryGeneration } from '../../../shared/conversation/summaries';
import type { Message } from '../../../shared/conversation/types';
import { resolveModelMetadata } from '../../../shared/models/metadata';
import type { ProviderConfig, ProviderKind } from '../../../shared/providers/types';
import { extractDocument } from '../../../worker/attachments/parser';
import { openProviderStream } from '../../../worker/providers/stream';

const text = '文件预算：42 元。\nconst literal = "<script>alert(1)</script>";';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const file: DocumentPart = {
  type: 'file',
  attachmentId: crypto.randomUUID(),
  name: 'budget.ts',
  mediaType: 'text/plain',
  size: Buffer.byteLength(text),
  sha256: hash(text),
  textSha256: hash(text),
  version: 1,
  characters: text.length,
  tokens: estimateDocumentTokens({ name: 'budget.ts', mediaType: 'text/plain' }, text),
};
const config: ProviderConfig = {
  provider: 'openai-chat',
  model: 'text',
  baseUrl: 'https://provider.test/v1',
  apiKey: 'unit-test-key',
  systemPrompt: '',
  maxOutputTokens: null,
  modelMetadata: resolveModelMetadata('openai-chat', {
    id: 'text',
    name: '',
    enabled: true,
    metadataOverrides: { imageInput: false, contextWindow: 200000 },
  }),
};
const parse = (
  value: string,
  mediaType: Exclude<DocumentPart['mediaType'], 'application/pdf'> = 'text/plain',
) => extractDocument(Buffer.from(value), mediaType);

test('UTF-8 extraction preserves code, Markdown and line endings without executing or truncating text', () => {
  for (const mediaType of ['text/plain', 'text/markdown'] as const)
    assert.deepEqual(parse(`\ufeff${text}\r\n`, mediaType), { text: `${text}\r\n` });
  for (const invalid of [Buffer.from([0xc3, 0x28]), Buffer.from([0xff]), Buffer.from([0xe2, 0x82])])
    assert.throws(() => extractDocument(invalid, 'text/plain'), /UTF-8/);
  for (const invalid of [' ', '\r\n\t', 'text\u0000binary', 'text\u001bescape', 'text\u007f'])
    assert.throws(() => parse(invalid));
  assert.equal(parse('a'.repeat(64000)).text.length, 64000);
  assert.equal(parse('a'.repeat(64001)).text.length, 64001);
  assert.equal(parse('中'.repeat(44000)).text.length, 44000);
});
test('restricted CSV accepts quoted commas, quotes and newlines, keeps formulas literal and rejects inconsistent or malformed records', () => {
  const csv = 'name,value\r\n"one,two","line1\nline2"\r\n"a""b",=SUM(A1)\r\n\r\n';
  assert.deepEqual(parse(csv, 'text/csv'), { text: csv, csv: { rows: 3, columns: 2 } });
  for (const invalid of ['a,b\n1', 'a,b\n1,2,3', 'a,b\n"unclosed,2', 'a,b\n"bad"x,2'])
    assert.throws(() => parse(invalid, 'text/csv'), /CSV/);
  assert.deepEqual(parse('a\n'.repeat(2000), 'text/csv').csv, { rows: 2000, columns: 1 });
  assert.deepEqual(parse('a\n'.repeat(2001), 'text/csv').csv, { rows: 2001, columns: 1 });
  assert.deepEqual(parse(Array(100).fill('x').join(','), 'text/csv').csv, {
    rows: 1,
    columns: 100,
  });
  assert.equal(parse(Array(101).fill('x').join(','), 'text/csv').csv?.columns, 101);
});
test('document parts store only bounded versioned references and canonical message channels', () => {
  assert.ok(v.safeParse(documentPartSchema, file).success);
  for (const patch of [
    { text },
    { url: 'https://public/file' },
    { version: 2 },
    { tokens: 0 },
    { mediaType: 'application/pdf' },
    { csv: { rows: 1, columns: 1 } },
  ])
    assert.equal(v.safeParse(documentPartSchema, { ...file, ...patch }).success, false);
  assert.equal(v.safeParse(documentPartSchema, { ...file, mediaType: 'text/csv' }).success, false);
  assert.ok(v.safeParse(messagePartsSchema, [file]).success);
  assert.ok(v.safeParse(messagePartsSchema, [{ type: 'text', text: '请解释' }, file]).success);
  for (const invalid of [
    [file, file],
    [file, { type: 'text', text: 'out of order' }],
  ])
    assert.equal(v.safeParse(messagePartsSchema, invalid).success, false);
});
test('file-only questions retain their references through retries, branches, summaries and context budgets', () => {
  const user: Message = {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [file],
    status: 'completed',
    createdAt: 1,
    runId: null,
    parentId: null,
    revisionOf: null,
    error: null,
  };
  const answer: Message = {
    ...user,
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [{ type: 'text', text: '42 元' }],
    parentId: user.id,
  };
  const messages = [user, answer];
  assert.deepEqual(contextHistory(messages, answer.id)[0], {
    role: 'user',
    content: '',
    files: [file],
    source: { kind: 'message', messageId: user.id },
  });
  assert.deepEqual(contextSource(messages, { retryOf: answer.id }).files, [file]);
  assert.deepEqual(messageFiles(user), [file]);
  const built = buildContext(
    contextHistory(messages, answer.id),
    '',
    config,
    DEFAULT_CONVERSATION_SETTINGS,
    undefined,
    [],
    [file],
  );
  assert.equal(built.estimate.documentTokens, file.tokens * 2);
  assert.equal(built.estimate.inputTokens, file.tokens);
  assert.deepEqual(built.messages.at(-1)?.files, [file]);
  assert.throws(
    () =>
      assertContextFits(
        buildContext(
          [],
          '',
          config,
          { ...DEFAULT_CONVERSATION_SETTINGS, contextBudget: 100 },
          undefined,
          [],
          [file],
        ).estimate,
      ),
    /超过/,
  );
  assert.deepEqual(summaryGeneration(messages, answer.id, config).context[0].files, [file]);
  assert.deepEqual(summaryContext(messages, answer.id).history[0].files, [file]);
  assert.deepEqual(contextHistory([{ ...user, deletedAt: 2 }, answer], answer.id), []);
  assert.ok(!JSON.stringify(built).includes(text));
});
test('document contexts accept more than eight occurrences while retaining role validation', () => {
  assert.throws(
    () => assertDocumentContext([{ role: 'assistant', content: '', files: [file] }]),
    /用户消息/,
  );
  assert.doesNotThrow(() =>
    assertDocumentContext([{ role: 'user', content: '', files: Array(9).fill(file) }]),
  );
  const long = { ...file, characters: 64000 };
  assert.doesNotThrow(() =>
    assertDocumentContext([{ role: 'user', content: '', files: [long, long] }]),
  );
  assert.doesNotThrow(() =>
    assertDocumentContext([{ role: 'user', content: '', files: [long, long, file] }]),
  );
});
for (const [provider, native] of [
  ['openai-chat', false],
  ['openai-chat', true],
  ['openai-responses', false],
  ['anthropic', false],
  ['gemini', false],
] as [ProviderKind, boolean][]) {
  test(`${provider}${native ? ' official endpoint' : ''} sends private extracted content as native text without URLs or vision capabilities`, async (t) => {
    let calls = 0,
      reads = 0;
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
      calls++;
      const body = JSON.parse(init.body as string),
        expected = documentPrompt(file, text);
      const content =
        provider === 'openai-chat' || provider === 'anthropic'
          ? body.messages[0].content
          : provider === 'openai-responses'
            ? body.input[0].content
            : body.contents[0].parts;
      if (typeof content === 'string') assert.equal(content, expected);
      else assert.equal(content[0].text, expected);
      assert.ok(!JSON.stringify(body).includes('/api/conversations/'));
      assert.ok(!JSON.stringify(body).includes(file.attachmentId));
      assert.ok(!JSON.stringify(body).includes('internal-source-message'));
      return new Response(providerStreams[provider].partial + providerStreams[provider].finish, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const stream = await openProviderStream(
      { ...config, provider, ...(native ? { baseUrl: 'https://api.openai.com/v1' } : {}) },
      [
        {
          role: 'user',
          content: '',
          files: [file],
          source: { kind: 'message', messageId: 'internal-source-message' },
        },
        { role: 'user', content: '', files: [file] },
      ],
      new AbortController().signal,
      undefined,
      async () => {
        reads++;
        return text;
      },
    );
    await stream.cancel();
    assert.equal(reads, 1);
    assert.equal(calls, 1);
  });
}
for (const provider of [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
] as ProviderKind[]) {
  test(`${provider}: separate selections of one PDF keep distinct text and budgets across history`, async (t) => {
    const source: DocumentPart = {
      ...file,
      mediaType: 'application/pdf',
      pdf: { pages: 2, parserVersion: '6.4.299' },
    };
    const selections = [
      { start: 0, end: 9 },
      { start: 10, end: text.length },
    ];
    const selected = selections.map((range) => {
      const fragment = text.slice(range.start, range.end);
      return {
        ...source,
        characters: fragment.length,
        textSha256: hash(fragment),
        tokens: estimateDocumentTokens(source, fragment),
        selection: {
          ranges: [range],
          sourceTextSha256: source.textSha256,
          sourceCharacters: source.characters,
          sourceTokens: source.tokens,
        },
      };
    });
    for (const part of selected) {
      assert.ok(v.safeParse(documentPartSchema, part).success);
      assert.deepEqual(documentSource(part), source);
    }
    assert.notEqual(documentKey(selected[0]), documentKey(selected[1]));
    let reads = 0,
      calls = 0;
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
      calls++;
      const body = JSON.parse(init.body as string);
      const messages =
        provider === 'openai-responses'
          ? body.input
          : provider === 'gemini'
            ? body.contents
            : body.messages;
      const texts = (
        messages as { content?: string | { text?: string }[]; parts?: { text?: string }[] }[]
      ).flatMap((message) => {
        const content = provider === 'gemini' ? message.parts : message.content;
        return typeof content === 'string' ? [content] : (content ?? []).map((part) => part.text);
      });
      assert.deepEqual(
        texts,
        selections.map((range) => documentPrompt(source, text.slice(range.start, range.end))),
      );
      return new Response(providerStreams[provider].partial + providerStreams[provider].finish, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const stream = await openProviderStream(
      { ...config, provider },
      selected.map((part) => ({ role: 'user', content: '', files: [part] })),
      new AbortController().signal,
      undefined,
      async (part) => {
        reads++;
        const range = part.selection!.ranges[0];
        return text.slice(range.start, range.end);
      },
    );
    await stream.cancel();
    assert.equal(reads, 2);
    assert.equal(calls, 1);
  });
}
test('missing, altered and cancelled document reads fail before any supplier request', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response();
  });
  const context = [{ role: 'user' as const, content: '', files: [file] }],
    signal = new AbortController().signal;
  await assert.rejects(openProviderStream(config, context, signal), /无法读取/);
  await assert.rejects(
    openProviderStream(config, context, signal, undefined, async () => text.replace('42', '99')),
    /不符/,
  );
  const abort = new AbortController();
  await assert.rejects(
    openProviderStream(config, context, abort.signal, undefined, async () => {
      abort.abort();
      return text;
    }),
    /中断/,
  );
  assert.equal(calls, 0);
});
