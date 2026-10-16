import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { PromptPresets, PromptPresetError } from '../worker/prompt-presets';
import { MAX_PROMPT_PRESETS, promptPresetInputSchema, promptPresetListSchema } from '../shared/presets/schema';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(statement: string, ...bindings: (string | number | null)[]) {
    const rows = db.prepare(statement).all(...bindings);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, *[Symbol.iterator]() { yield* rows; } };
  } };
  const storage = { sql, transactionSync<T>(operation: () => T): T {
    db.exec('BEGIN'); try { const result = operation(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  } } as unknown as DurableObjectStorage;
  return { db, sql, storage, presets: new PromptPresets(storage) };
}
const status = (expected: number) => (error: unknown) => error instanceof PromptPresetError && error.status === expected;

test('presets persist across instances, trim only names, and make repeated saves idempotent', () => {
  const { db, storage, presets } = fixture();
  try {
    const id = crypto.randomUUID(), input = { name: '  写作助手  ', systemPrompt: ' 保留提示词空格\n**角色**🙂' };
    const saved = presets.save(id, input);
    assert.equal(saved.name, '写作助手'); assert.equal(saved.systemPrompt, input.systemPrompt);
    assert.deepEqual(presets.save(id, input), saved);
    assert.deepEqual(new PromptPresets(storage).list(), [saved]);
    assert.equal(presets.save(id, { name: '关闭系统提示', systemPrompt: '' }).systemPrompt, '');
  } finally { db.close(); }
});

test('deletion erases prompt text and prevents delayed saves, including a first save to an unknown ID', () => {
  const { db, sql, presets } = fixture();
  try {
    const id = crypto.randomUUID(), input = { name: '私密预设', systemPrompt: '应被清除的提示词' };
    presets.save(id, input); const removed = presets.remove(id);
    assert.deepEqual(presets.list(), []); assert.deepEqual(presets.remove(id), removed);
    assert.equal(sql.exec('SELECT name, systemPrompt FROM prompt_presets WHERE id = ?', id).one().systemPrompt, '');
    assert.throws(() => presets.save(id, input), status(410));
    const unknown = crypto.randomUUID(); presets.remove(unknown);
    assert.throws(() => presets.save(unknown, input), status(410));
  } finally { db.close(); }
});

test('preset count and actual UTF-8 text capacity are bounded without preventing edits or atomic failures', () => {
  const count = fixture();
  try {
    const ids = Array.from({ length: MAX_PROMPT_PRESETS }, () => crypto.randomUUID());
    for (const id of ids) count.presets.save(id, { name: '预设', systemPrompt: '' });
    assert.throws(() => count.presets.save(crypto.randomUUID(), { name: '超限', systemPrompt: '' }), status(507));
    count.presets.save(ids[0], { name: '修改', systemPrompt: '可以修改' });
    count.presets.remove(ids[1]); count.presets.save(crypto.randomUUID(), { name: '替代', systemPrompt: '' });
    assert.equal(count.presets.list().length, MAX_PROMPT_PRESETS);
  } finally { count.db.close(); }
  const bytes = fixture();
  try {
    for (let index = 0; index < 8; index++) bytes.presets.save(crypto.randomUUID(), { name: 'x', systemPrompt: '界'.repeat(20000) });
    const id = crypto.randomUUID(); bytes.presets.save(id, { name: 'x', systemPrompt: '界'.repeat(14000) });
    assert.throws(() => bytes.presets.save(id, { name: 'x', systemPrompt: '界'.repeat(15000) }), status(507));
    assert.throws(() => bytes.presets.prepareRestore([{ id: crypto.randomUUID(), name: '导入超限', systemPrompt: '界'.repeat(1000), updatedAt: 1 }]), status(507));
    assert.equal(bytes.presets.list().at(-1)!.systemPrompt.length, 14000);
    assert.throws(() => bytes.presets.save(id, { name: ' ', systemPrompt: '' }), status(400));
  } finally { bytes.db.close(); }
});

test('backup merging preserves conflicting local and deleted IDs, deduplicates repeats and can commit atomically', () => {
  const { db, storage, presets } = fixture();
  try {
    const id = crypto.randomUUID(); presets.save(id, { name: '本机版本', systemPrompt: 'LOCAL' });
    const imported = { id, name: '备份版本', systemPrompt: 'BACKUP', updatedAt: 1 };
    const added = presets.prepareRestore([imported]);
    assert.notEqual(added[0].id, id); assert.equal(presets.list().length, 1);
    assert.throws(() => storage.transactionSync(() => { presets.insertRestored(added); throw new Error('rollback'); }), /rollback/);
    assert.equal(presets.list().length, 1);
    storage.transactionSync(() => presets.insertRestored(added));
    assert.deepEqual(presets.prepareRestore([imported]), []);
    const deleted = crypto.randomUUID(); presets.remove(deleted);
    const restored = presets.prepareRestore([{ ...imported, id: deleted, name: '已删 ID 的备份' }]);
    assert.notEqual(restored[0].id, deleted);
    assert.equal(presets.list().find((preset) => preset.id === id)!.systemPrompt, 'LOCAL');
  } finally { db.close(); }
});

test('preset schemas reject leaked fields, invalid IDs, duplicate IDs and oversized backup collections', () => {
  const preset = { id: crypto.randomUUID(), name: '预设', systemPrompt: '', updatedAt: 1 };
  for (const input of [{ name: '', systemPrompt: '' }, { name: 'ok', systemPrompt: 'x'.repeat(20001) }, { name: 'ok', systemPrompt: '', apiKey: 'unexpected' }]) assert.equal(v.safeParse(promptPresetInputSchema, input).success, false);
  for (const input of [[preset, preset], [{ ...preset, id: 'bad' }], [{ ...preset, apiKey: 'secret' }], [{ ...preset, updatedAt: Infinity }], Array.from({ length: MAX_PROMPT_PRESETS + 1 }, () => ({ ...preset, id: crypto.randomUUID() }))]) assert.equal(v.safeParse(promptPresetListSchema, input).success, false);
});
