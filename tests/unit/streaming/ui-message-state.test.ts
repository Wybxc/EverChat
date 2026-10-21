import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_UI_APPLY_BYTES, replayUIMessage } from '../../../shared/streaming/ui-checkpoint';
import { UIMessageState } from '../../../worker/streaming/ui-message-state';

test('SDK UI batches acknowledge ordered parts without mutating an earlier checkpoint', async () => {
  const state = new UIMessageState('answer');
  try {
    const first = await state.apply([
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'thought-1' },
      { type: 'reasoning-delta', id: 'thought-1', delta: '先思考。' },
      { type: 'reasoning-end', id: 'thought-1' },
      {
        type: 'tool-input-available',
        toolCallId: 'search',
        toolName: 'web_search',
        input: { query: '原始查询' },
        dynamic: true,
      },
    ]);
    const second = await state.apply([
      { type: 'tool-output-available', toolCallId: 'search', output: { sources: [] } },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'thought-2' },
      { type: 'reasoning-delta', id: 'thought-2', delta: '再思考。' },
      { type: 'reasoning-end', id: 'thought-2' },
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: '回答' },
    ]);
    assert.deepEqual(
      second.parts.map((part) => part.type),
      ['step-start', 'reasoning', 'dynamic-tool', 'step-start', 'reasoning', 'text'],
    );
    assert.equal(first.parts[2].type, 'dynamic-tool');
    assert.equal(first.parts[2].state, 'input-available');
    assert.equal(second.parts[2].type, 'dynamic-tool');
    assert.equal(second.parts[2].state, 'output-available');
    assert.equal(second.parts.at(-1)?.type, 'text');
    const third = await state.apply([
      { type: 'text-delta', id: 'text', delta: '完成。' },
      { type: 'text-end', id: 'text' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const secondText = second.parts.at(-1),
      thirdText = third.parts.at(-1);
    assert.equal(secondText?.type === 'text' && secondText.text, '回答');
    assert.equal(thirdText?.type === 'text' && thirdText.text, '回答完成。');
    assert.equal(
      third.parts.some((part) => part.type.startsWith('data-')),
      false,
    );
    await state.close();
  } finally {
    await state.dispose();
  }
});

test('SDK UI checkpoint includes boundary-only batches and local tool failures', async () => {
  const state = new UIMessageState('answer');
  try {
    const boundary = await state.apply([{ type: 'start-step' }]);
    assert.deepEqual(boundary.parts, [{ type: 'step-start' }]);
    const message = await state.apply([
      {
        type: 'tool-input-error',
        toolCallId: 'bad',
        toolName: 'unknown_tool',
        input: '{',
        dynamic: true,
        errorText: '无效参数',
      },
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: '工具失败仍可回答。' },
      { type: 'text-end', id: 'answer' },
    ]);
    assert.equal(message.parts[1].type, 'dynamic-tool');
    assert.equal(message.parts[1].state, 'output-error');
    assert.equal(message.parts[1].errorText, '无效参数');
    assert.equal(message.parts[2].type === 'text' && message.parts[2].text, '工具失败仍可回答。');
  } finally {
    await state.dispose();
  }
});

test('UI checkpoint batches are bounded and cannot overlap or replace their answer identity', async () => {
  const state = new UIMessageState('answer');
  try {
    await assert.rejects(
      state.apply([{ type: 'text-delta', id: 'a', delta: 'a'.repeat(MAX_UI_APPLY_BYTES) }]),
      /buffer limit/,
    );
    await assert.rejects(state.apply([{ type: 'start', messageId: 'other' }]), /identity/);
    await assert.rejects(
      state.apply([{ type: 'data-everchat-checkpoint-barrier', data: 1, transient: true }]),
      /Reserved/,
    );
    const applied = state.apply([{ type: 'text-start', id: 'a' }]);
    await assert.rejects(state.apply([{ type: 'text-delta', id: 'a', delta: 'extra' }]), /Await/);
    await applied;
    assert.equal(state.message?.parts.length, 1);
  } finally {
    await state.dispose();
  }
});

test('an invalid SDK part rejects its batch instead of acknowledging a damaged checkpoint', async () => {
  const state = new UIMessageState('answer');
  try {
    await assert.rejects(
      state.apply([{ type: 'text-delta', id: 'missing', delta: 'bad' }]),
      /missing/,
    );
    await assert.rejects(state.apply([{ type: 'text-start', id: 'later' }]), /missing/);
  } finally {
    await state.dispose();
  }
});

test('disposing a checkpoint reducer settles an outstanding batch', async () => {
  const state = new UIMessageState('answer');
  const applied = state.apply([{ type: 'text-start', id: 'a' }]);
  const rejected = assert.rejects(applied, /disposed/);
  await state.dispose();
  await rejected;
});

test('a fresh SDK reducer restores active text and reasoning IDs and appends exactly once', async () => {
  const original = new UIMessageState('answer');
  let restored: UIMessageState | undefined;
  try {
    const prefix = '汉字😀\n'.repeat(2500);
    await original.apply([
      { type: 'start-step' },
      {
        type: 'tool-input-available',
        toolCallId: 'search',
        toolName: 'web_search',
        input: { query: '查找' },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'search',
        output: { id: 'search', name: 'web_search', status: 'completed', sources: [] },
      },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'thought' },
      { type: 'reasoning-delta', id: 'thought', delta: '思考前缀' },
      { type: 'text-start', id: 'live-text' },
      { type: 'text-delta', id: 'live-text', delta: prefix },
    ]);
    const checkpoint = original.checkpoint();
    assert.deepEqual(checkpoint.active, [
      { type: 'reasoning', id: 'thought', index: 3 },
      { type: 'text', id: 'live-text', index: 4 },
    ]);
    assert.ok([...replayUIMessage(checkpoint)].length > 10);
    restored = await UIMessageState.restore(JSON.parse(JSON.stringify(checkpoint)));
    const message = await restored.apply([
      { type: 'reasoning-delta', id: 'thought', delta: '，继续思考' },
      { type: 'reasoning-end', id: 'thought' },
      { type: 'text-delta', id: 'live-text', delta: '，继续回答' },
      { type: 'text-end', id: 'live-text' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    assert.equal(
      message.parts[3].type === 'reasoning' && message.parts[3].text,
      '思考前缀，继续思考',
    );
    assert.equal(message.parts[4].type === 'text' && message.parts[4].text, prefix + '，继续回答');
    assert.equal(message.parts.length, checkpoint.message.parts.length);
    assert.deepEqual(restored.checkpoint().active, []);
    assert.doesNotMatch(JSON.stringify(restored.checkpoint()), /data-everchat-checkpoint-/);
    assert.equal(
      checkpoint.message.parts[4].type === 'text' && checkpoint.message.parts[4].text,
      prefix,
    );
  } finally {
    await original.dispose();
    await restored?.dispose();
  }
});

test('restore refuses incomplete or ambiguous active-ID maps and partial tool arguments', async () => {
  const message = {
    id: 'answer',
    role: 'assistant' as const,
    parts: [{ type: 'text' as const, text: 'saved', state: 'streaming' as const }],
  };
  await assert.rejects(UIMessageState.restore({ message, active: [] }), /Missing UI active/);
  await assert.rejects(
    UIMessageState.restore({
      message,
      active: [
        { type: 'text', id: 'same', index: 0 },
        { type: 'text', id: 'same', index: 0 },
      ],
    }),
    /Invalid UI active/,
  );
  await assert.rejects(
    UIMessageState.restore({
      message: {
        id: 'answer',
        role: 'assistant',
        parts: [
          { type: 'dynamic-tool', toolCallId: 'a', toolName: 'unknown', state: 'input-streaming' },
        ],
      },
      active: [],
    }),
    /Unsupported UI tool/,
  );
});
