import * as v from 'valibot';
import type { PromptPreset, PromptPresetInput } from '../../shared/presets/types';
import { MAX_PRESET_TEXT_BYTES, MAX_PROMPT_PRESETS, PRESET_CAPACITY_MESSAGE, presetTextBytes, promptPresetInputSchema, promptPresetListSchema } from '../../shared/presets/schema';

type Row = PromptPreset & { deletedAt: number | null } & Record<string, SqlStorageValue>;
export class PromptPresetError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export class PromptPresets {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS prompt_presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, systemPrompt TEXT NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER
    )`);
  }
  list(): PromptPreset[] {
    return this.storage.sql.exec<Row>('SELECT * FROM prompt_presets WHERE deletedAt IS NULL ORDER BY rowid').toArray()
      .map(({ deletedAt: _deleted, ...preset }) => preset);
  }
  save(id: string, input: PromptPresetInput): PromptPreset {
    const parsed = v.safeParse(promptPresetInputSchema, input);
    if (!parsed.success) throw new PromptPresetError(400, '预设名称为 1–100 字，系统提示词最多 20,000 字。');
    return this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<Row>('SELECT * FROM prompt_presets WHERE id = ?', id).toArray()[0];
      if (previous && previous.deletedAt !== null) throw new PromptPresetError(410, '这个预设已删除，请另存为新预设。');
      if (previous && previous.name === parsed.output.name && previous.systemPrompt === parsed.output.systemPrompt) {
        const { deletedAt: _deleted, ...preset } = previous; return preset;
      }
      const totals = this.storage.sql.exec<{ count: number; bytes: number }>(`SELECT COUNT(*) AS count,
        COALESCE(SUM(LENGTH(CAST(name AS BLOB)) + LENGTH(CAST(systemPrompt AS BLOB))), 0) AS bytes FROM prompt_presets WHERE deletedAt IS NULL`).one();
      if (totals.count + Number(!previous) > MAX_PROMPT_PRESETS || totals.bytes - (previous ? presetTextBytes(previous) : 0) + presetTextBytes(parsed.output) > MAX_PRESET_TEXT_BYTES) throw new PromptPresetError(507, PRESET_CAPACITY_MESSAGE);
      const preset = { id, ...parsed.output, updatedAt: Date.now() };
      this.storage.sql.exec(`INSERT INTO prompt_presets VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, systemPrompt = excluded.systemPrompt, updatedAt = excluded.updatedAt`, id, preset.name, preset.systemPrompt, preset.updatedAt);
      return preset;
    });
  }
  remove(id: string): { deletedAt: number } {
    return this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<Row>('SELECT * FROM prompt_presets WHERE id = ?', id).toArray()[0];
      if (previous && previous.deletedAt !== null) return { deletedAt: previous.deletedAt };
      const deletedAt = Date.now();
      // Even an unknown ID is tombstoned: a delayed first autosave cannot recreate it.
      this.storage.sql.exec(`INSERT INTO prompt_presets VALUES (?, '', '', ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = '', systemPrompt = '', updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt`, id, deletedAt, deletedAt);
      return { deletedAt };
    });
  }
  prepareRestore(imported: PromptPreset[]): PromptPreset[] {
    const parsed = v.safeParse(promptPresetListSchema, imported);
    if (!parsed.success) throw new PromptPresetError(400, '备份中的提示词预设无效。');
    const current = this.list(), merged = [...current], added: PromptPreset[] = [];
    const ids = new Set(current.map(({ id }) => id));
    for (const source of parsed.output) {
      if (merged.some((preset) => preset.name === source.name && preset.systemPrompt === source.systemPrompt)) continue;
      const reserved = ids.has(source.id) || this.storage.sql.exec('SELECT id FROM prompt_presets WHERE id = ?', source.id).toArray().length;
      const preset = { ...source, id: reserved ? crypto.randomUUID() : source.id, updatedAt: Date.now() };
      ids.add(preset.id); merged.push(preset); added.push(preset);
    }
    if (!v.safeParse(promptPresetListSchema, merged).success) throw new PromptPresetError(507, PRESET_CAPACITY_MESSAGE);
    return added;
  }
  insertRestored(presets: PromptPreset[]) {
    for (const preset of presets) this.storage.sql.exec('INSERT INTO prompt_presets VALUES (?, ?, ?, ?, NULL)', preset.id, preset.name, preset.systemPrompt, preset.updatedAt);
  }
}
