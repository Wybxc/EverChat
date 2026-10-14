import * as v from 'valibot';
import type { Attachment } from '../shared/attachments';
import { ATTACHMENT_LEASE } from '../shared/attachments';
import { DOCUMENT_VERSION, documentMediaTypeSchema, documentPartSchema, estimateDocumentTokens, MAX_DOCUMENT_BYTES, MAX_MESSAGE_DOCUMENTS, type DocumentPart } from '../shared/documents';
import { extractDocument } from './document-parser';
import { pdfExtractionSchema, type PDFExtraction, type PDFMetadata } from '../shared/pdf';
import { HttpError } from './http';

type Source = Attachment & { key: string };
type Row = { id: string; status: string; key: string; lease: number; token: string | null; sha256: string | null;
  characters: number; tokens: number; bytes: number; csv: string | null; error: string | null; errorStatus: number | null } & Record<string, SqlStorageValue>;
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)), (byte) => byte.toString(16).padStart(2, '0')).join('');
export class DocumentStore {
  private parsing = new Map<string, Promise<DocumentPart>>();
  constructor(private storage: DurableObjectStorage, private bucket: R2Bucket | undefined,
    private source: (conversationId: string, id: string) => Source,
    private original: (conversationId: string, id: string, head?: boolean) => Promise<Response>, private settled: (id: string) => void) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS attachment_documents (id TEXT PRIMARY KEY, status TEXT NOT NULL, key TEXT NOT NULL,
      lease INTEGER NOT NULL, token TEXT, sha256 TEXT, characters INTEGER NOT NULL, tokens INTEGER NOT NULL, bytes INTEGER NOT NULL,
      csv TEXT, error TEXT, errorStatus INTEGER)`);
    storage.sql.exec('CREATE TABLE IF NOT EXISTS attachment_pdf_metadata (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  }
  private pdf(id: string): PDFMetadata | undefined {
    const row = this.storage.sql.exec<{ payload: string }>('SELECT payload FROM attachment_pdf_metadata WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.payload) as PDFMetadata : undefined;
  }
  private row(id: string) { return this.storage.sql.exec<Row>('SELECT * FROM attachment_documents WHERE id = ?', id).toArray()[0]; }
  private requireSource(conversationId: string, id: string) {
    if (!this.bucket) throw new HttpError(503, '文件存储未配置，请先绑定私有 R2 桶。');
    const source = this.source(conversationId, id);
    if (source.status !== 'ready') throw new HttpError(409, '文件尚未上传完成。');
    if (!v.safeParse(documentMediaTypeSchema, source.mediaType).success) throw new HttpError(415, '请选择文本文件或 PDF。');
    if (source.mediaType !== 'application/pdf' && source.size > MAX_DOCUMENT_BYTES) throw new HttpError(413, '文本文件最多 128 KiB，请拆分文件或选择片段。');
    return source;
  }
  reference(conversationId: string, id: string): DocumentPart {
    const source = this.requireSource(conversationId, id), row = this.row(id);
    if (!row || row.status !== 'ready') throw new HttpError(409, '文件尚未解析完成，请重新选择文件。');
    const part = v.safeParse(documentPartSchema, { type: 'file', attachmentId: id, name: source.name, size: source.size,
      mediaType: source.mediaType, sha256: source.sha256, version: DOCUMENT_VERSION, textSha256: row.sha256,
      characters: row.characters, tokens: row.tokens, ...(row.csv ? { csv: JSON.parse(row.csv) } : {}), ...(this.pdf(id) ? { pdf: this.pdf(id) } : {}) });
    if (!part.success) throw new HttpError(409, '文件解析引用无效，请重新上传。');
    return part.output;
  }
  references(conversationId: string, ids: string[]) {
    if (ids.length > MAX_MESSAGE_DOCUMENTS || new Set(ids).size !== ids.length) throw new HttpError(400, '每条消息最多添加 4 个不同的文本文件。');
    return ids.map((id) => this.reference(conversationId, id));
  }
  async parse(conversationId: string, id: string, input?: PDFExtraction) {
    const source = this.requireSource(conversationId, id);
    let prepared: { text: string; pdf: PDFMetadata } | undefined, expectedHash: string | null = null;
    if (input !== undefined) {
      if (source.mediaType !== 'application/pdf') throw new HttpError(415, '只有 PDF 使用客户端提取结果。');
      const parsed = v.safeParse(pdfExtractionSchema, input);
      if (!parsed.success) throw new HttpError(400, 'PDF 提取结果无效，请重新选择文件。');
      if (parsed.output.sourceSha256 !== source.sha256) throw new HttpError(409, 'PDF 原文件与提取结果不符。');
      const checked = extractDocument(new TextEncoder().encode(parsed.output.text), 'text/plain');
      if (checked.text !== parsed.output.text) throw new HttpError(415, 'PDF 提取文本的编码无效。');
      prepared = { text: checked.text, pdf: parsed.output.pdf }; expectedHash = await digest(new TextEncoder().encode(checked.text));
      this.requireSource(conversationId, id);
    }
    const row = this.row(id);
    if (prepared && row && (row.sha256 !== expectedHash || JSON.stringify(this.pdf(id)) !== JSON.stringify(prepared.pdf))) throw new HttpError(409, '此 PDF 已绑定另一份提取结果，请重新选择文件。');
    if (row?.status === 'ready') return this.reference(conversationId, id);
    if (source.mediaType === 'application/pdf' && !prepared) throw new HttpError(400, '请先在浏览器提取并保存 PDF 文本。');
    if (row?.status === 'failed') throw new HttpError(row.errorStatus ?? 415, row.error ?? '解析失败，请重新选择文件。');
    const active = this.parsing.get(id);
    if (active) return active;
    if (row) throw new HttpError(409, '文件解析尚未确认或正在清理，请稍后重新选择。');
    const token = crypto.randomUUID(), key = `${source.key}/text-v1`;
    this.storage.transactionSync(() => {
      this.storage.sql.exec("INSERT INTO attachment_documents VALUES (?, 'parsing', ?, ?, ?, ?, 0, 0, 0, NULL, NULL, NULL)", id, key, Date.now() + ATTACHMENT_LEASE, token, expectedHash);
      if (prepared) this.storage.sql.exec('INSERT INTO attachment_pdf_metadata VALUES (?, ?)', id, JSON.stringify(prepared.pdf));
    });
    const promise = this.parseSource(conversationId, source, key, token, prepared);
    this.parsing.set(id, promise);
    try { return await promise; }
    finally { this.parsing.delete(id); this.settled(id); }
  }
  private async parseSource(conversationId: string, source: Source, key: string, token: string, prepared?: { text: string; pdf: PDFMetadata }) {
    let putStarted = false;
    try {
      await this.storage.sync();
      const response = await this.original(conversationId, source.id, Boolean(prepared));
      const extracted = prepared ?? extractDocument(new Uint8Array(await response.arrayBuffer()), source.mediaType as Exclude<DocumentPart['mediaType'], 'application/pdf'>);
      const bytes = new TextEncoder().encode(extracted.text), sha256 = await digest(bytes);
      this.requireSource(conversationId, source.id);
      putStarted = true;
      const saved = await this.bucket!.put(key, bytes, { sha256, storageClass: 'Standard', httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
      if (!saved || saved.size !== bytes.length) throw new HttpError(503, '解析结果未完整保存，请重新选择文件。');
      this.requireSource(conversationId, source.id);
      if (this.row(source.id)?.token !== token) throw new HttpError(409, '文件解析认领已失效。');
      this.storage.sql.exec("UPDATE attachment_documents SET status = 'ready', lease = 0, sha256 = ?, characters = ?, tokens = ?, bytes = ?, csv = ? WHERE id = ?", sha256,
        extracted.text.length, estimateDocumentTokens({ name: source.name, mediaType: source.mediaType as DocumentPart['mediaType'] }, extracted.text), bytes.length, 'csv' in extracted && extracted.csv ? JSON.stringify(extracted.csv) : null, source.id);
      await this.storage.sync(); return this.reference(conversationId, source.id);
    } catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(503, '解析结果暂时无法保存，请重新选择文件。');
      if (this.row(source.id)?.token === token) {
        if (putStarted) {
          this.storage.sql.exec("UPDATE attachment_documents SET status = 'cleaning', token = NULL, lease = ? WHERE id = ?", Date.now(), source.id);
          try { await this.bucket!.delete(key); this.erase(source.id); }
          catch { this.storage.sql.exec('UPDATE attachment_documents SET lease = ? WHERE id = ?', Date.now() + 30_000, source.id); }
        } else this.storage.sql.exec("UPDATE attachment_documents SET status = 'failed', token = NULL, lease = 0, error = ?, errorStatus = ? WHERE id = ?", failure.message, failure.status, source.id);
      }
      throw failure;
    }
  }
  async read(conversationId: string, id: string): Promise<{ file: DocumentPart; text: string }> {
    const file = this.reference(conversationId, id), row = this.row(id)!;
    const object = await this.bucket!.get(row.key);
    if (!object) throw new HttpError(404, '文件解析结果不存在，请重新上传。');
    const checksum = object.checksums.sha256 ? Array.from(new Uint8Array(object.checksums.sha256), (byte) => byte.toString(16).padStart(2, '0')).join('') : null;
    if (object.size !== row.bytes || checksum !== row.sha256) { await object.body.cancel().catch(() => {}); throw new HttpError(409, '解析结果完整性校验失败。'); }
    const bytes = new Uint8Array(await object.arrayBuffer());
    this.requireSource(conversationId, id);
    if (await digest(bytes) !== file.textSha256) throw new HttpError(409, '解析结果完整性校验失败。');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    if (text.length !== file.characters || estimateDocumentTokens(file, text) !== file.tokens) throw new HttpError(409, '解析结果长度或预算不符。');
    if (file.pdf) await this.original(conversationId, id, true);
    this.requireSource(conversationId, id);
    return { file, text };
  }
  async validate(conversationId: string, file: DocumentPart) {
    const saved = await this.read(conversationId, file.attachmentId);
    if (JSON.stringify(v.parse(documentPartSchema, file)) !== JSON.stringify(saved.file)) throw new HttpError(409, '文件引用与解析结果不符。');
  }
  isActive(id: string) { return this.parsing.has(id); }
  lease(id: string) { const row = this.row(id); return row?.status === 'parsing' ? row.lease : 0; }
  erase(id: string) {
    this.storage.sql.exec('DELETE FROM attachment_documents WHERE id = ?', id);
    this.storage.sql.exec('DELETE FROM attachment_pdf_metadata WHERE id = ?', id);
  }
  nextCleanup() { return this.storage.sql.exec<{ next: number }>("SELECT MIN(lease) AS next FROM attachment_documents WHERE status IN ('parsing', 'cleaning') HAVING COUNT(*) > 0").toArray()[0]?.next; }
  async cleanup() {
    if (!this.bucket) return;
    for (const row of this.storage.sql.exec<Row>("SELECT * FROM attachment_documents WHERE status IN ('parsing', 'cleaning') AND lease <= ? ORDER BY lease LIMIT 4", Date.now()).toArray()) {
      const current = this.row(row.id);
      if (!current || current.key !== row.key || !['parsing', 'cleaning'].includes(current.status) || current.lease > Date.now()) continue;
      if (this.parsing.has(row.id)) { this.storage.sql.exec('UPDATE attachment_documents SET lease = ? WHERE id = ?', Date.now() + 30_000, row.id); continue; }
      this.storage.sql.exec("UPDATE attachment_documents SET status = 'cleaning', token = NULL WHERE id = ?", row.id);
      try { await this.bucket.delete(row.key); this.erase(row.id); }
      catch { this.storage.sql.exec('UPDATE attachment_documents SET lease = ? WHERE id = ?', Date.now() + 30_000, row.id); }
    }
  }
}
