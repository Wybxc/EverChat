import { MAX_SYSTEM_PROMPT_LENGTH } from '../../../shared/conversation/limits';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as v from 'valibot';
import { promptPresetInputSchema, promptPresetListSchema } from '../../../shared/presets/schema';
import { PromptPresetError, PromptPresets } from '../../../worker/presets/store';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(statement: string, ...bindings: (string | number | null)[]) {
      const rows = db.prepare(statement).all(...bindings);
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
    },
  };
  const storage = {
    sql,
    transactionSync<T>(operation: () => T): T {
      db.exec('BEGIN');
      try {
        const result = operation();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  return { db, sql, storage, presets: new PromptPresets(storage) };
}
const status = (expected: number) => (error: unknown) =>
  error instanceof PromptPresetError && error.status === expected;

test('presets persist across instances, trim only names, and make repeated saves idempotent', () => {
  const { db, storage, presets } = fixture();
  try {
    const id = crypto.randomUUID(),
      input = { name: '  写作助手  ', systemPrompt: ' 保留提示词空格\n**角色**🙂' };
    const saved = presets.save(id, input);
    assert.equal(saved.name, '写作助手');
    assert.equal(saved.systemPrompt, input.systemPrompt);
    assert.deepEqual(presets.save(id, input), saved);
    assert.deepEqual(new PromptPresets(storage).list(), [saved]);
    assert.equal(presets.save(id, { name: '关闭系统提示', systemPrompt: '' }).systemPrompt, '');
  } finally {
    db.close();
  }
});

test('deletion erases prompt text and prevents delayed saves, including a first save to an unknown ID', () => {
  const { db, sql, presets } = fixture();
  try {
    const id = crypto.randomUUID(),
      input = { name: '私密预设', systemPrompt: '应被清除的提示词' };
    presets.save(id, input);
    const removed = presets.remove(id);
    assert.deepEqual(presets.list(), []);
    assert.deepEqual(presets.remove(id), removed);
    assert.equal(
      sql.exec('SELECT name, systemPrompt FROM prompt_presets WHERE id = ?', id).one().systemPrompt,
      '',
    );
    assert.throws(() => presets.save(id, input), status(410));
    const unknown = crypto.randomUUID();
    presets.remove(unknown);
    assert.throws(() => presets.save(unknown, input), status(410));
  } finally {
    db.close();
  }
});

test('preset collections exceed old count and aggregate byte quotas while individual rows stay bounded', () => {
  const { db, presets } = fixture();
  try {
    for (let index = 0; index < 201; index++)
      presets.save(crypto.randomUUID(), { name: '预设', systemPrompt: '界'.repeat(1000) });
    assert.equal(presets.list().length, 201);
    const id = crypto.randomUUID();
    presets.save(id, { name: '长提示词', systemPrompt: '界'.repeat(64_001) });
    assert.equal(presets.list().at(-1)!.systemPrompt.length, 64_001);
    assert.throws(() => presets.save(id, { name: ' ', systemPrompt: '' }), status(400));
    assert.throws(
      () => presets.save(id, { name: 'x', systemPrompt: '界'.repeat(MAX_SYSTEM_PROMPT_LENGTH) }),
      status(400),
    );
    const restored = presets.prepareRestore([
      { id: crypto.randomUUID(), name: '导入', systemPrompt: 'ok', updatedAt: 1 },
    ]);
    presets.insertRestored(restored);
    assert.equal(presets.list().length, 203);
  } finally {
    db.close();
  }
});

test('backup merging preserves conflicting local and deleted IDs, deduplicates repeats and can commit atomically', () => {
  const { db, storage, presets } = fixture();
  try {
    const id = crypto.randomUUID();
    presets.save(id, { name: '本机版本', systemPrompt: 'LOCAL' });
    const imported = { id, name: '备份版本', systemPrompt: 'BACKUP', updatedAt: 1 };
    const added = presets.prepareRestore([imported]);
    assert.notEqual(added[0].id, id);
    assert.equal(presets.list().length, 1);
    assert.throws(
      () =>
        storage.transactionSync(() => {
          presets.insertRestored(added);
          throw new Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(presets.list().length, 1);
    storage.transactionSync(() => presets.insertRestored(added));
    assert.deepEqual(presets.prepareRestore([imported]), []);
    const deleted = crypto.randomUUID();
    presets.remove(deleted);
    const restored = presets.prepareRestore([{ ...imported, id: deleted, name: '已删 ID 的备份' }]);
    assert.notEqual(restored[0].id, deleted);
    assert.equal(presets.list().find((preset) => preset.id === id)!.systemPrompt, 'LOCAL');
  } finally {
    db.close();
  }
});

test('preset schemas reject leaked fields, invalid IDs, duplicate IDs and oversized individual rows', () => {
  const preset = { id: crypto.randomUUID(), name: '预设', systemPrompt: '', updatedAt: 1 };
  for (const input of [
    { name: '', systemPrompt: '' },
    { name: 'ok', systemPrompt: 'x'.repeat(MAX_SYSTEM_PROMPT_LENGTH + 1) },
    { name: 'ok', systemPrompt: '', apiKey: 'unexpected' },
  ])
    assert.equal(v.safeParse(promptPresetInputSchema, input).success, false);
  for (const input of [
    [preset, preset],
    [{ ...preset, id: 'bad' }],
    [{ ...preset, apiKey: 'secret' }],
    [{ ...preset, updatedAt: Infinity }],
  ])
    assert.equal(v.safeParse(promptPresetListSchema, input).success, false);
});
