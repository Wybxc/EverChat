import {
  AbstractChat,
  type ChatState,
  type ChatStatus,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { payloadBytes } from '../../shared/streaming/batches';
import {
  replayUIMessage,
  MAX_UI_APPLY_BYTES,
  type UIActiveBlock,
  type UIMessageCheckpoint,
} from '../../shared/streaming/ui-checkpoint';

const BARRIER = 'data-everchat-checkpoint-barrier';
const BLOCK = 'data-everchat-checkpoint-block';
type BlockChange = { type: 'text' | 'reasoning'; id: string; start: boolean } | 'reset';

/** The SDK owns parts; this store publishes immutable snapshots of one answer only. */
class AnswerState implements ChatState<UIMessage> {
  status: ChatStatus = 'ready';
  error: Error | undefined;
  messages: UIMessage[] = [];
  snapshot = <T>(value: T): T => {
    if (
      value &&
      typeof value === 'object' &&
      'id' in value &&
      'role' in value &&
      'parts' in value &&
      Array.isArray(value.parts)
    ) {
      const message = value as UIMessage;
      return { ...message, parts: message.parts.map((part) => ({ ...part })) } as T;
    }
    return value;
  };
  pushMessage = (message: UIMessage) => {
    if (this.messages.length) throw new Error('Only one answer can be reduced at a time');
    this.messages = [this.snapshot(message)];
  };
  popMessage = () => {
    this.messages = [];
  };
  replaceMessage = (index: number, message: UIMessage) => {
    if (index !== 0 || this.messages[0]?.id !== message.id)
      throw new Error('UI checkpoint identity mismatch');
    this.messages = [this.snapshot(message)];
  };
}

class AnswerChat extends AbstractChat<UIMessage> {}

/**
 * Apply a bounded batch with the public SDK UI processor before entering a
 * synchronous SQLite transaction. There is no model request or tool execution.
 * The caller owns commit/rollback, input validation and the durable checkpoint.
 */
export class UIMessageState {
  private readonly state = new AnswerState();
  private readonly chat: AnswerChat;
  private readonly processing: Promise<void>;
  private readonly controller: ReadableStreamDefaultController<UIMessageChunk>;
  private barrier = 0;
  private pending?: { id: number; resolve(): void; reject(error: Error): void };
  private failure?: Error;
  private closed = false;
  private readonly active = new Map<string, UIActiveBlock>();

  constructor(private readonly messageId: string) {
    let controller!: ReadableStreamDefaultController<UIMessageChunk>;
    const stream = new ReadableStream<UIMessageChunk>({
      start(value) {
        controller = value;
        controller.enqueue({ type: 'start', messageId });
      },
    });
    this.controller = controller;
    this.chat = new AnswerChat({
      id: messageId,
      state: this.state,
      transport: {
        resumeStreamIsReplay: true,
        async sendMessages() {
          throw new Error('A checkpoint reducer cannot submit a generation');
        },
        async reconnectToStream() {
          return stream;
        },
      },
      onError: (error) => this.fail(error),
      onData: (part) => {
        if (part.type === BLOCK) {
          this.trackBlock(part.data as BlockChange);
          return;
        }
        if (part.type !== BARRIER) return;
        const pending = this.pending;
        if (!pending || part.data !== pending.id) {
          this.fail(new Error('UI checkpoint barrier mismatch'));
          return;
        }
        this.pending = undefined;
        pending.resolve();
      },
    });
    this.processing = this.chat.resumeStream();
  }

  get message(): UIMessage | undefined {
    return this.state.messages[0];
  }

  checkpoint(): UIMessageCheckpoint {
    const message = this.message;
    if (!message || this.pending || this.failure)
      throw new Error('UI checkpoint batch has not been acknowledged');
    return {
      message,
      active: [...this.active.values()]
        .map((block) => ({ ...block }))
        .sort((a, b) => a.index - b.index),
    };
  }

  static async restore(checkpoint: UIMessageCheckpoint): Promise<UIMessageState> {
    const state = new UIMessageState(checkpoint.message.id);
    try {
      let batch: UIMessageChunk[] = [];
      let bytes = 2;
      for (const chunk of replayUIMessage(checkpoint)) {
        const length = payloadBytes(JSON.stringify(chunk));
        if (bytes + length + 1 > MAX_UI_APPLY_BYTES) {
          if (!batch.length) throw new Error('UI checkpoint part exceeds buffer limit');
          await state.apply(batch);
          batch = [];
          bytes = 2;
        }
        batch.push(chunk);
        bytes += length + 1;
      }
      if (batch.length) await state.apply(batch);
      return state;
    } catch (error) {
      await state.dispose();
      throw error;
    }
  }

  async apply(chunks: readonly UIMessageChunk[]): Promise<UIMessage> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('UI checkpoint reducer is closed');
    if (this.pending) throw new Error('Await the previous UI checkpoint batch');
    if (payloadBytes(JSON.stringify(chunks)) > MAX_UI_APPLY_BYTES)
      throw new Error('UI checkpoint batch exceeds buffer limit');
    for (const chunk of chunks) {
      if (chunk.type === BARRIER || chunk.type === BLOCK)
        throw new Error('Reserved UI checkpoint chunk');
      if (chunk.type === 'start' && chunk.messageId && chunk.messageId !== this.messageId)
        throw new Error('UI checkpoint identity mismatch');
    }
    const id = ++this.barrier;
    const applied = new Promise<void>((resolve, reject) => {
      this.pending = { id, resolve, reject };
    });
    try {
      for (const chunk of chunks) {
        this.controller.enqueue(chunk);
        let change: BlockChange | undefined;
        if (chunk.type === 'text-start' || chunk.type === 'reasoning-start')
          change = {
            type: chunk.type === 'text-start' ? 'text' : 'reasoning',
            id: chunk.id,
            start: true,
          };
        else if (chunk.type === 'text-end' || chunk.type === 'reasoning-end')
          change = {
            type: chunk.type === 'text-end' ? 'text' : 'reasoning',
            id: chunk.id,
            start: false,
          };
        else if (chunk.type === 'reset-step') change = 'reset';
        if (change) this.controller.enqueue({ type: BLOCK, data: change, transient: true });
      }
      // Step boundaries do not themselves write a snapshot. An empty metadata
      // update publishes the SDK's current state without adding a content part.
      this.controller.enqueue({ type: 'message-metadata', messageMetadata: {} });
      this.controller.enqueue({ type: BARRIER, data: id, transient: true });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('UI checkpoint input failed'));
    }
    await applied;
    if (this.failure) throw this.failure;
    const message = this.message;
    if (!message || message.id !== this.messageId) throw new Error('Missing UI checkpoint message');
    return message;
  }

  async close(): Promise<void> {
    if (this.pending) throw new Error('Await the previous UI checkpoint batch');
    if (!this.closed) {
      this.closed = true;
      if (!this.failure) this.controller.close();
    }
    await this.processing;
    if (this.failure) throw this.failure;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.pending?.reject(new Error('UI checkpoint reducer disposed'));
    this.pending = undefined;
    await this.chat.dispose();
    await this.processing;
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.pending?.reject(this.failure);
    this.pending = undefined;
  }

  private trackBlock(change: BlockChange) {
    if (change === 'reset') {
      this.active.clear();
      return;
    }
    const key = `${change.type}:${change.id}`;
    if (change.start) {
      if (this.active.has(key)) throw new Error('Duplicate UI active-block identity');
      const index = (this.message?.parts.length ?? 0) - 1;
      if (index < 0 || this.message?.parts[index].type !== change.type)
        throw new Error('UI active-block position mismatch');
      this.active.set(key, { type: change.type, id: change.id, index });
    } else if (!this.active.delete(key)) throw new Error('Missing UI active-block identity');
  }
}
