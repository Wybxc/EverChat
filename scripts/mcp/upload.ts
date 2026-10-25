import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as v from 'valibot';
import { attachmentInputSchema, fileMediaType } from '../../shared/attachments/files';
import {
  attachmentsPrepareSchema,
  attachmentsResultSchema,
  type AttachmentsResult,
} from '../../worker/mcp/attachment-contracts';
import { extractMcpPdf } from './pdf';

const manifestSchema = v.strictObject({
  continuation: v.optional(v.string()),
  files: v.pipe(
    v.array(
      v.strictObject({
        path: v.string(),
        replaces: v.optional(v.string()),
        versionNote: v.optional(v.string()),
      }),
    ),
    v.minLength(1),
  ),
});
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export async function uploadFiles(manifestPath: string, statePath: string) {
  const key = process.env.EVERCHAT_API_KEY,
    endpoint = new URL(process.env.EVERCHAT_MCP_URL ?? 'https://chat.wybxc.cc/mcp');
  if (
    !key ||
    (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      'Set EVERCHAT_API_KEY and a secure EVERCHAT_MCP_URL without embedded credentials',
    );
  const manifest = v.parse(manifestSchema, JSON.parse(await readFile(manifestPath, 'utf8'))),
    sources: Map<string, { original: Buffer; pdf?: Buffer }> = new Map();
  let saved: v.InferOutput<typeof attachmentsPrepareSchema> | undefined;
  try {
    saved = v.parse(attachmentsPrepareSchema, JSON.parse(await readFile(statePath, 'utf8')));
  } catch (e) {
    if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'ENOENT')
      throw new Error(
        'Invalid upload state; preserve it to investigate instead of retrying with new identities',
      );
  }
  const files = [];
  for (const [index, input] of manifest.files.entries()) {
    const name = basename(input.path),
      mediaType = fileMediaType(name);
    if (!mediaType) throw new Error('Unsupported file type');
    const original = await readFile(input.path),
      sha256 = digest(original),
      clientFileId = saved?.files[index]?.clientFileId ?? crypto.randomUUID();
    v.parse(attachmentInputSchema, {
      id: clientFileId,
      name,
      mediaType,
      size: original.length,
      sha256,
    });
    let pdf: Buffer | undefined;
    if (mediaType === 'application/pdf') {
      const extracted = await extractMcpPdf(original, sha256),
        { text, ...metadata } = extracted;
      pdf = Buffer.from(JSON.stringify(metadata) + '\n' + text);
    }
    files.push({
      clientFileId,
      name,
      mediaType,
      purpose: mediaType.startsWith('image/') ? ('image' as const) : ('document' as const),
      size: original.length,
      sha256,
      ...(input.replaces ? { replaces: input.replaces } : {}),
      ...(input.versionNote ? { versionNote: input.versionNote } : {}),
      ...(pdf ? { pdfText: { size: pdf.length, sha256: digest(pdf) } } : {}),
    });
    sources.set(clientFileId, { original, pdf });
  }
  const prepared = v.parse(attachmentsPrepareSchema, {
    uploadId: saved?.uploadId ?? crypto.randomUUID(),
    ...(manifest.continuation ? { continuation: manifest.continuation } : {}),
    files,
  });
  if (saved && JSON.stringify(saved) !== JSON.stringify(prepared))
    throw new Error(
      'Files or target changed; intentionally use a new state path for a new version',
    );
  if (!saved)
    await writeFile(statePath, JSON.stringify(prepared, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  const client = new Client({ name: 'everchat-upload', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${key}` }, redirect: 'error' },
      }),
    );
    const call = async (name: string, args: object) => {
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      if (result.isError)
        throw new Error(
          'MCP attachment operation rejected; retry the same state after checking metadata',
        );
      return v.parse(attachmentsResultSchema, result.structuredContent);
    };
    let page = await call('everchat_attachments_prepare', prepared);
    const result: AttachmentsResult['files'] = [];
    while (true) {
      for (const file of page.files) {
        const source = sources.get(file.clientFileId);
        if (!source) throw new Error('Unexpected file identity');
        for (const slot of file.uploads) {
          const url = new URL(slot.url);
          if (
            (url.protocol !== 'https:' &&
              !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) ||
            url.username ||
            url.password ||
            Object.keys(slot.headers).some((h) =>
              ['authorization', 'cookie'].includes(h.toLowerCase()),
            )
          )
            throw new Error('Unsafe upload slot');
          const body = slot.kind === 'original' ? source.original : source.pdf;
          if (!body) throw new Error('Missing local upload bytes');
          const response = await fetch(url, {
            method: 'PUT',
            headers: slot.headers,
            body: new Uint8Array(body).buffer,
            redirect: 'error',
            credentials: 'omit',
            signal: AbortSignal.timeout(60_000),
          });
          await response.body?.cancel();
          if (!response.ok && response.status !== 412)
            throw new Error(
              `R2 upload failed (HTTP ${response.status}); retry with the same state`,
            );
        }
        result.push({ ...file, uploads: [] });
      }
      if (!page.hasMore) break;
      page = await call('everchat_attachments_get', {
        uploadRef: page.uploadRef,
        view: 'uploads',
        cursor: page.nextCursor,
      });
    }
    return {
      uploadRef: page.uploadRef,
      conversationId: page.conversationId,
      files: result.map(
        ({ clientFileId, attachmentRef, documentRef, versionRef, sha256, name }) => ({
          clientFileId,
          attachmentRef,
          documentRef,
          versionRef,
          sha256,
          name,
        }),
      ),
    };
  } finally {
    await client.close().catch(() => {});
  }
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const [manifest, state] = process.argv.slice(2);
  if (!manifest || !state)
    throw new Error('Usage: pnpm exec tsx scripts/mcp/upload.ts manifest.json state.json');
  uploadFiles(manifest, state)
    .then((result) => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
    .catch(() => {
      process.stderr.write(
        'Upload failed. Preserve the state file for an idempotent retry; check connection, key, local files and server metadata. No credentials or signed URLs were logged.\n',
      );
      process.exitCode = 1;
    });
}
