import { collectProviderToolTurn } from '../../support/providers/tool-turn';
import { MAX_MESSAGE_TEXT_BYTES } from '../../../shared/conversation/limits';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { resolveModelMetadata } from '../../../shared/models/metadata';
import type { ProviderConfig, ProviderKind } from '../../../shared/providers/types';
import {
  publicToolTaskSchema,
  type WebToolCall,
  type WebToolOutcome,
} from '../../../shared/web-tools/tasks';
import * as v from 'valibot';
import type { SqlQuery } from '../../../worker/generation/metrics';
import { providerToolIdentity, type ProviderToolTurn } from '../../../worker/providers/tool-turn';
import {
  MAX_TOOL_TASKS,
  TOOL_DEFINITION_TOKENS,
  TOOL_TASK_TIMEOUT_MS,
  ToolTaskJournal,
  type StartToolTask,
} from '../../../worker/web-tools/task-journal';
import { fragmentedToolBody, toolStream } from '../../support/providers/tool-streams';

const enabled = ['web_search', 'read_webpage'] as const;
const configuration = (
  provider: ProviderKind = 'openai-chat',
): ProviderConfig & { apiKey: string; systemPrompt: string } => ({
  provider,
  baseUrl: 'https://provider.example/v1',
  apiKey: 'private-test-key',
  model: 'tool-fixture',
  systemPrompt: 'private-system-prompt',
  maxOutputTokens: null,
  modelMetadata: resolveModelMetadata(provider, {
    id: 'tool-fixture',
    name: 'Fixture',
    enabled: true,
    metadataOverrides: { toolCalls: true },
  }),
});
const config = configuration();
const start = (overrides: Partial<StartToolTask> = {}): StartToolTask => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  messageId: crypto.randomUUID(),
  requestHash: 'a'.repeat(64),
  enabled,
  inputBudget: 1_000_000,
  initialTokens: 1000,
  ...overrides,
});
const call = (id = 'search-0'): WebToolCall => ({
  id,
  name: 'web_search',
  input: { query: 'Cloudflare 文档' },
});
const outcome = (id = 'search-0'): WebToolOutcome => ({
  id,
  name: 'web_search',
  status: 'completed',
  sources: [{ title: '文档', url: 'https://developers.cloudflare.com/', content: '参考资料🙂' }],
});
function turn(calls: WebToolCall[] = [call()], text = '', reasoning = ''): ProviderToolTurn {
  return {
    identity: providerToolIdentity(config),
    finishReason: calls.length ? 'tool-calls' : 'stop',
    calls,
    content: [
      ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...calls.map((item) => ({
        type: 'tool-call' as const,
        toolCallId: item.id,
        toolName: item.name,
        input: item.input,
      })),
    ],
    usage: { inputTokens: 5, outputTokens: 3 },
    usageIsFinal: true,
  };
}
function database(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    statement: string,
    ...bindings: SqlStorageValue[]
  ) => {
    const rows = db.prepare(statement).all(...(bindings as (string | number | null)[])) as T[];
    return {
      toArray: () => rows,
      one: () => {
        assert.equal(rows.length, 1);
        return rows[0];
      },
      *[Symbol.iterator]() {
        yield* rows;
      },
    };
  };
  let now = 1000;
  const reader = () => new ToolTaskJournal(query, () => now),
    journal = reader();
  const write = <T>(operation: (journal: ToolTaskJournal) => T): T => {
    db.exec('BEGIN');
    try {
      const result = operation(journal);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const begin = (input = start(), provider = config) => {
    write((j) => j.create(input, provider));
    return input;
  };
  const save = (input: StartToolTask, value = turn(), provider = config) => {
    write((j) => j.claimModel(input.runId));
    write((j) => j.saveTurn(input.runId, value, provider));
  };
  const finish = (root: string, id: string) => {
    write((j) => j.claimTool(root, id));
    write((j) => j.finishTool(root, id, outcome(id)));
  };
  return {
    db,
    query,
    journal,
    reader,
    write,
    begin,
    save,
    finish,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

test('task acceptance pins identity and immutable budgets, deduplicates after a fresh reader, and keeps credentials out of SQL', (t) => {
  const { query, reader, write, begin } = database(t),
    input = begin();
  const initial = reader().state(input.id);
  assert.deepEqual(
    write((j) => j.create(input, { ...config, apiKey: 'rotated-private-key' })),
    initial,
  );
  for (const override of [
    { requestHash: 'b'.repeat(64) },
    { runId: crypto.randomUUID() },
    { messageId: crypto.randomUUID() },
    { initialTokens: 1001 },
    { inputBudget: 200_000 },
    { enabled: ['web_search'] as const },
  ]) {
    assert.throws(() => write((j) => j.create({ ...input, ...override }, config)), /另一项请求/);
  }
  assert.throws(
    () => write((j) => j.create(input, { ...config, model: 'different' })),
    /另一项请求/,
  );
  assert.throws(() => begin(), /已有工具任务/);
  const stored = JSON.stringify(query('SELECT * FROM web_tool_tasks').toArray());
  assert.ok(!stored.includes(config.apiKey) && !stored.includes(config.systemPrompt));
  assert.deepEqual(reader().state(input.id), initial);
});

test('invalid IDs, unknown capabilities and insufficient initial context cannot create a task', (t) => {
  const { begin, query } = database(t);
  for (const input of [
    start({ id: 'invalid' }),
    start({ requestHash: 'A'.repeat(64) }),
    start({ enabled: [] }),
    start({ enabled: ['web_search', 'web_search'] }),
    start({ inputBudget: 10_000_001 }),
    start({ initialTokens: -1 }),
    start({ inputBudget: 1000 + TOOL_DEFINITION_TOKENS - 1 }),
  ])
    assert.throws(() => begin(input));
  assert.throws(() => begin(start(), { ...config, modelMetadata: undefined }), /不支持/);
  assert.equal(
    query<{ count: number }>('SELECT COUNT(*) AS count FROM web_tool_tasks').one().count,
    0,
  );
});

test('model claims are durable and reentry cannot consume another request', (t) => {
  const { reader, write, begin } = database(t),
    input = begin();
  assert.equal(
    write((j) => j.claimModel(input.runId)),
    true,
  );
  assert.equal(
    write(() => reader().claimModel(input.runId)),
    false,
  );
  assert.equal(reader().state(input.id).modelRequests, 1);
});

test('public history spans rounds without private continuation, and erasure is terminal-only and transactional', (t) => {
  const { query, reader, write, begin, save, finish } = database(t),
    input = begin();
  assert.throws(() => write((j) => j.erase(input.id)), /先停止/);
  save(input);
  finish(input.id, 'search-0');
  const next = crypto.randomUUID();
  write((j) => j.queueModel(input.id, 1, next, input.messageId, config));
  write((j) => j.claimModel(next));
  write((j) => j.saveTurn(next, turn([], '最终回答'), config));
  const expected = {
    status: 'completed',
    round: 1,
    calls: [{ round: 0, call: call(), state: 'completed', result: outcome() }],
  };
  assert.deepEqual(reader().publicTask(input.id), expected);
  assert.doesNotMatch(
    JSON.stringify(reader().publicTask(input.id)),
    /providerOptions|private-test-key|private-system-prompt|最终回答/,
  );
  assert.throws(
    () =>
      write((j) => {
        j.erase(input.id);
        throw new Error('Caller rollback');
      }),
    /Caller rollback/,
  );
  assert.deepEqual(reader().publicTask(input.id), expected);
  write((j) => j.erase(input.id));
  write((j) => j.erase(input.id));
  for (const table of [
    'web_tool_tasks',
    'web_tool_models',
    'web_tool_calls',
    'web_tool_notifications',
  ])
    assert.equal(query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count, 0);
});

for (const provider of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const)
  test(`${provider} private continuation survives SQLite reopening while orchestration state remains small and public`, async (t) => {
    const { query, reader, write, begin } = database(t),
      settings = configuration(provider),
      input = begin(start(), settings);
    const value = await collectProviderToolTurn(
      settings,
      enabled,
      fragmentedToolBody(toolStream(provider, { count: 2, redacted: true })),
      new AbortController().signal,
    );
    write((j) => j.claimModel(input.runId));
    write((j) => j.saveTurn(input.runId, value, settings));
    const view = reader();
    assert.deepEqual(JSON.parse(view.model(input.runId)!.turn!), value);
    for (const item of value.calls) {
      write((j) => j.claimTool(input.id, item.id));
      write((j) => j.finishTool(input.id, item.id, outcome(item.id)));
    }
    assert.deepEqual(view.exchanges(input.id, 1, settings)[0], {
      turn: value,
      outcomes: value.calls.map((item) => outcome(item.id)),
    });
    const publicState = JSON.stringify({
      state: view.state(input.id),
      calls: view.publicCalls(input.runId),
    });
    assert.ok(publicState.length < 3000);
    for (const privateValue of [
      'providerOptions',
      'signature',
      'encrypted-fixture',
      'redacted-fixture',
      settings.apiKey,
      settings.systemPrompt,
    ])
      assert.ok(!publicState.includes(privateValue), privateValue);
    assert.equal(
      query<{ count: number }>('SELECT COUNT(*) AS count FROM web_tool_notifications').one().count,
      1,
    );
  });

test('unclaimed, mismatched or malformed model turns never publish executable calls', (t) => {
  const { journal, write, begin } = database(t),
    input = begin(),
    value = turn();
  assert.throws(() => write((j) => j.saveTurn(input.runId, value, config)), /未认领/);
  write((j) => j.claimModel(input.runId));
  const malformed = [
    turn([call(), call()]),
    { ...value, identity: 'other' },
    { ...value, calls: [] },
    {
      ...value,
      content: [
        ...value.content,
        { type: 'tool-call', toolCallId: 'extra', toolName: 'web_search', input: { query: 'x' } },
      ],
    },
    turn([call()], 'x'.repeat(MAX_MESSAGE_TEXT_BYTES + 1)),
    turn([call()], '', 'x'.repeat(MAX_MESSAGE_TEXT_BYTES + 1)),
  ] as ProviderToolTurn[];
  for (const invalid of malformed)
    assert.throws(() => write((j) => j.saveTurn(input.runId, invalid, config)));
  assert.throws(
    () =>
      write((j) =>
        j.saveTurn(input.runId, value, { ...config, baseUrl: 'https://other.example/' }),
      ),
    /供应商/,
  );
  assert.deepEqual(journal.publicCalls(input.runId), []);
  assert.equal(journal.state(input.id).phase, 'running');
});

test('saved turns and results cannot be overwritten, and a continuation waits for all matching results', (t) => {
  const { journal, write, begin, save } = database(t),
    input = begin(),
    value = turn([call('one'), call('two')]);
  save(input, value);
  assert.equal(
    write((j) => j.saveTurn(input.runId, structuredClone(value), config)),
    false,
  );
  assert.throws(
    () => write((j) => j.saveTurn(input.runId, turn([call('other')]), config)),
    /不同结果/,
  );
  const runId = crypto.randomUUID(),
    messageId = crypto.randomUUID();
  assert.throws(
    () => write((j) => j.queueModel(input.id, 1, runId, messageId, config)),
    /完整保存/,
  );
  assert.throws(() => write((j) => j.finishTool(input.id, 'one', outcome('one'))), /尚未认领/);
  assert.equal(
    write((j) => j.claimTool(input.id, 'one')),
    true,
  );
  assert.equal(
    write((j) => j.claimTool(input.id, 'one')),
    false,
  );
  assert.throws(() => write((j) => j.finishTool(input.id, 'one', outcome('two'))), /原调用不符/);
  assert.throws(
    () => write((j) => j.finishTool(input.id, 'one', { ...outcome('one'), name: 'read_webpage' })),
    /原调用不符/,
  );
  assert.equal(
    write((j) => j.finishTool(input.id, 'one', outcome('one'))),
    true,
  );
  assert.equal(
    write((j) => j.finishTool(input.id, 'one', structuredClone(outcome('one')))),
    false,
  );
  assert.throws(
    () =>
      write((j) =>
        j.finishTool(input.id, 'one', {
          id: 'one',
          name: 'web_search',
          status: 'failed',
          error: 'changed',
        }),
      ),
    /不能覆盖/,
  );
  assert.throws(
    () => write((j) => j.queueModel(input.id, 1, runId, messageId, config)),
    /完整保存/,
  );
  write((j) => j.claimTool(input.id, 'two'));
  write((j) =>
    j.finishTool(input.id, 'two', {
      id: 'two',
      name: 'web_search',
      status: 'failed',
      error: '服务暂不可用',
    }),
  );
  assert.equal(
    write((j) => j.queueModel(input.id, 1, runId, messageId, config)),
    true,
  );
  assert.equal(
    write((j) => j.queueModel(input.id, 1, runId, messageId, config)),
    false,
  );
  assert.throws(
    () => write((j) => j.queueModel(input.id, 1, crypto.randomUUID(), messageId, config)),
    /其他步骤/,
  );
  assert.equal(journal.state(input.id).modelRequests, 1, 'queueing does not contact the model');
  assert.equal(journal.state(input.id).toolRequests, 2);
});

test('different call IDs, enabled tools and stored result correspondence are revalidated before continuation', (t) => {
  const { query, write, begin, save, finish } = database(t),
    input = begin();
  save(input);
  finish(input.id, 'search-0');
  query('UPDATE web_tool_calls SET outcome = ?', JSON.stringify(outcome('different')));
  assert.throws(
    () => write((j) => j.queueModel(input.id, 1, crypto.randomUUID(), crypto.randomUUID(), config)),
    /原调用不符/,
  );
  query('UPDATE web_tool_calls SET outcome = ?', JSON.stringify(outcome()));
  assert.throws(
    () => write((j) => j.queueModel(input.id, 2, crypto.randomUUID(), crypto.randomUUID(), config)),
    /跳过/,
  );
  assert.throws(
    () =>
      write((j) =>
        j.queueModel(input.id, 1, crypto.randomUUID(), crypto.randomUUID(), {
          ...config,
          model: 'other',
        }),
      ),
    /供应商/,
  );
  const runId = crypto.randomUUID();
  write((j) => j.queueModel(input.id, 1, runId, crypto.randomUUID(), config));
  write((j) => j.claimModel(runId));
  assert.throws(() => write((j) => j.saveTurn(runId, turn(), config)), /重复使用/);
});

test('context budget stops continuation before a new model claim or request', (t) => {
  const { journal, query, write, begin, save, finish } = database(t),
    input = begin(start({ inputBudget: 1000 + TOOL_DEFINITION_TOKENS }));
  save(input);
  finish(input.id, 'search-0');
  assert.throws(
    () => write((j) => j.queueModel(input.id, 1, crypto.randomUUID(), crypto.randomUUID(), config)),
    /上下文预算/,
  );
  assert.equal(journal.state(input.id).modelRequests, 1);
  assert.equal(journal.state(input.id).round, 0);
  assert.equal(
    query<{ count: number }>('SELECT COUNT(*) AS count FROM web_tool_models').one().count,
    1,
  );
});

test('terminal answer erases private payloads while retaining a digest for duplicate final callbacks', (t) => {
  const { journal, reader, write, begin, save, finish, query } = database(t),
    input = begin();
  save(input);
  finish(input.id, 'search-0');
  const runId = crypto.randomUUID();
  write((j) => j.queueModel(input.id, 1, runId, crypto.randomUUID(), config));
  write((j) => j.claimModel(runId));
  const final = turn([], '最终回答🙂', '可展示思考');
  assert.equal(
    write((j) => j.saveTurn(runId, final, config)),
    true,
  );
  assert.equal(
    write(() => reader().saveTurn(runId, structuredClone(final), config)),
    false,
  );
  assert.throws(() => write((j) => j.saveTurn(runId, turn([], '不同回答'), config)), /不同结果/);
  assert.equal(journal.state(input.id).status, 'completed');
  assert.equal(
    query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM web_tool_models WHERE turn IS NOT NULL',
    ).one().count,
    0,
  );
  assert.ok(
    reader()
      .model(runId)!
      .turnHash?.match(/^[a-f0-9]{64}$/),
  );
  assert.equal(
    write((j) => j.stop(input.id, 'cancelled')),
    false,
  );
  assert.throws(() => write((j) => j.claimModel(runId)), /已停止/);
  assert.equal(journal.publicCalls(input.runId)[0].state, 'completed');
});

test('tool tasks can exceed the former round and total request limits and complete normally', (t) => {
  const { journal, write, begin } = database(t),
    input = begin();
  let runId = input.runId;
  for (let round = 0; round < 10; round++) {
    write((j) => j.claimModel(runId));
    write((j) =>
      j.saveTurn(
        runId,
        turn([call(`${round}-a`), call(`${round}-b`)], '', `thinking ${round}`),
        config,
      ),
    );
    for (const id of [`${round}-a`, `${round}-b`]) {
      write((j) => j.claimTool(input.id, id));
      write((j) => j.finishTool(input.id, id, outcome(id)));
    }
    assert.equal(journal.exchanges(input.id, round + 1, config).length, round + 1);
    runId = crypto.randomUUID();
    write((j) => j.queueModel(input.id, round + 1, runId, crypto.randomUUID(), config));
  }
  write((j) => j.claimModel(runId));
  write((j) => j.saveTurn(runId, turn([], 'final answer'), config));
  const state = journal.state(input.id);
  assert.equal(state.status, 'completed');
  assert.equal(state.modelRequests, 11);
  assert.equal(state.toolRequests, 20);
  const task = {
    ...journal.publicTask(input.id),
    reasoningBreaks: Array.from({ length: 10 }, (_, round) => ({ round, reasoningEnd: round })),
  };
  assert.equal(v.is(publicToolTaskSchema, task), true);
  assert.equal(task.calls.length, 20);
});

test('aggregate text and thought limits apply across model rounds, not independently to each connection', (t) => {
  const { write, begin, save, finish, journal } = database(t),
    input = begin();
  save(input, turn([call()], 'x'.repeat(200_000), 'y'.repeat(200_000)));
  finish(input.id, 'search-0');
  const runId = crypto.randomUUID();
  write((j) => j.queueModel(input.id, 1, runId, crypto.randomUUID(), config));
  write((j) => j.claimModel(runId));
  for (const value of [
    turn([], 'x'.repeat(MAX_MESSAGE_TEXT_BYTES - 400_000 + 1)),
    turn([], 'answer', 'y'.repeat(MAX_MESSAGE_TEXT_BYTES - 400_000 + 1)),
  ])
    assert.throws(() => write((j) => j.saveTurn(runId, value, config)), /总量/);
  assert.equal(journal.state(input.id).phase, 'running');
  write((j) =>
    j.saveTurn(runId, turn([], 'x'.repeat(MAX_MESSAGE_TEXT_BYTES - 400_000), ''), config),
  );
  assert.equal(journal.state(input.id).status, 'completed');
});

test('cancellation is durable, keeps completed results, and ignores late model and tool callbacks', (t) => {
  const { query, reader, write, begin, save, finish } = database(t),
    input = begin();
  save(input, turn([call('one'), call('two')]));
  finish(input.id, 'one');
  write((j) => j.claimTool(input.id, 'two'));
  write((j) => j.stop(input.id, 'cancelled'));
  assert.equal(
    write(() => reader().finishTool(input.id, 'two', outcome('two'))),
    false,
  );
  assert.deepEqual(
    reader()
      .publicCalls(input.runId)
      .map((entry) => entry.state),
    ['completed', 'cancelled'],
  );
  assert.equal(
    query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM web_tool_models WHERE turn IS NOT NULL',
    ).one().count,
    0,
  );
  const next = begin();
  write((j) => j.claimModel(next.runId));
  write((j) => j.stop(next.id, 'cancelled'));
  assert.equal(
    write((j) => j.saveTurn(next.runId, turn([], 'late answer'), config)),
    false,
  );
  assert.equal(reader().state(next.id).status, 'cancelled');
});

test('expiry prevents both kinds of new claims and late outcomes without a retry loop', (t) => {
  const { journal, advance, write, begin, save } = database(t),
    input = begin();
  save(input);
  write((j) => j.claimTool(input.id, 'search-0'));
  advance(TOOL_TASK_TIMEOUT_MS);
  assert.equal(
    write((j) => j.finishTool(input.id, 'search-0', outcome())),
    false,
  );
  assert.throws(() => write((j) => j.claimTool(input.id, 'search-0')), /期限/);
  write((j) => j.expire());
  assert.equal(journal.state(input.id).status, 'failed');
  assert.match(journal.state(input.id).error!, /10 分钟/);
  assert.equal(journal.state(input.id).toolRequests, 1);
  assert.equal(
    write((j) => j.finishTool(input.id, 'search-0', outcome())),
    false,
  );
  advance(60_000);
  write((j) => j.expire());
  assert.equal(journal.nextAlarm(), null);
});

test('recovery fails an interrupted model without reissuing it and preserves queued work', (t) => {
  const { journal, reader, write, begin } = database(t),
    input = begin();
  write(() => reader().recover());
  assert.equal(journal.state(input.id).phase, 'queued');
  write((j) => j.claimModel(input.runId));
  write(() => reader().recover());
  assert.equal(journal.state(input.id).status, 'failed');
  assert.equal(journal.state(input.id).modelRequests, 1);
  assert.match(journal.state(input.id).error!, /主动重新生成/);
  assert.throws(() => write((j) => j.claimModel(input.runId)), /已停止/);
  write(() => reader().recover());
  assert.equal(journal.state(input.id).modelRequests, 1);
});

test('recovery converts an uncertain tool request into a saved failure, never a repeated fetch', (t) => {
  const { journal, reader, write, begin, save } = database(t),
    input = begin();
  save(input, turn([call('one'), call('two')]));
  write((j) => j.claimTool(input.id, 'one'));
  write(() => reader().recover());
  assert.equal(journal.state(input.id).status, 'active');
  assert.equal(journal.state(input.id).toolRequests, 1);
  assert.equal(journal.publicCalls(input.runId)[0].result?.status, 'failed');
  assert.equal(journal.publicCalls(input.runId)[1].state, 'queued');
  assert.equal(
    write((j) => j.claimTool(input.id, 'one')),
    false,
  );
  write((j) => j.claimTool(input.id, 'two'));
  write((j) => j.finishTool(input.id, 'two', outcome('two')));
  assert.equal(
    write((j) => j.queueModel(input.id, 1, crypto.randomUUID(), crypto.randomUUID(), config)),
    true,
  );
});

test('notifications are bounded wakeup hints with backoff; completed acknowledgements leave no periodic Alarm', (t) => {
  const { journal, advance, write, begin, save } = database(t),
    input = begin();
  assert.equal(journal.nextAlarm(), 1000 + TOOL_TASK_TIMEOUT_MS);
  save(input, turn([], 'done'));
  assert.deepEqual(
    journal.notifications().map(({ rootId, round }) => ({ rootId, round })),
    [{ rootId: input.id, round: 0 }],
  );
  for (const delay of [5000, 10_000, 20_000, 30_000, 30_000]) {
    write((j) => j.deferNotification(input.id, 0));
    assert.deepEqual(journal.notifications(), []);
    advance(delay);
    assert.equal(journal.notifications().length, 1);
  }
  write((j) => j.acknowledge(input.id, 0));
  assert.equal(journal.nextAlarm(), null);
});

test('caller transactions atomically compose task acceptance, next-step registration and public message writes', (t) => {
  const { query, write, begin, save, finish, journal } = database(t),
    input = start();
  query('CREATE TABLE public_messages (id TEXT PRIMARY KEY)');
  assert.throws(
    () =>
      write((j) => {
        j.create(input, config);
        query('INSERT INTO public_messages VALUES (?)', input.messageId);
        throw new Error('Injected failure');
      }),
    /Injected/,
  );
  assert.equal(
    query<{ count: number }>('SELECT COUNT(*) AS count FROM web_tool_tasks').one().count,
    0,
  );
  assert.equal(
    query<{ count: number }>('SELECT COUNT(*) AS count FROM public_messages').one().count,
    0,
  );
  begin(input);
  save(input);
  finish(input.id, 'search-0');
  const runId = crypto.randomUUID(),
    messageId = crypto.randomUUID();
  assert.throws(
    () =>
      write((j) => {
        j.queueModel(input.id, 1, runId, messageId, config);
        query('INSERT INTO public_messages VALUES (?)', messageId);
        throw new Error('Injected failure');
      }),
    /Injected/,
  );
  assert.equal(journal.state(input.id).round, 0);
  assert.equal(journal.state(input.id).phase, 'tools');
  assert.equal(journal.model(runId), undefined);
  write((j) => {
    j.queueModel(input.id, 1, runId, messageId, config);
    query('INSERT INTO public_messages VALUES (?)', messageId);
  });
  assert.equal(journal.state(input.id).round, 1);
  assert.equal(
    query<{ count: number }>('SELECT COUNT(*) AS count FROM public_messages').one().count,
    1,
  );
});

test('a model identifier collision cannot leave an orphan accepted task', (t) => {
  const { begin, write, journal, query } = database(t),
    first = begin();
  write((j) => j.stop(first.id, 'cancelled'));
  const second = start({ runId: first.runId });
  assert.throws(() => begin(second), /UNIQUE/);
  assert.throws(() => journal.state(second.id), /找不到/);
  assert.equal(
    query<{ count: number }>('SELECT COUNT(*) AS count FROM web_tool_tasks').one().count,
    1,
  );
});

test('large signed continuation stays in its own bounded row and is removed at termination', async (t) => {
  const { reader, write, begin, query } = database(t),
    settings = configuration('anthropic'),
    input = begin(start(), settings);
  const value = await collectProviderToolTurn(
    settings,
    enabled,
    fragmentedToolBody(
      toolStream('anthropic', { signature: Array(6).fill('s'.repeat(100_000)) }),
      16_384,
    ),
    new AbortController().signal,
  );
  write((j) => j.claimModel(input.runId));
  write((j) => j.saveTurn(input.runId, value, settings));
  assert.ok(reader().model(input.runId)!.turn!.length > 600_000);
  assert.ok(JSON.stringify(reader().state(input.id)).length < 1000);
  write((j) => j.stop(input.id, 'failed', ' interrupted\u0000 '));
  assert.equal(reader().model(input.runId)!.turn, null);
  assert.equal(reader().state(input.id).error, 'interrupted');
  assert.equal(
    query<{ count: number }>('SELECT COUNT(*) AS count FROM web_tool_notifications').one().count,
    1,
  );
});

test('per-conversation ledger capacity rejects new roots without removing idempotency evidence', (t) => {
  const { begin, write, journal } = database(t);
  let first!: StartToolTask;
  for (let index = 0; index < MAX_TOOL_TASKS; index++) {
    const input = begin();
    first ??= input;
    write((j) => j.stop(input.id, 'cancelled'));
  }
  assert.throws(() => begin(), /数量已达上限/);
  assert.equal(write((j) => j.create(first, config)).status, 'cancelled');
  assert.equal(journal.state(first.id).status, 'cancelled');
});
