import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { messageParts, messageText } from '../../../shared/conversation/content';
import {
  answerStages,
  canContinueAnswer,
  localAnswerText,
} from '../../../shared/conversation/continuation';
import { contextHistory } from '../../../shared/conversation/context-budget';
import { prepareChatContext } from '../../../shared/conversation/summaries';
import { DEFAULT_CONVERSATION_SETTINGS as settings } from '../../../shared/conversation/settings';
import type { Message } from '../../../shared/conversation/types';
import type { ProviderConfig } from '../../../shared/providers/types';
import { ConversationMessages } from '../../../worker/conversation/messages';
import { ConversationContent } from '../../../worker/conversation/content';
import { initializeConversation } from '../../../worker/conversation/schema';
import { planSubmissionParent } from '../../../worker/conversation/submission-plan';
import { GenerationCheckpoints } from '../../../worker/streaming/checkpoints';
import type { SqlQuery } from '../../../worker/generation/metrics';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupMessage,
  validateBackup,
} from '../../../shared/backup/backup';
import { discussionSource } from '../../../worker/mcp/discussion';
import { encodeRef } from '../../../worker/mcp/contracts';
import { projectShare } from '../../../shared/sharing/projection';
import { planConversationRestore } from '../../../worker/backup/restore-plan';
import { ProviderStream } from '../../../shared/streaming/provider-stream';
import { appendMessage } from '../../../shared/streaming/apply-change';
import { streamBatches } from '../../../shared/streaming/batches';
import { migrateStorage } from '../../../scripts/operations/migrations';
import { STORAGE_SCHEMA_VERSION } from '../../../worker/platform/storage-schema';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...args: SqlStorageValue[]
  ) => {
    const rows = db.prepare(sql).all(...(args as (string | number | null)[])) as T[];
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
  initializeConversation({ exec: query } as unknown as SqlStorage, false);
  const journal = new GenerationCheckpoints(query);
  const messages = new ConversationMessages(
    query,
    journal,
    () => null,
    () => {},
  );
  const add = (
    text: string,
    parentId: string | null = null,
    role: Message['role'] = 'assistant',
    reasoning = '',
  ): Message => {
    const message: Message = {
      id: crypto.randomUUID(),
      role,
      parts: messageParts(text, reasoning),
      status: 'completed',
      createdAt: 1,
      runId: null,
      parentId,
      revisionOf: null,
      error: null,
    };
    messages.insert(message);
    journal.compact(message);
    return message;
  };
  const append = (source: Message, text: string, reasoning = '') => {
    const next: Message = {
      ...source,
      id: crypto.randomUUID(),
      revisionOf: source.id,
      parts: messageParts(text, reasoning),
      continuation: {
        sourceId: source.id,
        sourceTextSha256: createHash('sha256').update(messageText(source)).digest('hex'),
        prefixTextLength: messageText(source).length,
        prefixReasoningLength: messageText(source, 'reasoning').length,
        stages: [],
      },
    };
    messages.insert(next);
    journal.compact(next);
    return messages.message(next.id)!;
  };
  return { db, query, journal, messages, add, append };
}

test('continuations share immutable prefixes and later context contains one composed answer', () => {
  const f = fixture();
  try {
    const question = f.add('问题', null, 'user'),
      source = f.add('```js\nconst x = ', question.id, 'assistant', '原思考');
    const first = f.append(source, '1;\n', '续写思考'),
      second = f.append(first, '```\n结论😀');
    assert.equal(messageText(second), '```js\nconst x = 1;\n```\n结论😀');
    assert.equal(messageText(f.messages.message(source.id)), messageText(source));
    assert.equal(messageText(f.messages.rawMessage(second.id)), '```\n结论😀');
    assert.equal(second.parentId, question.id);
    assert.equal(second.revisionOf, first.id);
    assert.deepEqual(
      contextHistory(f.messages.forHead(second.id), second.id).map(({ role, content }) => ({
        role,
        content,
      })),
      [
        { role: 'user', content: '问题' },
        { role: 'assistant', content: messageText(second) },
      ],
    );
    assert.deepEqual(
      answerStages(second).map((stage) => messageText(stage)),
      [messageText(source), '1;\n', '```\n结论😀'],
    );
    assert.deepEqual(
      answerStages(second).map((stage) => messageText(stage, 'reasoning')),
      ['原思考', '续写思考', ''],
    );
    const bytes = f.db
      .prepare('SELECT SUM(LENGTH(payload)) AS bytes FROM message_content_chunks')
      .get()!.bytes as number;
    assert.ok(
      bytes <
        messageText(source).length + messageText(first).length + messageText(second).length + 30,
    );
  } finally {
    f.db.close();
  }
});

test('logical pagination crosses prefix boundaries without splitting Unicode or returning duplicate text', () => {
  const f = fixture();
  try {
    const source = f.add('甲😀乙', null, 'assistant', '思考一'),
      next = f.append(source, '\n丙😀丁', '思考二');
    const content = new ConversationContent(f.query);
    for (const channel of ['content', 'reasoning'] as const)
      for (const limit of [2, 3, 7]) {
        let text = '',
          offset = 0;
        for (;;) {
          const page = content.page(next.id, channel, offset, limit);
          assert.ok(!page.error);
          assert.equal(page.nextOffset, offset + page.text!.length);
          assert.ok(!/^[\uDC00-\uDFFF]/.test(page.text!));
          text += page.text;
          offset = page.nextOffset!;
          if (!page.hasMore) break;
          assert.ok(page.text!.length > 0);
        }
        assert.equal(text, messageText(next, channel === 'content' ? 'text' : 'reasoning'));
      }
  } finally {
    f.db.close();
  }
});

test('deleted sources become tombstones without destroying inherited text, then release unreferenced chunks', () => {
  const f = fixture();
  try {
    const source = f.add('原正文'),
      next = f.append(source, '新增');
    f.query('INSERT INTO message_deletions VALUES (?, ?)', source.id, 2);
    f.messages.pruneDeletedSources();
    assert.equal(messageText(f.messages.message(source.id)), '');
    assert.equal(messageText(f.messages.message(next.id)), '原正文新增');
    assert.equal(f.messages.retainSource(source.id), true);
    f.query('INSERT INTO message_deletions VALUES (?, ?)', next.id, 3);
    f.messages.pruneDeletedSources();
    assert.equal(
      f.query<{ count: number }>('SELECT COUNT(*) AS count FROM message_content_chunks').one()
        .count,
      0,
    );
    assert.equal(
      f.query<{ count: number }>('SELECT COUNT(*) AS count FROM message_continuations').one().count,
      0,
    );
  } finally {
    f.db.close();
  }
});

test('portable copies retain complete text and execution provenance after the source is gone', () => {
  const f = fixture(),
    target = fixture();
  try {
    const question = f.add('问题', null, 'user'),
      source = f.add('前缀', question.id),
      next = f.append(source, '续写');
    const backup = {
      id: crypto.randomUUID(),
      title: 'copy',
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
      messages: [backupMessage(question), backupMessage(next)],
    };
    const plan = planConversationRestore(backup);
    assert.ok(!('error' in plan));
    for (const message of plan.messages) target.messages.insert(message);
    const copied = target.messages.message(plan.messages[1].id)!;
    assert.equal(messageText(copied), '前缀续写');
    assert.equal(copied.continuation?.stages.length, 1);
    const another = target.append(copied, '再次');
    assert.equal(messageText(another), '前缀续写再次');
    assert.equal(another.continuation?.stages.length, 2);
  } finally {
    f.db.close();
    target.db.close();
  }
});

test('required source and question cannot be silently omitted by the continuation context budget', () => {
  const f = fixture();
  try {
    const question = f.add('原问题', null, 'user'),
      source = f.add('长回答'.repeat(100), question.id);
    const config: ProviderConfig = {
      provider: 'openai-chat',
      baseUrl: 'https://test.invalid',
      model: 'unknown',
      systemPrompt: '',
      maxOutputTokens: null,
    };
    const tail = [
      {
        role: 'user' as const,
        content: messageText(question),
        source: { kind: 'message' as const, messageId: question.id },
      },
      {
        role: 'assistant' as const,
        content: messageText(source),
        source: { kind: 'message' as const, messageId: source.id },
      },
    ];
    const build = (budget: number | null) =>
      prepareChatContext(
        f.messages.all(),
        null,
        '继续',
        config,
        { ...settings, contextBudget: budget, recentMessages: 1 },
        [],
        [],
        { kind: 'generated' },
        tail,
      );
    assert.deepEqual(
      build(null).messages.map(({ role, content }) => ({ role, content })),
      [...tail.map(({ role, content }) => ({ role, content })), { role: 'user', content: '继续' }],
    );
    assert.throws(() => build(10), /超过上下文预算/);
  } finally {
    f.db.close();
  }
});

test('automatic compression only covers earlier turns and preserves the complete continuation tail after summary', () => {
  const f = fixture();
  try {
    const oldQuestion = f.add('旧问题', null, 'user'),
      oldAnswer = f.add('较早资料'.repeat(300), oldQuestion.id);
    const recentQuestion = f.add('近期问题', oldAnswer.id, 'user'),
      recentAnswer = f.add('近期回答', recentQuestion.id);
    const question = f.add('需要续写的问题', recentAnswer.id, 'user'),
      source = f.add('必须完整保留的正文'.repeat(10), question.id);
    const config: ProviderConfig = {
      provider: 'openai-chat',
      baseUrl: 'https://test.invalid',
      model: 'unknown',
      systemPrompt: '',
      maxOutputTokens: null,
    };
    const tail = [
      {
        role: 'user' as const,
        content: messageText(question),
        source: { kind: 'message' as const, messageId: question.id },
      },
      {
        role: 'assistant' as const,
        content: messageText(source),
        source: { kind: 'message' as const, messageId: source.id },
      },
    ];
    const prepared = prepareChatContext(
      f.messages.forHead(source.id),
      recentAnswer.id,
      '继续',
      config,
      {
        ...settings,
        contextBudget: 500,
        autoCompression: { ...settings.autoCompression, enabled: true, threshold: 60 },
      },
      [],
      [],
      { kind: 'generated' },
      tail,
    );
    assert.equal(prepared.automatic?.throughId, oldAnswer.id);
    const summary = f.add('较早资料摘要', oldAnswer.id);
    f.query(
      'INSERT INTO message_summaries VALUES (?,?)',
      summary.id,
      JSON.stringify({ throughId: oldAnswer.id, sourceIds: [oldQuestion.id, oldAnswer.id] }),
    );
    const after = prepareChatContext(
      f.messages.forHead(source.id),
      recentAnswer.id,
      '继续',
      config,
      { ...settings, contextBudget: 500 },
      [],
      [],
      { kind: 'generated' },
      tail,
    );
    assert.deepEqual(
      after.messages.slice(-3).map(({ role, content }) => ({ role, content })),
      [...tail.map(({ role, content }) => ({ role, content })), { role: 'user', content: '继续' }],
    );
    assert.equal(after.estimate.retainedMessages, 4);
    assert.ok(!after.selection.summarized.includes(source.id));
  } finally {
    f.db.close();
  }
});

test('continuation admission rejects conflicting actions and answers with no new text', () => {
  const f = fixture();
  try {
    const question = f.add('问题', null, 'user'),
      source = f.add('原正文', question.id),
      empty = f.append(source, '');
    assert.equal(canContinueAnswer(empty), false);
    assert.equal(localAnswerText(empty), '');
    assert.ok(
      'error' in
        planSubmissionParent(f.messages.all(), {
          requestId: crypto.randomUUID(),
          continueOf: source.id,
          content: '不应发送',
        }),
    );
    assert.ok(
      !(
        'error' in
        planSubmissionParent(f.messages.all(), {
          requestId: crypto.randomUUID(),
          continueOf: source.id,
        })
      ),
    );
    assert.ok(
      'error' in
        planSubmissionParent(f.messages.all(), {
          requestId: crypto.randomUUID(),
          continueOf: empty.id,
        }),
    );
  } finally {
    f.db.close();
  }
});

test('live stream parsing appends only new channels and resumes with local stream offsets', () => {
  const f = fixture();
  try {
    const source = f.add('代码```\n', null, 'assistant', '之前的思考');
    const combined = f.append(source, '');
    let view: Message = {
      ...combined,
      status: 'running',
      runId: 'run',
      streamVersion: 'events-v1',
      streamState: new ProviderStream('openai-chat', true).checkpoint(),
      durableOffset: 0,
    };
    const raw = new TextEncoder().encode(
      JSON.stringify({ type: 'reasoning', text: '新的思考' }) +
        '\n' +
        JSON.stringify({ type: 'text', text: '尾部😀' }) +
        '\n',
    );
    for (const batch of streamBatches('run', combined.id, 0, 0, raw))
      view = appendMessage(view, batch);
    assert.equal(messageText(view), '代码```\n尾部😀');
    assert.equal(messageText(view, 'reasoning'), '之前的思考新的思考');
    assert.equal(localAnswerText(view), '尾部😀');
    assert.equal(view.durableOffset, raw.byteLength);
    assert.deepEqual(
      answerStages(view).map((stage) => messageText(stage, 'reasoning')),
      ['之前的思考', '新的思考'],
    );
  } finally {
    f.db.close();
  }
});

test('version four databases require offline conversion, preserving bodies and creating only empty continuation metadata', async () => {
  const f = fixture();
  try {
    const source = f.add('既有正文');
    f.db.exec('DROP TABLE message_continuations; UPDATE storage_schema SET version=4');
    assert.throws(
      () => initializeConversation({ exec: f.query } as unknown as SqlStorage, false),
      /本地运维迁移/,
    );
    assert.equal(
      f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_continuations'").get(),
      undefined,
    );
    await migrateStorage(f.db, 'conversation');
    assert.equal(
      f.db.prepare('SELECT version FROM storage_schema').get()!.version,
      STORAGE_SCHEMA_VERSION,
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM message_continuations').get()!.count,
      0,
    );
    assert.equal(messageText(f.messages.message(source.id)), '既有正文');
  } finally {
    f.db.close();
  }
});

test('portable stage tools use local reasoning coordinates and retain explicitly cancelled partial output', () => {
  const f = fixture();
  try {
    const question = f.add('问题', null, 'user'),
      source = f.add('前缀', question.id, 'assistant', '思考😀');
    const tools = {
      status: 'completed' as const,
      round: 0,
      calls: [
        {
          round: 0,
          call: { id: 'same-id', name: 'web_search' as const, input: { query: 'test' } },
          state: 'completed' as const,
          result: {
            id: 'same-id',
            name: 'web_search' as const,
            status: 'completed' as const,
            sources: [],
          },
        },
      ],
      reasoningBreaks: [{ round: 0, reasoningEnd: 4 }],
    };
    f.query(
      'INSERT INTO message_web_tools VALUES (?,?,?,?,?)',
      source.id,
      'root',
      '[]',
      '',
      JSON.stringify(tools),
    );
    const next = f.append(f.messages.message(source.id)!, '增量', '新思考');
    const portable = backupMessage({
      ...next,
      tools: {
        ...tools,
        status: 'cancelled',
        calls: tools.calls.map(({ result: _, ...call }) => ({ ...call, state: 'cancelled' })),
        reasoningBreaks: [{ round: 0, reasoningEnd: 3 }],
      },
      generation: {
        interrupted: true,
        interruptionReason: 'cancelled',
        usage: {},
        usageIsFinal: false,
      },
    });
    const backup = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: 1,
      conversation: {
        id: crypto.randomUUID(),
        title: '备份',
        createdAt: 1,
        updatedAt: 1,
        messages: [backupMessage(question), portable],
      },
      settings: {
        providers: [],
        activeProviderId: null,
        activeModel: '',
        systemPrompt: '',
        maxOutputTokens: null,
        promptPresets: [],
      },
    };
    assert.equal(messageText(validateBackup(backup).conversation.messages[1]), '前缀增量');
    // 3 splits the source's surrogate pair; 5 exceeds its stage even though it fits the composed reasoning.
    for (const end of [3, 5]) {
      const invalid = structuredClone(backup);
      invalid.conversation.messages[1].continuation!.stages[0].tools!.reasoningBreaks![0].reasoningEnd =
        end;
      assert.throws(() => validateBackup(invalid), /续写工具过程无效/);
    }
  } finally {
    f.db.close();
  }
});

test('explicit MCP review and public sharing resolve the same full answer after source deletion', () => {
  const f = fixture();
  try {
    const question = f.add('问题', null, 'user'),
      source = f.add('前缀', question.id),
      next = f.append(source, '续写😀');
    f.query('INSERT INTO message_deletions VALUES (?,?)', source.id, 2);
    f.query('INSERT INTO message_versions VALUES (?,?)', next.id, 3);
    const citation = {
      messageRef: encodeRef('message1', [crypto.randomUUID(), next.id]),
      revision: 3,
      sha256: createHash('sha256').update(messageText(next)).digest('hex'),
    };
    assert.equal(discussionSource(f.query, next.id, citation, true).text, '前缀续写😀');
    const blocks = [...projectShare(f.messages.forHead(next.id), next.id).blocks()];
    assert.equal(
      blocks
        .filter((block) => block.role === 'assistant' && block.channel === 'text')
        .map((block) => block.text)
        .join(''),
      '前缀续写😀',
    );
  } finally {
    f.db.close();
  }
});

test('long repeated continuations store each delta once and resolve bounded pages with a batched ancestry query', () => {
  const f = fixture();
  try {
    const segment = '甲😀\n'.repeat(8192);
    let answer = f.add(segment);
    for (let i = 0; i < 12; i++) answer = f.append(answer, segment);
    const stored = f
      .query<{ bytes: number }>(
        'SELECT SUM(length(CAST(payload AS BLOB))) AS bytes FROM message_content_chunks',
      )
      .one().bytes;
    const segmentBytes = Buffer.byteLength(JSON.stringify(segment));
    assert.ok(stored < 13 * (segmentBytes + 100));
    let queries = 0;
    const content = new ConversationContent((sql, ...args) => {
      queries++;
      return f.query(sql, ...args);
    });
    const page = content.page(answer.id, 'content', segment.length * 11 + 3, 128);
    assert.ok(!page.error);
    assert.equal(page.text, messageText(answer).slice(segment.length * 11 + 3, page.nextOffset));
    assert.ok(
      queries <= 4,
      'One ancestry query and bounded journal reads, independent of stage count',
    );
  } finally {
    f.db.close();
  }
});
