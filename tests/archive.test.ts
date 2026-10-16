import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { encodeArchive, decodeArchive, decodeBackup } from '../shared/backup/codec';
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, ARCHIVE_MANIFEST, extractedPath, originalPath, sha256, validateArchiveManifest, type ArchiveManifest } from '../shared/backup/archive';
import { BACKUP_FORMAT, BACKUP_VERSION } from '../shared/backup/backup';

async function fixture() {
  const id = crypto.randomUUID(), text = new TextEncoder().encode('资料🙂\n安全文本'), hash = await sha256(text);
  const reference = { type: 'file' as const, attachmentId: id, name: '资料.txt', size: text.length, mediaType: 'text/plain' as const,
    sha256: hash, version: 1 as const, textSha256: hash, characters: new TextDecoder().decode(text).length, tokens: 12 };
  const manifest: ArchiveManifest = { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION,
    backup: { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 1,
      conversation: { id: crypto.randomUUID(), title: '存档', createdAt: 1, updatedAt: 1, messages: [{ id: crypto.randomUUID(), role: 'user', parts: [reference],
        status: 'completed', createdAt: 1, parentId: null, revisionOf: null, error: null, providerId: null, model: null, modelName: null }] },
      settings: { providers: [], activeProviderId: null, activeModel: '', systemPrompt: '', maxOutputTokens: null, showReasoning: false, promptPresets: [] } },
    files: [{ id, name: reference.name, size: text.length, mediaType: reference.mediaType, sha256: hash, parsed: { reference, bytes: text.length } }] };
  return { manifest, text, entries: { [originalPath(id)]: text, [extractedPath(id)]: text } };
}
test('stored ZIP roundtrips exact Unicode originals, extracted text and immutable references', async () => {
  const { manifest, entries } = await fixture();
  const result = await decodeArchive(await encodeArchive(manifest, entries));
  assert.deepEqual(result.manifest, manifest);
  for (const [path, bytes] of Object.entries(entries)) assert.deepEqual(result.entries[path], bytes);
});
test('missing, extra, mismatched and duplicate file records are rejected before producing a restorable archive', async () => {
  const { manifest, entries } = await fixture(), id = manifest.files[0].id;
  await assert.rejects(encodeArchive(manifest, { [originalPath(id)]: entries[originalPath(id)] }), /缺少/);
  await assert.rejects(encodeArchive(manifest, { ...entries, '../outside': new Uint8Array([1]) }), /多余/);
  await assert.rejects(encodeArchive(manifest, { ...entries, [originalPath(id)]: new Uint8Array(entries[originalPath(id)]).fill(1) }), /校验和/);
  assert.throws(() => validateArchiveManifest({ ...manifest, files: [] }), /缺少/);
  assert.throws(() => validateArchiveManifest({ ...manifest, files: [manifest.files[0], manifest.files[0]] }), /重复/);
  const changed = structuredClone(manifest); changed.files[0].parsed!.reference.attachmentId = crypto.randomUUID();
  assert.throws(() => validateArchiveManifest(changed), /引用/);
});
test('compressed, encrypted, truncated, prefixed and extra-entry ZIP files fail before extraction', async () => {
  const { manifest, entries } = await fixture();
  const all = { ...entries, [ARCHIVE_MANIFEST]: new TextEncoder().encode(JSON.stringify(manifest)) };
  await assert.rejects(decodeArchive(zipSync(all, { level: 9 })), /未压缩/);
  const normal = await encodeArchive(manifest, entries), encrypted = normal.slice(); encrypted[6] |= 1;
  await assert.rejects(decodeArchive(encrypted), /未加密/);
  await assert.rejects(decodeArchive(normal.subarray(0, normal.length - 1)), /完整/);
  const prefixed = new Uint8Array(normal.length + 1); prefixed.set(normal, 1);
  await assert.rejects(decodeArchive(prefixed), /完整/);
  await assert.rejects(decodeArchive(zipSync({ ...all, 'files/../../outside': new Uint8Array([1]) }, { level: 0 })), /路径/);
  const id = manifest.files[0].id, other = crypto.randomUUID();
  const duplicated = Buffer.from(zipSync({ ...all, [originalPath(other)]: entries[originalPath(id)] }, { level: 0 }));
  const before = Buffer.from(originalPath(other)), after = Buffer.from(originalPath(id));
  for (let at = duplicated.indexOf(before); at >= 0; at = duplicated.indexOf(before, at + before.length)) duplicated.set(after, at);
  await assert.rejects(decodeArchive(duplicated), /路径/);
});
test('valid ZIP framing cannot bypass original or extracted SHA-256 checks', async () => {
  const { manifest, entries } = await fixture(), id = manifest.files[0].id;
  const all = { ...entries, [ARCHIVE_MANIFEST]: new TextEncoder().encode(JSON.stringify(manifest)) };
  for (const path of [originalPath(id), extractedPath(id)]) await assert.rejects(decodeArchive(zipSync({ ...all, [path]: new Uint8Array(entries[path]).fill(1) }, { level: 0 })), /校验和/);
});
test('current fileless JSON backups allow UTF-8 BOM and JSON whitespace, while missing attachment data is rejected', async () => {
  const { manifest } = await fixture(), backup = structuredClone(manifest.backup);
  backup.conversation.messages = [];
  for (const prefix of ['', ' \n\t\r', '\ufeff \n']) {
    const decoded = await decodeBackup(new TextEncoder().encode(prefix + JSON.stringify(backup)));
    assert.deepEqual(decoded.manifest.backup, backup); assert.deepEqual(decoded.entries, {});
  }
  await assert.rejects(decodeBackup(new TextEncoder().encode(JSON.stringify(manifest.backup))), /缺少/);
});
test('unstorable provider rows and invalid endpoints are rejected before an import can allocate files', async () => {
  const { manifest } = await fixture();
  manifest.backup.settings.providers = [{ id: crypto.randomUUID(), name: 'Too large', provider: 'openai-chat', baseUrl: 'https://provider.test/v1',
    models: Array.from({ length: 200 }, (_, index) => ({ id: `model-${index}`, name: '', enabled: true, systemPrompt: 'x'.repeat(20_000) })) }];
  assert.throws(() => validateArchiveManifest(manifest), /存储上限/);
  manifest.backup.settings.providers[0].models = [];
  manifest.backup.settings.providers[0].baseUrl = 'https://provider.test/v1?secret=value';
  assert.throws(() => validateArchiveManifest(manifest), /查询参数/);
});
test('invalid export timestamps cannot turn retries of the same file into different manifest identities', async () => {
  const { manifest } = await fixture();
  for (const exportedAt of [undefined, NaN, 'today']) {
    assert.throws(() => validateArchiveManifest({ ...manifest, backup: { ...manifest.backup, exportedAt } }), /导出时间/);
  }
  assert.deepEqual(validateArchiveManifest(manifest), manifest);
});
