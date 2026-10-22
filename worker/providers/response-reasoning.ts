import { MAX_MESSAGE_TEXT_BYTES, jsonTextBytes } from '../../shared/conversation/limits';
import type { GenerationEvent } from '../../shared/streaming/provider-stream';

// Narrow compatibility extension: SDK Responses adapters differ in which thought
// channel they expose. Prefer full text per item/part; summaries are a fallback.
export class ResponseReasoning {
  private readonly parts = new Map<string, { raw: string; summary: string }>();
  private bytes = 0;
  observe(event: Record<string, unknown>): GenerationEvent | undefined {
    if (
      event.type !== 'response.reasoning_text.delta' &&
      event.type !== 'response.reasoning_summary_text.delta'
    )
      return;
    if (typeof event.delta !== 'string' || !event.delta) return;
    if (typeof event.item_id !== 'string' || event.item_id.length > 200)
      throw new Error('供应商思考片段标识无效。');
    const index = event.content_index ?? event.summary_index ?? 0;
    if (!Number.isSafeInteger(index) || Number(index) < 0)
      throw new Error('供应商思考片段索引无效。');
    const id = `${event.item_id}:${index}`;
    let part = this.parts.get(id);
    if (!part) {
      part = { raw: '', summary: '' };
      this.parts.set(id, part);
    }
    const channel = event.type === 'response.reasoning_text.delta' ? 'raw' : 'summary';
    if (channel === 'summary' && part.raw) return;
    const replace =
      (channel === 'raw' && !!part.summary) || part !== [...this.parts.values()].at(-1);
    if (channel === 'raw' && part.summary) {
      this.bytes -= jsonTextBytes(part.summary);
      part.summary = '';
    }
    this.bytes += jsonTextBytes(event.delta);
    if (this.bytes > MAX_MESSAGE_TEXT_BYTES) throw new Error('供应商思考内容超过保存容量。');
    part[channel] += event.delta;
    return replace
      ? {
          type: 'reasoning',
          text: [...this.parts.values()].map((value) => value.raw || value.summary).join(''),
          replace: true,
        }
      : { type: 'reasoning', text: event.delta };
  }
}
