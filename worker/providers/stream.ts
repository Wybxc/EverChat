import {
  assertDocumentContext,
  DocumentError,
  documentPrompt,
  estimateDocumentTokens,
  type DocumentPart,
} from '../../shared/attachments/documents';
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { ChatInput, ProviderConfig } from '../../shared/providers/types';
import { GenerationCancelled, ProviderError } from '../generation/errors';
import {
  assertChatImage,
  assertImageContext,
  ImageContextError,
  type ImagePart,
} from '../../shared/attachments/images';
import { providerCallOptions, providerModel } from './sdk';
import { providerToolPrompt, webToolDefinitions, type ProviderToolRequest } from './tool-turn';
import { assertWebToolSupport } from '../../shared/web-tools/tasks';
import { httpProviderError, providerFailure } from './failure';
import { safeProviderStream } from './stream-errors';

export { GenerationCancelled, ProviderError } from '../generation/errors';

export async function openProviderStream(
  config: ProviderConfig,
  context: ChatInput[],
  signal: AbortSignal,
  loadImage?: (image: ImagePart) => Promise<Uint8Array>,
  loadDocument?: (file: DocumentPart) => Promise<string>,
  toolRequest?: ProviderToolRequest,
  beforeRequest?: () => Promise<void>,
): Promise<ReadableStream<Uint8Array>> {
  if (!config.apiKey)
    throw new ProviderError('尚未配置供应商 API 密钥。', providerFailure(config, 'connect'));
  const secrets = context.map((message) => message.content);
  let prepared: { input: Parameters<typeof fetch>[0]; init?: RequestInit } | undefined;
  // Use the SDK to construct the request, without giving its parser the live supplier body.
  const capture: typeof fetch = async (input, init) => {
    if (prepared) throw new Error('Unexpected second provider request');
    prepared = { input, init };
    return new Response('', { headers: { 'Content-Type': 'text/event-stream' } });
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
    const documentData = new Map<string, string>();
    for (const message of context)
      for (const file of message.files ?? []) {
        if (documentData.has(file.attachmentId)) continue;
        if (!loadDocument) throw new DocumentError('无法读取已保存的文件解析结果。');
        signal.throwIfAborted();
        const text = await loadDocument(file);
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
        documentData.set(file.attachmentId, documentPrompt(file, text));
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
    const prompt: LanguageModelV4Prompt = [
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
                  text: documentData.get(file.attachmentId)!,
                })),
                ...(message.images ?? []).map((image) => ({
                  type: 'file' as const,
                  mediaType: image.mediaType,
                  data: { type: 'data' as const, data: imageData.get(image.attachmentId)! },
                })),
              ],
            },
      ),
    ];
    if (toolRequest)
      prompt.push(...providerToolPrompt(toolRequest.exchanges ?? [], toolRequest.enabled, config));
    const placeholder = await providerModel(config, capture).doStream(
      providerCallOptions(
        config,
        prompt,
        signal,
        toolRequest ? webToolDefinitions(toolRequest.enabled) : undefined,
      ),
    );
    const reader = placeholder.stream.getReader();
    try {
      while (!(await reader.read()).done) {
        /* Empty local response, never the supplier stream. */
      }
    } finally {
      reader.releaseLock();
    }
    if (!prepared) throw new Error('Missing provider request');
    signal.throwIfAborted();
    await beforeRequest?.();
    signal.throwIfAborted();
    const response = await globalThis.fetch(prepared.input, {
      ...prepared.init,
      signal,
      redirect: 'manual',
    });
    if (!response.ok) {
      throw await httpProviderError(response, config, secrets);
    }
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
    return safeProviderStream(response.body, config, secrets);
  } catch (error) {
    if (error instanceof ImageContextError || error instanceof DocumentError)
      throw new ProviderError(error.message);
    if (error instanceof ProviderError || error instanceof GenerationCancelled) throw error;
    if (signal.aborted)
      throw new ProviderError('模型供应商连接已中断。', providerFailure(config, 'connect'));
    throw new ProviderError(
      '无法连接模型供应商，请检查服务地址和网络。',
      providerFailure(config, 'connect'),
    );
  }
}
