import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  toolCallFromUIPart,
  toolUIPart,
  type EverChatUIMessage,
} from '../../../shared/conversation/ui-message';
import { validatePublicUIMessage } from '../../../shared/conversation/ui-validation';
import { MAX_MESSAGE_TEXT_BYTES } from '../../../shared/conversation/limits';
import { MAX_TOOL_INPUT_BYTES, type PublicToolCall } from '../../../shared/web-tools/tasks';
import { UIMessageState } from '../../../worker/streaming/ui-message-state';

const answer = (parts: EverChatUIMessage['parts']): EverChatUIMessage => ({
  id: 'answer',
  role: 'assistant',
  parts,
});

test('SDK validation preserves ordered text, reasoning, tools and public generation metadata', async () => {
  const call: PublicToolCall = {
    round: 0,
    state: 'completed',
    call: { id: 'search', name: 'web_search', input: { query: '网页搜索' } },
    result: { id: 'search', name: 'web_search', status: 'completed', sources: [] },
  };
  const value = {
    ...answer([
      { type: 'step-start' },
      { type: 'reasoning', id: 'r1', text: '先思考', state: 'done' },
      toolUIPart(call),
      { type: 'step-start' },
      { type: 'reasoning', id: 'r2', text: '继续思考', state: 'done' },
      { type: 'text', text: '回答', state: 'done' },
      { type: 'source-url', sourceId: 'source', url: 'https://example.com/', title: '引用' },
    ]),
    metadata: {
      createdAt: 1,
      providerId: 'provider',
      providerName: '供应商',
      model: 'model',
      modelName: '模型',
      generation: { usage: { inputTokens: 10, outputTokens: 20 }, usageIsFinal: true },
    },
  };
  const validated = await validatePublicUIMessage(value);
  assert.deepEqual(validated, value);
  assert.deepEqual(toolCallFromUIPart(validated.parts[2]), call);
});

test('tool parts retain pending, execution failure, invalid input and cancellation without making them executable', async () => {
  const base = { id: 'call', name: 'read_webpage' as const, input: { url: 'http://example.com/' } };
  const cases: PublicToolCall[] = [
    { round: 3, state: 'queued', call: base },
    { round: 3, state: 'running', call: base },
    {
      round: 3,
      state: 'failed',
      call: base,
      result: {
        id: 'call',
        name: 'read_webpage',
        status: 'failed',
        error: '网页未找到',
        failure: {
          provider: 'deepseek',
          code: 'PAGE_UNAVAILABLE',
          httpStatus: 404,
          terminal: false,
        },
      },
    },
    {
      round: 3,
      state: 'failed',
      call: { id: 'bad', name: 'unknown_tool', input: '{', invalid: true, error: '无效参数' },
      result: { id: 'bad', name: 'unknown_tool', status: 'failed', error: '无效参数' },
    },
    { round: 3, state: 'cancelled', call: base },
  ];
  for (const item of cases) {
    const value = await validatePublicUIMessage(answer([toolUIPart(item)]));
    assert.deepEqual(toolCallFromUIPart(value.parts[0]), item);
  }
  assert.throws(() => toolUIPart({ ...cases[0], state: 'completed' }));
  assert.throws(() => toolUIPart({ ...cases[2], state: 'cancelled' }));
  const part = toolUIPart(cases[0]);
  assert.throws(() =>
    toolCallFromUIPart({ ...part, toolMetadata: { round: 3, state: 'completed' } } as typeof part),
  );
});

test('public validation rejects SDK-private metadata, system prompts, raw attachments and unregistered data parts', async () => {
  const secret = 'private-signature-or-key';
  const values: unknown[] = [
    { ...answer([]), privateContext: secret },
    { ...answer([]), role: 'system', parts: [{ type: 'text', text: secret }] },
    { ...answer([]), metadata: { apiKey: secret } },
    {
      ...answer([]),
      metadata: { generation: { usage: { inputTokens: -1 }, usageIsFinal: true } },
    },
    answer([{ type: 'text', text: '正文', providerMetadata: { private: { signature: secret } } }]),
    answer([{ type: 'file', url: `data:text/plain,${secret}`, mediaType: 'text/plain' }]),
    { ...answer([]), parts: [{ type: 'data-everchat-checkpoint-barrier', data: secret }] },
    {
      ...answer([]),
      parts: [
        {
          ...toolUIPart({
            round: 0,
            state: 'queued',
            call: { id: 's', name: 'web_search', input: { query: 'q' } },
          }),
          callProviderMetadata: { private: secret },
        },
      ],
    },
  ];
  for (const [index, value] of values.entries())
    await assert.rejects(
      validatePublicUIMessage(value),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(secret), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      },
      `private field case ${index}`,
    );
});

test('public attachments are typed references with unique identities and bounded data, never model messages', async () => {
  const id = crypto.randomUUID();
  const image = {
    type: 'image' as const,
    attachmentId: id,
    name: 'image.png',
    sha256: 'a'.repeat(64),
    size: 12,
    mediaType: 'image/png' as const,
  };
  const part = { type: 'data-image' as const, id, data: image };
  const user = { id: 'user', role: 'user' as const, parts: [part] };
  assert.deepEqual(JSON.parse(JSON.stringify(await validatePublicUIMessage(user))), user);
  for (const value of [
    { ...user, parts: [part, part] },
    { ...user, parts: [{ ...part, id: 'mismatch' }] },
    { ...user, parts: [{ ...part, data: { ...image, url: 'data:image/png;base64,private' } }] },
    answer([part]),
    { ...user, parts: [{ type: 'reasoning', id: 'r', text: '不应来自用户' }] },
  ])
    await assert.rejects(validatePublicUIMessage(value));
});

test('aggregate content capacity spans every ordered part and repeated identities are refused', async () => {
  const half = 'x'.repeat(MAX_MESSAGE_TEXT_BYTES / 2);
  assert.equal(
    (await validatePublicUIMessage(answer([{ type: 'text', text: half }]))).parts.length,
    1,
  );
  for (const parts of [
    [
      { type: 'text' as const, text: half },
      { type: 'reasoning' as const, id: 'r', text: half + 'x' },
    ],
    [
      { type: 'reasoning' as const, id: 'r', text: 'a' },
      { type: 'reasoning' as const, id: 'r', text: 'b' },
    ],
  ])
    await assert.rejects(validatePublicUIMessage(answer(parts)));
});

test('canonical SDK checkpoints retain public tool state and restore a live answer without provider metadata', async () => {
  const item: PublicToolCall = {
    round: 0,
    state: 'completed',
    call: { id: 's', name: 'web_search', input: { query: 'q' } },
    result: { id: 's', name: 'web_search', status: 'completed', sources: [] },
  };
  const state = new UIMessageState('answer');
  let restored: UIMessageState | undefined;
  try {
    await state.apply([
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: '思考' },
      { type: 'reasoning-end', id: 'r' },
      {
        type: 'tool-input-available',
        toolCallId: 's',
        toolName: 'web_search',
        input: item.call.input,
        toolMetadata: { round: 0, state: 'queued' },
      },
      {
        type: 'tool-output-available',
        toolCallId: 's',
        output: item.result,
        toolMetadata: { round: 0, state: 'completed' },
      },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: '回答' },
    ]);
    const checkpoint = state.checkpoint();
    const message = await validatePublicUIMessage(checkpoint.message);
    restored = await UIMessageState.restore({ ...checkpoint, message });
    const completed = await restored.apply([
      { type: 'text-delta', id: 't', delta: '完成' },
      { type: 'text-end', id: 't' },
    ]);
    assert.deepEqual(toolCallFromUIPart((await validatePublicUIMessage(completed)).parts[2]), item);
    const last = completed.parts.at(-1);
    assert.equal(last?.type === 'text' && last.text, '回答完成');
  } finally {
    await state.dispose();
    await restored?.dispose();
  }
});

test('a maximum-size failed tool input fits the SDK envelope and survives canonical replay', async () => {
  const input = 'x'.repeat(MAX_TOOL_INPUT_BYTES - 2);
  const state = new UIMessageState('answer');
  let restored: UIMessageState | undefined;
  try {
    const message = await state.apply([
      {
        type: 'tool-input-error',
        toolCallId: 'bad',
        toolName: 'unknown_tool',
        input,
        errorText: '无效参数',
        dynamic: true,
        toolMetadata: { round: 0, state: 'failed', invalid: true },
      },
    ]);
    const validated = await validatePublicUIMessage(message);
    restored = await UIMessageState.restore({ ...state.checkpoint(), message: validated });
    const result = toolCallFromUIPart(
      (await validatePublicUIMessage(restored.checkpoint().message)).parts[0],
    );
    assert.equal(result.call.input, input);
    assert.equal(result.state, 'failed');
    const part = { ...validated.parts[0], input: input + 'x' };
    await assert.rejects(validatePublicUIMessage({ ...validated, parts: [part] }));
  } finally {
    await state.dispose();
    await restored?.dispose();
  }
});
