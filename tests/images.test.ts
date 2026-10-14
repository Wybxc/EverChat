import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { assertChatImage, assertImageContext, IMAGE_TOKEN_ALLOWANCE, imageDimensions, imagePartSchema, type ImagePart } from '../shared/images';
import { messageImages, messagePartsSchema } from '../shared/message-content';
import { assertContextFits, buildContext, contextHistory, contextSource } from '../shared/context-budget';
import { DEFAULT_CONVERSATION_SETTINGS } from '../shared/conversation-settings';
import { resolveModelMetadata } from '../shared/model-metadata';
import { openProviderStream } from '../worker/provider';
import { summaryContext, summaryGeneration } from '../shared/summaries';
import type { Message, ProviderConfig, ProviderKind } from '../shared/types';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const image: ImagePart = { type: 'image', attachmentId: crypto.randomUUID(), name: 'picture.png', sha256: createHash('sha256').update(png).digest('hex'), size: png.length, mediaType: 'image/png' };
const config: ProviderConfig = { provider: 'openai-chat', model: 'vision', baseUrl: 'https://provider.test/v1', apiKey: 'unit-test-key', systemPrompt: '', maxOutputTokens: null,
  modelMetadata: resolveModelMetadata('openai-chat', { id: 'vision', name: '', enabled: true, metadataOverrides: { imageInput: true, contextWindow: 200000 } }) };

test('image parts contain only bounded immutable private references and fit canonical message channels', () => {
  assert.ok(v.safeParse(imagePartSchema, image).success);
  for (const patch of [{ url: 'https://public/image' }, { data: png.toString('base64') }, { size: 1048577 }, { mediaType: 'image/svg+xml' }, { sha256: 'bad' }]) assert.equal(v.safeParse(imagePartSchema, { ...image, ...patch }).success, false);
  assert.ok(v.safeParse(messagePartsSchema, [{ type: 'text', text: '图是什么？' }, image]).success);
  assert.ok(v.safeParse(messagePartsSchema, [image]).success);
  assert.equal(v.safeParse(messagePartsSchema, [image, image]).success, false);
  assert.equal(v.safeParse(messagePartsSchema, [image, { type: 'text', text: 'wrong order' }]).success, false);
});
test('image format and dimensions are bounded before provider calls', () => {
  assert.deepEqual(imageDimensions(png, 'image/png'), { width: 1, height: 1 });
  assert.doesNotThrow(() => assertChatImage(png, 'image/png'));
  assert.throws(() => assertChatImage(png, 'image/jpeg'), /类型/);
  assert.throws(() => assertChatImage(png.subarray(0, 9), 'image/png'), /无效/);
  const large = Buffer.from(png); large.writeUInt32BE(5000, 16);
  assert.throws(() => assertChatImage(large, 'image/png'), /限制/);
  assert.throws(() => assertImageContext([{ role: 'user', content: '', images: [image] }], {}), /不支持图片/);
  assert.throws(() => assertImageContext([{ role: 'assistant', content: '', images: [image] }], config), /用户消息/);
  assert.throws(() => assertImageContext([{ role: 'user', content: '', images: Array(9).fill(image) }], config), /8 张/);
});
test('image-only questions, retries, branches and budget planning retain references without binary payloads', () => {
  const user: Message = { id: crypto.randomUUID(), role: 'user', parts: [image], status: 'completed', createdAt: 1, runId: null, parentId: null, revisionOf: null, error: null };
  const answer: Message = { ...user, id: crypto.randomUUID(), role: 'assistant', parts: [{ type: 'text', text: '结果' }], parentId: user.id };
  assert.deepEqual(contextHistory([user, answer], answer.id)[0], { role: 'user', content: '', images: [image] });
  assert.deepEqual(contextSource([user, answer], { retryOf: answer.id }).images, [image]);
  assert.deepEqual(messageImages(user), [image]);
  const built = buildContext(contextHistory([user, answer], answer.id), '', config, DEFAULT_CONVERSATION_SETTINGS, undefined, [image]);
  assert.equal(built.estimate.imageTokens, IMAGE_TOKEN_ALLOWANCE * 2);
  assert.equal(built.estimate.inputTokens, IMAGE_TOKEN_ALLOWANCE);
  assert.deepEqual(built.messages.at(-1)?.images, [image]);
  assert.throws(() => assertContextFits(buildContext([], '', config, { ...DEFAULT_CONVERSATION_SETTINGS, contextBudget: 100 }, undefined, [image]).estimate), /超过/);
  assert.ok(!JSON.stringify(built).includes(png.toString('base64')));
});

for (const [provider, native] of [['openai-chat', false], ['openai-chat', true], ['openai-responses', false], ['anthropic', false], ['gemini', false]] as [ProviderKind, boolean][]) {
  test(`${provider}${native ? ' official endpoint' : ''} embeds private image bytes in its native request with no public file URL`, async (t) => {
    let calls = 0, reads = 0;
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
      calls++;
      const body = JSON.parse(init.body as string), encoded = png.toString('base64');
      if (provider === 'openai-chat') assert.deepEqual(body.messages[0].content[0], { type: 'image_url', image_url: { url: `data:image/png;base64,${encoded}` } });
      if (provider === 'openai-responses') assert.deepEqual(body.input[0].content[0], { type: 'input_image', image_url: `data:image/png;base64,${encoded}` });
      if (provider === 'anthropic') assert.deepEqual(body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: encoded } });
      if (provider === 'gemini') assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: encoded } });
      assert.ok(!JSON.stringify(body).includes('/api/conversations/'));
      return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const stream = await openProviderStream({ ...config, provider, ...(native ? { baseUrl: 'https://api.openai.com/v1' } : {}) }, [{ role: 'user', content: '', images: [image] }], new AbortController().signal, async () => { reads++; return png; });
    await stream.cancel(); assert.equal(calls, 1); assert.equal(reads, 1);
  });
}
test('unsupported, missing or invalid images never send a supplier request', async (t) => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(); });
  const context = [{ role: 'user' as const, content: '', images: [image] }], signal = new AbortController().signal;
  await assert.rejects(openProviderStream({ ...config, modelMetadata: undefined }, context, signal, async () => png), /不支持图片/);
  await assert.rejects(openProviderStream(config, context, signal), /无法读取/);
  await assert.rejects(openProviderStream(config, context, signal, async () => new Uint8Array(png.length)), /类型/);
  assert.equal(calls, 0);
});
test('history summaries require a vision model and retain image-only source messages', () => {
  const user: Message = { id: crypto.randomUUID(), role: 'user', parts: [image], status: 'completed', createdAt: 1, runId: null, parentId: null, revisionOf: null, error: null };
  const answer: Message = { ...user, id: crypto.randomUUID(), role: 'assistant', parts: [{ type: 'text', text: '识图结果' }], parentId: user.id };
  const prepared = summaryGeneration([user, answer], answer.id, config);
  assert.deepEqual(prepared.context[0].images, [image]);
  assert.equal(prepared.estimate.imageTokens, IMAGE_TOKEN_ALLOWANCE);
  assert.deepEqual(summaryContext([user, answer], answer.id, false).history[0].images, [image]);
  assert.throws(() => summaryGeneration([user, answer], answer.id, { ...config, modelMetadata: undefined }), /不支持图片/);
});
test('cancelling while loading private image bytes never starts a supplier request', async (t) => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(); });
  const abort = new AbortController();
  await assert.rejects(openProviderStream(config, [{ role: 'user', content: '', images: [image] }], abort.signal, async () => { abort.abort(); return png; }), /中断/);
  assert.equal(calls, 0);
});
