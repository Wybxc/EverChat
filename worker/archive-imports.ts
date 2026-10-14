import { MAX_BACKUP_BYTES } from '../shared/backup';
import { MAX_DAILY_ATTACHMENT_UPLOADS } from '../shared/attachments';
import { sha256, validateArchiveManifest, type ArchiveFile, type ArchiveManifest } from '../shared/archive';
import { HttpError, readJsonStream } from './http';

export const IMPORT_LEASE = 10 * 60_000;
type Row = { id: string; key: string; sha256: string; bytes: number; status: string; lease: number; createdAt: number;
  removed: number; cleanupAt: number; error: string | null; errorStatus: number | null } & Record<string, SqlStorageValue>;
type FileRow = { sourceId: string; id: string; payload: string } & Record<string, SqlStorageValue>;
export type ImportResult = { id: string; status: string; files: { sourceId: string; id: string }[] } | { error: string; status: number };

export async function readArchiveManifest(body: ReadableStream<Uint8Array>) {
  try {
    return validateArchiveManifest(await readJsonStream(body, MAX_BACKUP_BYTES, '备份清单超过 12 MiB。'));
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : '备份清单无效。');
  }
}

/** Metadata journal; only private R2 holds the bounded manifest. */
export class ArchiveImports {
  readonly active = new Map<string, Promise<ImportResult>>();
  constructor(private storage: DurableObjectStorage, private bucket: R2Bucket | undefined) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS archive_imports (id TEXT PRIMARY KEY, key TEXT NOT NULL, sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL, status TEXT NOT NULL, lease INTEGER NOT NULL, createdAt INTEGER NOT NULL, removed INTEGER NOT NULL,
      cleanupAt INTEGER NOT NULL, error TEXT, errorStatus INTEGER)`);
    storage.sql.exec('CREATE INDEX IF NOT EXISTS archive_imports_status ON archive_imports(status, lease)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS archive_import_files (jobId TEXT NOT NULL, sourceId TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(jobId, sourceId))');
  }
  get(id: string) { return this.storage.sql.exec<Row>('SELECT * FROM archive_imports WHERE id = ?', id).toArray()[0]; }
  files(id: string) { return this.storage.sql.exec<FileRow>('SELECT sourceId, id, payload FROM archive_import_files WHERE jobId = ? ORDER BY sourceId', id).toArray().map((row) => ({ ...row, file: JSON.parse(row.payload) as ArchiveFile })); }
  result(id: string): ImportResult {
    const row = this.get(id);
    if (!row) return { error: '找不到这项恢复。', status: 404 };
    return row.status === 'failed' ? { error: row.error ?? '恢复已停止。', status: row.errorStatus ?? 409 }
      : { id, status: row.status, files: this.files(id).map(({ sourceId, id }) => ({ sourceId, id })) };
  }
  begin(id: string, hash: string, size: number, files: ArchiveFile[]) {
    if (files.length && !this.bucket) throw new HttpError(503, '含附件的恢复需要配置私有 R2 存储。');
    const expired = this.storage.sql.exec<Row>("SELECT * FROM archive_imports WHERE status IN ('completed', 'failed') AND removed = 1 AND createdAt < ?", Date.now() - 7 * 86400_000).toArray();
    for (const row of expired) { this.storage.sql.exec('DELETE FROM archive_import_files WHERE jobId = ?', row.id); this.storage.sql.exec('DELETE FROM archive_imports WHERE id = ?', row.id); }
    const occupancy = files.length ? "removed = 0 OR status NOT IN ('completed', 'failed')" : "status NOT IN ('completed', 'failed')";
    if (this.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM archive_imports WHERE ${occupancy}`).one().count >= 2) throw new HttpError(429, '同时最多恢复 2 个存档，请等待恢复或清理完成。');
    if (this.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM archive_imports').one().count >= 1000) throw new HttpError(429, '近期恢复次数已达上限。');
    const date = new Date().toISOString().slice(0, 10);
    const count = this.storage.sql.exec<{ count: number }>('SELECT count FROM attachment_daily_uploads WHERE date = ?', date).toArray()[0]?.count ?? 0;
    if (files.length) {
      if (count + files.length + 1 > MAX_DAILY_ATTACHMENT_UPLOADS) throw new HttpError(429, '今日剩余附件写入次数不足以恢复此存档，请明天重试。');
      this.storage.sql.exec('DELETE FROM attachment_daily_uploads WHERE date < ?', date);
      this.storage.sql.exec('INSERT INTO attachment_daily_uploads VALUES (?, 1) ON CONFLICT(date) DO UPDATE SET count = count + 1', date);
    }
    const now = Date.now();
    this.storage.sql.exec("INSERT INTO archive_imports VALUES (?, ?, ?, ?, 'preparing', ?, ?, ?, ?, NULL, NULL)", id, `imports/${id}/${crypto.randomUUID()}/manifest.json`, hash, size, now + IMPORT_LEASE, now, Number(!files.length), now + IMPORT_LEASE);
    for (const file of files) this.storage.sql.exec('INSERT INTO archive_import_files VALUES (?, ?, ?, ?)', id, file.id, crypto.randomUUID(), JSON.stringify(file));
  }
  prepareEmpty(id: string) { this.require(id, 'preparing'); this.storage.sql.exec("UPDATE archive_imports SET status = 'uploading' WHERE id = ?", id); }
  require(id: string, status?: string) {
    const row = this.get(id);
    if (!row || row.status === 'failed' || status && row.status !== status) throw new HttpError(row?.errorStatus ?? 409, row?.error ?? '恢复已停止或处于另一阶段。');
    if (row.status !== 'completed' && row.lease <= Date.now()) throw new HttpError(408, '恢复超过等待期限，请重新导入。');
    return row;
  }
  async save(id: string, bytes: Uint8Array) {
    const row = this.require(id, 'preparing'); await this.storage.sync();
    const saved = await this.bucket!.put(row.key, bytes, { sha256: row.sha256, storageClass: 'Standard', httpMetadata: { contentType: 'application/json' } });
    this.require(id, 'preparing');
    if (!saved || saved.size !== row.bytes) throw new HttpError(503, '恢复清单未完整保存。');
    this.storage.sql.exec("UPDATE archive_imports SET status = 'uploading', cleanupAt = 0 WHERE id = ?", id);
    await this.storage.sync();
  }
  async manifest(id: string): Promise<ArchiveManifest> {
    const row = this.require(id), object = await this.bucket!.get(row.key);
    if (!object) throw new HttpError(409, '恢复清单不存在。');
    if (object.size !== row.bytes) { await object.body.cancel(); throw new HttpError(409, '恢复清单大小不符。'); }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (await sha256(bytes) !== row.sha256) throw new HttpError(409, '恢复清单校验失败。');
    this.require(id);
    return readArchiveManifest(new Response(bytes).body!);
  }
  finalize(id: string) { this.require(id, 'uploading'); this.storage.sql.exec("UPDATE archive_imports SET status = 'finalizing', lease = ? WHERE id = ?", Date.now() + IMPORT_LEASE, id); }
  complete(id: string) { this.require(id, 'finalizing'); this.storage.sql.exec("UPDATE archive_imports SET status = 'completed', lease = 0, cleanupAt = ? WHERE id = ?", Date.now() + 1000, id); }
  fail(id: string, error: HttpError) {
    const row = this.get(id); if (!row || ['completed', 'failed'].includes(row.status)) return;
    this.storage.sql.exec("UPDATE archive_imports SET status = 'failed', error = ?, errorStatus = ?, cleanupAt = ?, lease = 0 WHERE id = ?", error.message, error.status, row.status === 'preparing' ? row.lease : Date.now() + 1000, id);
  }
  pending() { return this.storage.sql.exec<Row>("SELECT * FROM archive_imports WHERE status NOT IN ('completed', 'failed')").toArray(); }
  nextMaintenance() {
    const rows = this.storage.sql.exec<Row>('SELECT * FROM archive_imports WHERE removed = 0 OR lease > 0').toArray();
    return rows.reduce((next, row) => {
      if (['completed', 'failed'].includes(row.status)) return !this.bucket || this.active.has(row.id) ? next : Math.min(next, row.cleanupAt);
      return Math.min(next, row.status !== 'uploading' && !this.active.has(row.id) ? Date.now() + 1000 : row.lease);
    }, Infinity);
  }
  async cleanup() {
    if (!this.bucket) return;
    for (const row of this.storage.sql.exec<Row>("SELECT * FROM archive_imports WHERE removed = 0 AND status IN ('completed', 'failed') AND cleanupAt <= ? LIMIT 2", Date.now()).toArray()) {
      if (this.active.has(row.id)) continue;
      try { await this.bucket.delete(row.key); this.storage.sql.exec('UPDATE archive_imports SET removed = 1, cleanupAt = 0 WHERE id = ?', row.id); }
      catch { this.storage.sql.exec('UPDATE archive_imports SET cleanupAt = ? WHERE id = ?', Date.now() + 30_000, row.id); }
    }
  }
}
