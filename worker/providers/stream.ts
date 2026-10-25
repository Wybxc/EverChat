import { documentKey } from '../../shared/attachments/documents';
import {
  assertDocumentContext,
  DocumentError,
  documentPrompt,
  estimateDocumentTokens,
  type DocumentPart,
  type LoadedDocumentInput,
  type DocumentInputSnapshot,
} from '../../shared/attachments/documents';
import type { ModelMessage } from 'ai';
import type { ChatInput, ProviderConfig } from '../../shared/providers/types';
import { GenerationCancelled, ProviderError } from '../generation/errors';
import {
  assertChatImage,
  assertImageContext,
  ImageContextError,
  type ImagePart,
} from '../../shared/attachments/images';
import { providerModel, providerRequestInit } from './sdk';
import { providerToolPrompt, type ProviderToolRequest } from './tool-turn';
import { coreProviderStream } from './core';
import { assertWebToolSupport } from '../../shared/web-tools/tasks';
import { sdkProviderError } from './sdk-diagnostics';
import { httpProviderError, providerFailure } from './failure';
import { ProviderWireGuard } from './stream-errors';
import { providerEvents, type ProviderResponse } from './events';
import { MAX_BUFFERED_BODY_BYTES } from '../../shared/platform/limits';
import {
  assembledInput,
  inputHash,
  type AssembledInput,
  type SubmittedInput,
} from './input-receipt';

export { GenerationCancelled, ProviderError } from '../generation/errors';

export async function openProviderStream(
  config: ProviderConfig,
  context: ChatInput[],
  signal: AbortSignal,
  loadImage?: (image: ImagePart) => Promise<Uint8Array>,
  loadDocument?: (file: DocumentPart) => Promise<string | LoadedDocumentInput>,
  toolRequest?: ProviderToolRequest,
  beforeRequest?: (input: SubmittedInput) => Promise<void>,
  onOutput?: (receivedAt: number) => void,
): Promise<ProviderResponse> {
  if (!config.apiKey)
    throw new ProviderError('尚未配置供应商 API 密钥。', providerFailure(config, 'connect'));
  const secrets = context.map((message) => message.content);
  const guard = new ProviderWireGuard();
  let responseHeaders: Headers | undefined;
  let assembled: AssembledInput | undefined;
  let requested = false;
  const request: typeof fetch = async (input, init) => {
    if (requested) throw new ProviderError('供应商请求不能重复发送。');
    requested = true;
    signal.throwIfAborted();
    init = providerRequestInit(config, init, Boolean(toolRequest));
    if (
      typeof init?.body === 'string' &&
      new TextEncoder().encode(init.body).byteLength > MAX_BUFFERED_BODY_BYTES
    )
      throw new ProviderError('模型请求超过单次序列化的内存保护大小，请减少附件或携带的历史。');
    if (beforeRequest) {
      if (typeof init?.body !== 'string' || !assembled)
        throw new ProviderError('无法确认供应商请求的输入依据。');
      await beforeRequest({
        ...assembled,
        requestSha256: inputHash(init.body),
        requestBytes: Buffer.byteLength(init.body),
      });
    }
    signal.throwIfAborted();
    const response = await globalThis.fetch(input, { ...init, signal, redirect: 'manual' });
    responseHeaders = response.headers;
    if (!response.ok) throw await httpProviderError(response, config, secrets);
    if (
      !response.body ||
      !response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream')
    ) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(
        '模型供应商未返回有效的流式响应。',
        providerFailure(config, 'protocol', undefined, {
          status: response.status,
          headers: response.headers,
          secrets,
        }),
      );
    }
    return new Response(guard.wrap(response.body, signal), {
      status: response.status,
      headers: response.headers,
    });
  };
  try {
    if (toolRequest) {
      try {
        assertWebToolSupport(config.modelMetadata, toolRequest.enabled);
      } catch (error) {
        throw new ProviderError(error instanceof Error ? error.message : '工具配置无效。');
      }
    }
    assertImageContext(context, config);
    assertDocumentContext(context);
    if (
      context.reduce(
        (bytes, message) =>
          bytes + (message.files ?? []).reduce((sum, file) => sum + file.characters, 0),
        0,
      ) > MAX_BUFFERED_BODY_BYTES
    )
      throw new DocumentError('本次文档内容超过单次模型请求的内存保护大小，请选择页码或片段。');
    const documentData = new Map<string, string>();
    const documentSnapshots = new Map<string, DocumentInputSnapshot>();
    for (const message of context)
      for (const file of message.files ?? []) {
        if (documentData.has(documentKey(file))) continue;
        if (!loadDocument) throw new DocumentError('无法读取已保存的文件解析结果。');
        signal.throwIfAborted();
        const loaded = await loadDocument(file),
          text = typeof loaded === 'string' ? loaded : loaded.text;
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        const sha256 = Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        if (
          text.length !== file.characters ||
          estimateDocumentTokens(file, text) !== file.tokens ||
          sha256 !== file.textSha256
        )
          throw new DocumentError('文件解析内容与已保存的引用不符。');
        const prompt = documentPrompt(file, text);
        if (typeof loaded !== 'string' && loaded.inputSnapshot) {
          if (
            loaded.inputSnapshot.sha256 !== inputHash(prompt) ||
            loaded.inputSnapshot.characters !== prompt.length ||
            loaded.inputSnapshot.bytes !== Buffer.byteLength(prompt)
          )
            throw new DocumentError('文件输入快照与实际输入不符。');
          documentSnapshots.set(documentKey(file), loaded.inputSnapshot);
        }
        documentData.set(documentKey(file), prompt);
        secrets.push(text);
      }
    const imageData = new Map<string, Uint8Array>();
    for (const message of context)
      for (const image of message.images ?? []) {
        if (imageData.has(image.attachmentId)) continue;
        if (!loadImage) throw new ImageContextError('无法读取已保存图片。');
        signal.throwIfAborted();
        const data = await loadImage(image);
        if (data.byteLength !== image.size) throw new ImageContextError('图片长度校验失败。');
        assertChatImage(data, image.mediaType);
        imageData.set(image.attachmentId, data);
      }
    signal.throwIfAborted();
    const prompt: ModelMessage[] = [
      ...(config.systemPrompt ? [{ role: 'system' as const, content: config.systemPrompt }] : []),
      ...context.map((message) =>
        message.role === 'system'
          ? { role: message.role, content: message.content }
          : {
              role: message.role,
              content: [
                ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
                ...(message.files ?? []).map((file) => ({
                  type: 'text' as const,
                  text: documentData.get(documentKey(file))!,
                })),
                ...(message.images ?? []).map((image) => ({
                  type: 'file' as const,
                  mediaType: image.mediaType,
                  data: imageData.get(image.attachmentId)!,
                })),
              ],
            },
      ),
    ];
    if (toolRequest)
      prompt.push(...providerToolPrompt(toolRequest.exchanges ?? [], toolRequest.enabled, config));
    if (beforeRequest)
      assembled = assembledInput(config, context, toolRequest, documentData, documentSnapshots);
    const result = await coreProviderStream(
      providerModel(config, request),
      config,
      prompt,
      signal,
      toolRequest,
    );
    return providerEvents(
      result.stream,
      config,
      guard,
      signal,
      secrets,
      () => responseHeaders,
      result.native,
      onOutput,
    );
  } catch (error) {
    await guard.cancel();
    if (error instanceof ImageContextError || error instanceof DocumentError)
      throw new ProviderError(error.message);
    if (error instanceof ProviderError || error instanceof GenerationCancelled) throw error;
    if (signal.aborted)
      throw new ProviderError('模型供应商连接已中断。', providerFailure(config, 'connect'));
    throw sdkProviderError(error, config, 'connect', responseHeaders, secrets);
  }
}
