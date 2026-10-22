import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { reasoningBlocks, updateToolTask } from '../../../shared/web-tools/reasoning-flow';
import {
  publicToolTaskSchema,
  validReasoningBreaks,
  type PublicToolCall,
  type PublicToolTask,
} from '../../../shared/web-tools/tasks';

const call = (round: number, id = `call-${round}`): PublicToolCall => ({
  round,
  call: { id, name: 'web_search', input: { query: '资料🙂' } },
  state: 'queued',
});
const task = (calls: PublicToolCall[] = []): PublicToolTask => ({
  status: 'active',
  round: calls.at(-1)?.round ?? 0,
  calls,
  reasoningBreaks: [],
});

test('reasoning positions interleave rounds, keep parallel call order, and survive state refresh and final cleanup', () => {
  const text = '前段🙂后段。终段';
  const first = updateToolTask(task(), task([call(0), call(0, 'parallel')]), text, {
    round: 0,
    reasoningEnd: 4,
  });
  const next = updateToolTask(first, { ...task([...first.calls, call(1)]), round: 1 }, text, {
    round: 1,
    reasoningEnd: 7,
  });
  const final = updateToolTask(
    next,
    {
      ...next,
      status: 'completed',
      calls: next.calls.map((item) => ({
        ...item,
        state: 'completed',
        result: { id: item.call.id, name: 'web_search', status: 'completed', sources: [] },
      })),
    },
    text,
  );
  assert.equal(v.is(publicToolTaskSchema, final), true);
  const blocks = reasoningBlocks(text, final);
  assert.deepEqual(
    blocks.map((block) =>
      block.type === 'reasoning' ? block.text : block.calls.map((item) => item.call.id),
    ),
    ['前段🙂', ['call-0', 'parallel'], '后段。', ['call-1'], '终段'],
  );
  assert.equal(
    blocks
      .filter((block) => block.type === 'reasoning')
      .map((block) => block.text)
      .join(''),
    text,
  );
  assert.deepEqual(updateToolTask(final, final, text, { round: 0, reasoningEnd: 4 }), final);
  assert.throws(
    () => updateToolTask(final, final, text, { round: 0, reasoningEnd: 5 }),
    /不能覆盖/,
  );
});

test('empty thought rounds share positions and historical tools remain after the complete thought', () => {
  const tools = {
    ...task([call(0), call(1)]),
    reasoningBreaks: [
      { round: 0, reasoningEnd: 0 },
      { round: 1, reasoningEnd: 0 },
    ],
  };
  assert.equal(validReasoningBreaks(tools, ''), true);
  assert.deepEqual(
    reasoningBlocks('', tools)
      .filter((block) => block.type === 'tools')
      .map((block) => block.round),
    [0, 1],
  );
  const { reasoningBreaks: _, ...historical } = tools;
  assert.deepEqual(
    reasoningBlocks('历史思考', historical).map((block) => block.type),
    ['reasoning', 'tools', 'tools'],
  );
  assert.equal(
    updateToolTask(historical, historical, '历史思考', { round: 0, reasoningEnd: 2 })
      .reasoningBreaks,
    undefined,
  );
});

test('positions reject missing, duplicated, reversed, out-of-range and split-surrogate boundaries', () => {
  const tools = task([call(0), call(1)]);
  for (const breaks of [
    [],
    [{ round: 0, reasoningEnd: 0 }],
    [
      { round: 0, reasoningEnd: 0 },
      { round: 0, reasoningEnd: 2 },
    ],
    [
      { round: 1, reasoningEnd: 0 },
      { round: 0, reasoningEnd: 2 },
    ],
    [
      { round: 0, reasoningEnd: 2 },
      { round: 1, reasoningEnd: 1 },
    ],
    [
      { round: 0, reasoningEnd: -1 },
      { round: 1, reasoningEnd: 1 },
    ],
    [
      { round: 0, reasoningEnd: 0.5 },
      { round: 1, reasoningEnd: 2 },
    ],
  ]) {
    assert.equal(v.is(publicToolTaskSchema, { ...tools, reasoningBreaks: breaks }), false);
  }
  for (const end of [1, 4, Number.MAX_SAFE_INTEGER]) {
    const invalid = { ...task([call(0)]), reasoningBreaks: [{ round: 0, reasoningEnd: end }] };
    assert.equal(validReasoningBreaks(invalid, '🙂中'), false);
    assert.throws(() => reasoningBlocks('🙂中', invalid));
  }
  assert.equal(
    validReasoningBreaks(
      { ...task([call(0)]), reasoningBreaks: [{ round: 0, reasoningEnd: 2 }] },
      '🙂中',
    ),
    true,
  );
});
