import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../../../shared/conversation/types';
import { isReportedToolFailure } from '../../../src/features/chat/message-errors';

const message = (): Message => ({
  id: 'answer',
  role: 'assistant',
  parts: [],
  status: 'failed',
  createdAt: 0,
  runId: null,
  parentId: null,
  revisionOf: null,
  error: 'Generic tool failure',
  generation: {
    usage: {},
    usageIsFinal: false,
    issue: { code: 'TOOL_FAILED' },
    failure: { stage: 'tool', occurredAt: 0 },
  },
  tools: {
    status: 'failed',
    round: 0,
    calls: [
      {
        round: 0,
        state: 'failed',
        call: { id: 'search', name: 'web_search', input: { query: 'question' } },
        result: {
          id: 'search',
          name: 'web_search',
          status: 'failed',
          error: 'Specific service authorization failure',
          issue: { code: 'TOOL_FAILED' },
        },
      },
    ],
  },
});

test('a terminating tool failure is identified by its stage even when error texts differ', () => {
  assert.equal(isReportedToolFailure(message()), true);
  const withoutDetails = message();
  delete withoutDetails.generation!.failure;
  assert.equal(isReportedToolFailure(withoutDetails), true);
});

test('an independent provider failure remains visible alongside earlier failed tools', () => {
  const distinct = message();
  distinct.generation!.failure!.stage = 'response';
  distinct.generation!.issue = { code: 'PROVIDER_UNAUTHORIZED' };
  assert.equal(isReportedToolFailure(distinct), false);
  distinct.tools = undefined;
  assert.equal(isReportedToolFailure(distinct), false);
});
