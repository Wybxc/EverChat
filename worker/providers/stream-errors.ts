import { createParser } from 'eventsource-parser';
import { MAX_EVENT_CHARACTERS } from '../../shared/streaming/provider-stream';

// SDKs own protocol decoding. This guard only bounds SSE framing, validates UTF-8
// and records Chat Completions' sentinel (which SDK raw events omit).
export class ProviderWireGuard {
  chatDone = false;
  ended = false;
  private tail = '';
  private afterCR = false;
  private normalize(text: string) {
    if (!text) return text;
    const next = this.afterCR && text.startsWith('\n') ? text.slice(1) : text;
    this.afterCR = text.endsWith('\r');
    return next.replace(/\r\n|\r/g, '\n');
  }
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  private readonly parser = createParser({
    maxBufferSize: MAX_EVENT_CHARACTERS,
    onEvent: ({ data }) => {
      if (new TextEncoder().encode(data).length > MAX_EVENT_CHARACTERS)
        throw new Error('供应商单个流事件超过解析缓冲大小。');
      if (data === '[DONE]') this.chatDone = true;
    },
    onError: (error) => {
      if (error.type === 'max-buffer-size-exceeded')
        throw new Error('供应商单个流事件超过解析缓冲大小。');
    },
  });
  private feed(text: string) {
    this.parser.feed(text);
    const combined = this.tail + text;
    let lineStart = 0,
      boundary = 0;
    const endings = /\r\n|\r|\n/g;
    for (let match = endings.exec(combined); match; match = endings.exec(combined)) {
      if (match[0] === '\r' && match.index === combined.length - 1) break;
      const end = match.index + match[0].length;
      if (match.index === lineStart) boundary = end;
      lineStart = end;
    }
    this.tail = combined.slice(boundary);
    if (new TextEncoder().encode(this.tail).length > MAX_EVENT_CHARACTERS)
      throw new Error('供应商单个流事件超过解析缓冲大小。');
  }
  private stop?: () => Promise<void>;
  async cancel() {
    await this.stop?.();
  }
  wrap(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
    const reader = body.getReader();
    let stopped = false;
    const onAbort = () => void this.cancel();
    const release = () => {
      signal?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stop = async () => {
          if (stopped) return;
          stopped = true;
          try {
            controller.close();
          } catch {
            /* Already failed. */
          }
          await reader.cancel().catch(() => {});
          release();
        };
        if (signal?.aborted) void this.cancel();
        else signal?.addEventListener('abort', onAbort, { once: true });
      },
      pull: async (controller) => {
        while (!stopped) {
          try {
            const next = await reader.read();
            if (stopped) return;
            if (next.done) {
              this.feed(this.normalize(this.decoder.decode()));
              if (this.tail.trim()) throw new Error('供应商流在完整事件之前结束。');
              this.ended = true;
              stopped = true;
              release();
              controller.close();
              return;
            } else {
              const text = this.normalize(this.decoder.decode(next.value, { stream: true }));
              this.feed(text);
              if (text) {
                controller.enqueue(new TextEncoder().encode(text));
                return;
              }
            }
          } catch (error) {
            if (!stopped) {
              controller.error(error);
              await this.cancel();
            }
          }
        }
      },
      cancel: () => this.cancel(),
    });
  }
}
