import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { UsageRecord, UsageTotals } from '../../shared/usage/types';
import { addRecord, emptyTotals } from '../../worker/usage/aggregate';
import type { Statement } from './storage-protocol';

// Offline only: no historical repair or deletion is performed by the application.
export function cleanIncompleteUsage(db: DatabaseSync) {
  const statements: Statement[] = [];
  const counts = { before: 0, removed: 0, retained: 0, correctionsRemoved: 0 };
  const write = (sql: string, args: (string | number)[] = []) => {
    db.prepare(sql).run(...args);
    statements.push({ sql, args });
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(db.prepare('SELECT version FROM storage_schema WHERE id=1').get()?.version, 1);
    const groups = new Map<string, { record: UsageRecord; hour: number; totals: UsageTotals }>();
    for (const row of db.prepare('SELECT id,payload FROM usage_attempts ORDER BY id').all()) {
      const record = JSON.parse(String(row.payload)) as UsageRecord & { correction?: unknown };
      assert.equal(record.id, row.id, 'Usage identity mismatch');
      counts.before++;
      if (
        record.status !== 'running' &&
        (!record.usageIsFinal ||
          record.cost.state !== 'priced' ||
          !record.price ||
          record.cost.amount === null)
      ) {
        write('DELETE FROM usage_attempts WHERE id=?', [record.id]);
        counts.removed++;
        continue;
      }
      counts.retained++;
      if (record.correction !== undefined) {
        delete record.correction;
        write('UPDATE usage_attempts SET payload=? WHERE id=?', [
          JSON.stringify(record),
          record.id,
        ]);
        counts.correctionsRemoved++;
      }
      const hour = Math.floor(record.startedAt / 3_600_000) * 3_600_000;
      const key = JSON.stringify([
        hour,
        record.providerId,
        record.model,
        record.kind,
        record.status,
      ]);
      let group = groups.get(key);
      if (!group) {
        group = { record, hour, totals: emptyTotals() };
        groups.set(key, group);
      }
      addRecord(group.totals, record);
    }
    write('DELETE FROM usage_rollups');
    for (const [key, { record, hour, totals }] of groups)
      write('INSERT INTO usage_rollups VALUES (?,?,?,?,?,?,?)', [
        key,
        hour,
        record.providerId,
        record.model,
        record.kind,
        record.status,
        JSON.stringify({ totals, providerName: record.providerName, modelName: record.modelName }),
      ]);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    db.exec('COMMIT');
    return { statements, counts };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
