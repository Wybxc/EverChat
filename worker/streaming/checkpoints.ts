import { createHash } from 'node:crypto';
import { messageText } from '../../shared/conversation/content';
import { MAX_SQL_PAYLOAD_BYTES } from '../../shared/conversation/limits';
import type { Message } from '../../shared/conversation/types';
import { AppError, problem } from '../../shared/errors/descriptor';
import type { ProviderKind } from '../../shared/providers/types';
import { payloadBytes, validateBatch, validateCommit } from '../../shared/streaming/batches';
import type { StreamCommit } from '../../shared/streaming/protocol';
import { ProviderStream, type StreamState } from '../../shared/streaming/provider-stream';
import type { SqlQuery } from '../generation/metrics';
import { GenerationProgressStore } from '../generation/progress';

export const CHECKPOINT_SCHEMA = `CREATE TABLE IF NOT EXISTS generation_checkpoints (
  runId TEXT PRIMARY KEY, messageId TEXT NOT NULL, chunkSeq INTEGER NOT NULL,
  rawOffset INTEGER NOT NULL, state TEXT NOT NULL, digest TEXT NOT NULL
)`;
export const CONTENT_CHUNKS_SCHEMA = `CREATE TABLE IF NOT EXISTS message_content_chunks (
  messageId TEXT NOT NULL, channel TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(messageId, channel, ordinal)
) WITHOUT ROWID`;
const CHUNK_CHARACTERS = 4096;
type Checkpoint = {
  runId: string;
  messageId: string;
  chunkSeq: number;
  rawOffset: number;
  state: string;
  digest: string;
} & Record<string, SqlStorageValue>;

export interface PreparedCheckpoint {
  /** Synchronous writes only; the owning DO calls this inside transactionSync. */
  apply(): boolean;
  /** Also required after a failed transaction: an advanced decoder is not durable. */
  discard(): void;
}

const sameCheckpoint = (a: Checkpoint | undefined, b: Checkpoint | undefined) =>
  !a || !b
    ? a === b
    : a.messageId === b.messageId &&
      a.chunkSeq === b.chunkSeq &&
      a.rawOffset === b.rawOffset &&
      a.digest === b.digest;

// The public stream has one canonical semantic representation. Only the unfinished
// protocol state survives alongside it; the wire history is never persisted.
export class GenerationCheckpoints {
  private parsers = new Map<string, { offset: number; parser: ProviderStream }>();
  private preparing = new Map<string, symbol>();
  constructor(private readonly store: SqlQuery) {}
  page(messageId: string, channel: 'content' | 'reasoning', offset: number, limit = 8192) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 2)
      return { error: 'invalid_cursor' as const };
    // Read only the last bounded chunk to validate a cursor against the actual
    // UTF-16 length. SQLite length() counts code points, not JS string offsets.
    const tail = this.store<{ ordinal: number; payload: string }>(
      'SELECT ordinal,payload FROM message_content_chunks WHERE messageId=? AND channel=? ORDER BY ordinal DESC LIMIT 1',
      messageId,
      channel,
    ).toArray()[0];
    let baseContent = '';
    const length = tail
      ? tail.ordinal * CHUNK_CHARACTERS + (JSON.parse(tail.payload) as string).length
      : ((baseContent =
          this.store<{ value: string | null }>(
            `SELECT ${channel === 'content' ? 'content' : 'reasoning'} AS value FROM messages WHERE id=?`,
            messageId,
          ).toArray()[0]?.value ?? ''),
        baseContent.length);
    if (offset > length) return { error: 'invalid_cursor' as const };
    const ordinal = Math.floor(offset / CHUNK_CHARACTERS);
    const rows = this.store<{ payload: string }>(
      'SELECT payload FROM message_content_chunks WHERE messageId=? AND channel=? AND ordinal>=? AND ordinal<=? ORDER BY ordinal',
      messageId,
      channel,
      ordinal,
      Math.floor((offset + limit + 1) / CHUNK_CHARACTERS),
    ).toArray();
    let value: string;
    if (rows.length)
      value = rows
        .map(({ payload }) => JSON.parse(payload) as string)
        .join('')
        .slice(offset % CHUNK_CHARACTERS);
    else value = baseContent.slice(offset);
    if (offset > 0 && /^[\uDC00-\uDFFF]/.test(value)) return { error: 'invalid_cursor' as const };
    let end = Math.min(value.length, limit);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    return {
      text: value.slice(0, end),
      hasMore: offset + end < length,
      nextOffset: offset + end,
    };
  }
  read(messageId: string, content = '', reasoning = '') {
    const chunks = this.store<{ channel: string; payload: string }>(
      'SELECT channel, payload FROM message_content_chunks WHERE messageId = ? ORDER BY channel, ordinal',
      messageId,
    ).toArray();
    if (!chunks.length) return { content, reasoning };
    const parts = { content: '', reasoning: '' };
    for (const row of chunks)
      parts[row.channel as keyof typeof parts] += JSON.parse(row.payload) as string;
    return parts;
  }
  private row(runId: string) {
    return this.store<Checkpoint>(
      'SELECT * FROM generation_checkpoints WHERE runId = ?',
      runId,
    ).toArray()[0];
  }
  forget(runId: string) {
    this.parsers.delete(runId);
    this.preparing.delete(runId);
  }
  async prepare(
    commit: StreamCommit,
    descriptor?: { protocol: ProviderKind },
  ): Promise<PreparedCheckpoint> {
    const payload = validateCommit(commit),
      first = commit.batches[0],
      last = commit.batches.at(-1)!;
    const digest = createHash('sha256').update(payload).digest('hex');
    const previous = this.row(commit.runId);
    if (previous && previous.messageId !== commit.messageId)
      throw new Error('Stream checkpoint identity mismatch');
    if (previous && last.chunkSeq <= previous.chunkSeq) {
      if (
        last.chunkSeq === previous.chunkSeq &&
        (last.endOffset !== previous.rawOffset || previous.digest !== digest)
      )
        throw new Error('Conflicting stream commit');
      return {
        apply: () => {
          if (!sameCheckpoint(previous, this.row(commit.runId)))
            throw new Error('Stream checkpoint changed during preparation');
          return false;
        },
        discard() {},
      };
    }
    if (
      first.chunkSeq !== (previous?.chunkSeq ?? 0) + 1 ||
      first.startOffset !== (previous?.rawOffset ?? 0)
    )
      throw new Error('Stream sequence or offset gap');
    if (this.preparing.has(commit.runId)) throw new Error('Await the previous stream checkpoint');
    const token = Symbol(commit.runId);
    this.preparing.set(commit.runId, token);
    let cached = this.parsers.get(commit.runId);
    // The decoder being advanced is exclusively owned by this preparation. A
    // snapshot read can only see SQLite's last confirmed content and state.
    this.parsers.delete(commit.runId);
    try {
      let before: { content: string; reasoning: string };
      if (cached && cached.offset === (previous?.rawOffset ?? 0)) {
        before = { content: cached.parser.content, reasoning: cached.parser.reasoning };
      } else {
        const raw = this.store<{ content: string; reasoning: string | null }>(
          'SELECT content, reasoning FROM messages WHERE id = ?',
          commit.messageId,
        ).one();
        before = this.read(commit.messageId, raw.content, raw.reasoning ?? '');
        const state = previous ? (JSON.parse(previous.state) as StreamState) : undefined;
        cached = {
          offset: previous?.rawOffset ?? 0,
          parser: new ProviderStream(
            state?.protocol ?? descriptor?.protocol ?? 'openai-chat',
            true,
            state,
            before.content,
            before.reasoning,
          ),
        };
      }
      const parser = cached.parser;
      for (const batch of commit.batches) {
        parser.feed(validateBatch(batch));
        parser.drainDeltas();
      }
      const state = JSON.stringify(parser.checkpoint());
      if (payloadBytes(state) > MAX_SQL_PAYLOAD_BYTES - 4096)
        throw new AppError(problem('REQUEST_TOO_LARGE'), '生成解析检查点超过存储保护大小。');
      const fromChunks =
        this.store(
          'SELECT 1 FROM message_content_chunks WHERE messageId = ? LIMIT 1',
          commit.messageId,
        ).toArray().length > 0;
      let applied = false;
      return {
        apply: () => {
          if (
            applied ||
            this.preparing.get(commit.runId) !== token ||
            !sameCheckpoint(previous, this.row(commit.runId))
          )
            throw new Error('Stream checkpoint changed during preparation');
          try {
            this.writeChannel(
              commit.messageId,
              'content',
              fromChunks ? before.content : '',
              parser.content,
            );
            this.writeChannel(
              commit.messageId,
              'reasoning',
              fromChunks ? before.reasoning : '',
              parser.reasoning,
            );
            this.store(
              'UPDATE messages SET content = ?, reasoning = ?, durableOffset = ? WHERE id = ?',
              '',
              '',
              last.endOffset,
              commit.messageId,
            );
            this.store(
              'INSERT INTO generation_checkpoints VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(runId) DO UPDATE SET chunkSeq = excluded.chunkSeq, rawOffset = excluded.rawOffset, state = excluded.state, digest = excluded.digest',
              commit.runId,
              commit.messageId,
              last.chunkSeq,
              last.endOffset,
              state,
              digest,
            );
            new GenerationProgressStore(this.store).content(commit.messageId, {
              content: {
                length: parser.content.length,
                replaced: !parser.content.startsWith(before.content),
              },
              reasoning: {
                length: parser.reasoning.length,
                replaced: !parser.reasoning.startsWith(before.reasoning),
              },
            });
            this.parsers.set(commit.runId, { offset: last.endOffset, parser });
            this.preparing.delete(commit.runId);
            applied = true;
            return true;
          } catch (error) {
            this.forget(commit.runId);
            throw error;
          }
        },
        discard: () => {
          if (
            this.preparing.get(commit.runId) === token ||
            this.parsers.get(commit.runId)?.parser === parser
          )
            this.forget(commit.runId);
        },
      };
    } catch (error) {
      this.forget(commit.runId);
      throw error;
    }
  }
  private writeChannel(
    messageId: string,
    channel: 'content' | 'reasoning',
    before: string,
    after: string,
  ) {
    if (before === after) return;
    let common = 0;
    if (after.startsWith(before)) common = before.length;
    else
      while (common < before.length && common < after.length && before[common] === after[common])
        common++;
    const start = Math.floor(common / CHUNK_CHARACTERS);
    if (common < before.length)
      this.store(
        'DELETE FROM message_content_chunks WHERE messageId = ? AND channel = ? AND ordinal >= ?',
        messageId,
        channel,
        start,
      );
    for (let index = start * CHUNK_CHARACTERS; index < after.length; index += CHUNK_CHARACTERS)
      this.store(
        'INSERT INTO message_content_chunks VALUES (?, ?, ?, ?) ON CONFLICT(messageId, channel, ordinal) DO UPDATE SET payload = excluded.payload',
        messageId,
        channel,
        index / CHUNK_CHARACTERS,
        JSON.stringify(after.slice(index, index + CHUNK_CHARACTERS)),
      );
  }
  materialize(message: Message, descriptor: { protocol: ProviderKind }): Message {
    const checkpoint = message.runId ? this.row(message.runId) : undefined;
    return {
      ...message,
      streamState: checkpoint
        ? (JSON.parse(checkpoint.state) as StreamState)
        : new ProviderStream(descriptor.protocol, true).checkpoint(),
      durableOffset: checkpoint?.rawOffset ?? message.durableOffset ?? 0,
    };
  }
  compact(message: Message) {
    const before = this.read(message.id);
    this.writeChannel(message.id, 'content', before.content, messageText(message));
    this.writeChannel(message.id, 'reasoning', before.reasoning, messageText(message, 'reasoning'));
    this.store(
      'UPDATE messages SET content = ?, reasoning = ?, durableOffset = ? WHERE id = ?',
      '',
      '',
      message.durableOffset ?? 0,
      message.id,
    );
    this.purge(message.runId!);
  }
  purge(runId: string) {
    this.store('DELETE FROM generation_checkpoints WHERE runId = ?', runId);
    this.forget(runId);
  }
  erase(messageId: string) {
    this.store('DELETE FROM message_content_chunks WHERE messageId = ?', messageId);
  }
}
