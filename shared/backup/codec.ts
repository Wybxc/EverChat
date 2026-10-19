import { unzipSync, zipSync, type Zippable } from 'fflate';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_MANIFEST,
  ARCHIVE_VERSION,
  archiveEntries,
  extractedPath,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  originalPath,
  sha256,
  validateArchiveManifest,
  type ArchiveManifest,
} from './archive';
import { MAX_ATTACHMENT_BYTES } from '../attachments/files';
import { MAX_BACKUP_BYTES, validateBackup } from './backup';
import { MAX_PDF_TEXT_BYTES, validatePdfText } from '../attachments/pdf';

const allowed = /^(manifest\.json|files\/[0-9a-f-]{36}|documents\/[0-9a-f-]{36}\.txt)$/;
type ArchiveData = { manifest: ArchiveManifest; entries: Record<string, Uint8Array> };

function checkStoredZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    end = bytes.length - 22;
  const u16 = (at: number) => view.getUint16(at, true),
    u32 = (at: number) => view.getUint32(at, true);
  const invalid = () => {
    throw new Error('仅支持完整、未加密、未压缩的 EverChat ZIP 存档。');
  };
  if (u32(end) !== 0x06054b50 || u16(end + 4) || u16(end + 6) || u16(end + 20)) invalid();
  const count = u16(end + 10),
    start = u32(end + 16);
  if (
    !count ||
    count > MAX_ARCHIVE_ENTRIES ||
    u16(end + 8) !== count ||
    start + u32(end + 12) !== end
  )
    invalid();
  let at = start,
    local = 0;
  for (let index = 0; index < count; index++) {
    if (
      at + 46 > end ||
      u32(at) !== 0x02014b50 ||
      u16(at + 8) & ~0x800 ||
      u16(at + 10) ||
      u32(at + 20) !== u32(at + 24) ||
      u16(at + 30) ||
      u16(at + 32) ||
      u16(at + 34) ||
      u32(at + 42) !== local
    )
      invalid();
    const nameLength = u16(at + 28),
      size = u32(at + 24),
      next = at + 46 + nameLength;
    if (
      !nameLength ||
      nameLength > 100 ||
      next > end ||
      local + 30 + nameLength + size > start ||
      u32(local) !== 0x04034b50 ||
      u16(local + 6) !== u16(at + 8) ||
      u16(local + 8) ||
      u32(local + 14) !== u32(at + 16) ||
      u32(local + 18) !== size ||
      u32(local + 22) !== size ||
      u16(local + 26) !== nameLength ||
      u16(local + 28)
    )
      invalid();
    for (let offset = 0; offset < nameLength; offset++)
      if (bytes[local + 30 + offset] !== bytes[at + 46 + offset]) invalid();
    local += 30 + nameLength + size;
    at = next;
  }
  if (at !== end || local !== start) invalid();
}

async function validateArchiveData(manifest: ArchiveManifest, entries: Record<string, Uint8Array>) {
  const expected = new Set(archiveEntries(manifest));
  if (
    Object.keys(entries).length !== expected.size ||
    Object.keys(entries).some((path) => !expected.has(path))
  )
    throw new Error('备份存档包含多余文件或缺少文件。');
  for (const file of manifest.files) {
    const original = entries[originalPath(file.id)];
    if (!original || original.byteLength !== file.size || (await sha256(original)) !== file.sha256)
      throw new Error('备份原文件大小或校验和不符。');
    if (file.parsed) {
      const bytes = entries[extractedPath(file.id)],
        ref = file.parsed.reference;
      if (
        !bytes ||
        bytes.byteLength !== file.parsed.bytes ||
        (await sha256(bytes)) !== ref.textSha256
      )
        throw new Error('备份提取文本大小或校验和不符。');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      if (
        text.length !== ref.characters ||
        !text.trim() ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
      )
        throw new Error('备份提取文本无效。');
      if (ref.pdf)
        validatePdfText({
          sourceSha256: ref.sha256,
          text,
          pdf: ref.pdf,
          pageOffsets: file.parsed.pageOffsets,
        });
    }
  }
}

export async function encodeArchive(
  manifest: ArchiveManifest,
  entries: Record<string, Uint8Array>,
) {
  const safe = validateArchiveManifest(manifest),
    metadata = new TextEncoder().encode(JSON.stringify(safe));
  if (metadata.byteLength > MAX_BACKUP_BYTES) throw new Error('备份清单超过 12 MiB。');
  const all = { ...entries, [ARCHIVE_MANIFEST]: metadata };
  await validateArchiveData(safe, all);
  const files: Zippable = {};
  for (const [path, bytes] of Object.entries(all)) files[path] = [bytes, { level: 0 }];
  const archive = zipSync(files);
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('备份存档过大。');
  return archive;
}

export async function decodeArchive(bytes: Uint8Array): Promise<ArchiveData> {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new Error('备份存档大小无效。');
  checkStoredZip(bytes);
  let total = 0;
  const seen = new Set<string>();
  // The filter runs before fflate allocates or inflates any entry. Only stored ZIP entries are accepted.
  const entries = unzipSync(bytes, {
    filter(file) {
      const limit =
        file.name === ARCHIVE_MANIFEST
          ? MAX_BACKUP_BYTES
          : file.name.startsWith('documents/')
            ? MAX_PDF_TEXT_BYTES
            : MAX_ATTACHMENT_BYTES;
      if (
        !allowed.test(file.name) ||
        seen.has(file.name) ||
        seen.size >= MAX_ARCHIVE_ENTRIES ||
        file.compression !== 0 ||
        file.size !== file.originalSize ||
        file.size < 1 ||
        file.size > limit ||
        (total += file.size) > MAX_ARCHIVE_BYTES
      )
        throw new Error('备份 ZIP 的路径、压缩方法或文件大小无效。');
      seen.add(file.name);
      return true;
    },
  });
  const raw = entries[ARCHIVE_MANIFEST];
  if (!raw || Object.values(entries).some((entry) => entry.byteLength < 1))
    throw new Error('备份清单缺失或 ZIP 不完整。');
  const manifest = validateArchiveManifest(
    JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)),
  );
  await validateArchiveData(manifest, entries);
  return { manifest, entries };
}

export async function decodeBackup(bytes: Uint8Array): Promise<ArchiveData> {
  let start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (start < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[start])) start++;
  if (bytes[start] !== 0x7b) return decodeArchive(bytes);
  if (bytes.byteLength > MAX_BACKUP_BYTES) throw new Error('JSON 备份超过 12 MiB。');
  const backup = validateBackup(
    JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)),
  );
  return {
    manifest: validateArchiveManifest({
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      backup,
      files: [],
    }),
    entries: {},
  };
}
