import { createParser } from 'eventsource-parser';
import {
  MAX_TOOL_ARTIFACT_BYTES,
  MAX_TOOL_ARTIFACTS,
  type ToolArtifact,
} from '../../shared/attachments/artifacts';
import { attachmentSignatureMatches, fileMediaType } from '../../shared/attachments/files';
import type { ProviderConfig } from '../../shared/providers/types';
import { MAX_EVENT_CHARACTERS, type GenerationEvent } from '../../shared/streaming/provider-stream';
import { ProviderError } from '../generation/errors';

type Json = Record<string, unknown>;
const object = (x: unknown): Json =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Json) : {};
const array = (x: unknown): Json[] => (Array.isArray(x) ? x.map(object) : []);
const MAX_ARTIFACT_EVENT = Math.ceil((MAX_TOOL_ARTIFACT_BYTES * 4) / 3) + 512 * 1024;
const MAX_ARTIFACT_PAYLOAD = 16 * 1024 * 1024;
const imageMedia = ['image/png', 'image/jpeg', 'image/webp'] as const;
type ArtifactEvent = Extract<GenerationEvent, { type: 'artifact' }>;
export type SaveProviderArtifact = (
  name: string,
  media: ToolArtifact['mediaType'],
  bytes: Uint8Array<ArrayBuffer>,
  preview: boolean,
) => Promise<ToolArtifact>;
const invalidArtifact = () => new ProviderError('供应商产物无法完整保存，已保留之前的回答。');

function decodeImage(value: string) {
  if (!value || value.length > MAX_ARTIFACT_EVENT || /[^a-zA-Z0-9+/=]/.test(value))
    throw invalidArtifact();
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.byteLength || decoded.byteLength > MAX_TOOL_ARTIFACT_BYTES) throw invalidArtifact();
  return decoded;
}
const safeName = (name: unknown, fallback: string) =>
  (typeof name === 'string'
    ? name
        .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
        .trim()
        .slice(0, 180)
    : '') || fallback;
function imageType(bytes: Uint8Array) {
  return imageMedia.find((media) => attachmentSignatureMatches(bytes, media));
}

export class ProviderArtifacts {
  private seen = new Set<string>();
  private pending: ArtifactEvent[] = [];
  private usedBytes = 0;
  private count = 0;
  private preview = false;
  private readonly images;
  private readonly container;
  private readonly vendor;
  constructor(
    private readonly config: ProviderConfig,
    private readonly signal: AbortSignal,
    private readonly save: SaveProviderArtifact,
  ) {
    this.images = config.serverTools?.some(({ tool }) => tool === 'image-generation');
    this.container = config.serverTools?.some(
      ({ tool }) => tool === 'code-execution' || tool === 'shell',
    );
    this.vendor = config.serverTools?.[0]?.vendor;
  }

  get usesImageEvents() {
    return this.images || (this.vendor === 'google' && this.container);
  }

  private async put(
    key: string,
    name: string,
    bytes: Uint8Array<ArrayBuffer>,
    preview = false,
    image = false,
  ) {
    if (this.seen.has(key) || (preview && this.preview)) return;
    this.seen.add(key);
    if (preview) this.preview = true;
    else if (++this.count > MAX_TOOL_ARTIFACTS) throw invalidArtifact();
    if ((this.usedBytes += bytes.byteLength) > MAX_ARTIFACT_PAYLOAD) throw invalidArtifact();
    const raster = imageType(bytes);
    if (image && !raster) throw invalidArtifact();
    const format = fileMediaType(name);
    const media =
      raster ??
      (format && attachmentSignatureMatches(bytes.subarray(0, 12), format)
        ? format
        : 'application/octet-stream');
    const filename = image && raster ? `${name}.${raster.split('/')[1]}` : name;
    this.signal.throwIfAborted();
    const artifact = await this.save(filename, media, bytes, preview);
    this.signal.throwIfAborted();
    this.pending.push({ type: 'artifact', artifact, ...(preview ? { preview: true } : {}) });
  }

  private async imageItem(item: Json) {
    if (item.type !== 'image_generation_call' || typeof item.result !== 'string' || !item.result)
      return;
    if (typeof item.id !== 'string' || item.id.length > 128) throw invalidArtifact();
    const key = `image:${item.id}`;
    if (!this.seen.has(key)) await this.put(key, 'image', decodeImage(item.result), false, true);
    item.result = '';
  }

  async rewrite(data: string) {
    const event = object(JSON.parse(data));
    if (this.images) {
      if (event.type === 'response.image_generation_call.partial_image') {
        const image = event.partial_image_b64;
        if (!this.preview && typeof image === 'string')
          await this.put('image:preview', 'preview', decodeImage(image), true, true);
        event.partial_image_b64 = '';
      } else if (event.type === 'response.output_item.done') {
        await this.imageItem(object(event.item));
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        for (const item of array(object(event.response).output)) await this.imageItem(item);
      }
    } else if (this.container && this.vendor === 'google') {
      for (const candidate of array(event.candidates)) {
        if (candidate.index !== undefined && candidate.index !== 0) continue;
        const parts = array(object(candidate.content).parts);
        const attachments = parts.filter((part) => {
          const media = object(part.inlineData).mimeType;
          return typeof media === 'string' && imageMedia.some((type) => type === media);
        });
        for (const part of attachments) {
          const data = object(part.inlineData).data;
          if (typeof data !== 'string' || !data) continue;
          const bytes = decodeImage(data);
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          await this.put(
            `gemini:${Buffer.from(digest).toString('hex')}`,
            'chart',
            bytes,
            false,
            true,
          );
        }
        object(candidate.content).parts = parts.filter((part) => !attachments.includes(part));
      }
    }
    const output = JSON.stringify(event);
    if (Buffer.byteLength(output) > MAX_EVENT_CHARACTERS) throw invalidArtifact();
    return output;
  }

  private async download(key: string, url: URL, headers: HeadersInit, filename: unknown) {
    if (this.seen.has(key)) return;
    const response = await globalThis.fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]),
    });
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get('Content-Length') ?? 0) > MAX_TOOL_ARTIFACT_BYTES
    ) {
      await response.body?.cancel().catch(() => {});
      throw invalidArtifact();
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if ((length += chunk.value.length) > MAX_TOOL_ARTIFACT_BYTES) throw invalidArtifact();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const header = response.headers
      .get('Content-Disposition')
      ?.match(/(?:^|;)\s*filename="([^"]+)"/i)?.[1];
    await this.put(key, safeName(filename ?? header, 'output.bin'), Buffer.concat(chunks, length));
  }

  async observe(event: Json) {
    if (this.container && this.vendor === 'openai') {
      const annotations =
        event.type === 'response.output_text.annotation.added'
          ? [object(event.annotation)]
          : event.type === 'response.output_item.done' && object(event.item).type === 'message'
            ? array(object(event.item).content).flatMap((part) => array(part.annotations))
            : [];
      for (const annotation of annotations) {
        const container = annotation.container_id,
          file = annotation.file_id;
        if (
          annotation.type !== 'container_file_citation' ||
          typeof container !== 'string' ||
          typeof file !== 'string' ||
          !/^cntr_[a-zA-Z0-9_-]{1,120}$/.test(container) ||
          !/^(?:cfile_|file-)[a-zA-Z0-9_-]{1,120}$/.test(file)
        )
          continue;
        await this.download(
          `openai:${container}:${file}`,
          new URL(`https://api.openai.com/v1/containers/${container}/files/${file}/content`),
          { Authorization: `Bearer ${this.config.apiKey}` },
          annotation.filename,
        );
      }
    } else if (
      this.container &&
      this.vendor === 'anthropic' &&
      event.type === 'content_block_start'
    ) {
      const block = object(event.content_block);
      if (typeof block.type === 'string' && block.type.endsWith('code_execution_tool_result'))
        for (const item of array(object(block.content).content)) {
          const file = item.file_id;
          if (typeof file !== 'string' || !/^file_[a-zA-Z0-9_-]{1,120}$/.test(file)) continue;
          await this.download(
            `anthropic:${file}`,
            new URL(`https://api.anthropic.com/v1/files/${file}/content`),
            {
              'x-api-key': this.config.apiKey!,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'files-api-2025-04-14',
            },
            item.filename,
          );
        }
    }
    return this.pending.splice(0);
  }
}

/** Strip binary image fields before the normal SDK and durable stream receive the event. */
export function rewriteArtifactStream(
  body: ReadableStream<Uint8Array>,
  artifacts: ProviderArtifacts,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const encoder = new TextEncoder();
  const data: string[] = [];
  const parser = createParser({
    maxBufferSize: MAX_ARTIFACT_EVENT,
    onEvent(event) {
      data.push(event.data);
    },
    onError(error) {
      if (error.type === 'max-buffer-size-exceeded') throw invalidArtifact();
    },
  });
  async function* stream() {
    let afterCR = false,
      last = '',
      pending = false;
    const consume = async function* (raw: string) {
      if (!raw) return;
      const text = (afterCR && raw.startsWith('\n') ? raw.slice(1) : raw).replace(/\r\n|\r/g, '\n');
      afterCR = raw.endsWith('\r');
      const tail = last + text;
      const boundary = tail.lastIndexOf('\n\n');
      pending =
        boundary >= 0 ? Boolean(tail.slice(boundary + 2).trim()) : pending || Boolean(text.trim());
      last = text.at(-1) ?? last;
      parser.feed(text);
      for (const event of data.splice(0))
        yield encoder.encode(`data: ${await artifacts.rewrite(event)}\n\n`);
    };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        for (let at = 0; at < next.value.length; at += 16_384)
          yield* consume(decoder.decode(next.value.subarray(at, at + 16_384), { stream: true }));
      }
      yield* consume(decoder.decode());
      if (pending) throw invalidArtifact();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const iterator = stream();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await reader.cancel().catch(() => {});
      await iterator.return(undefined);
    },
  });
}
