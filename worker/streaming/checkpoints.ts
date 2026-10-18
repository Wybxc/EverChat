import { createHash } from 'node:crypto';
import { messageText } from '../../shared/conversation/content';
import type { Message } from '../../shared/conversation/types';
import { MAX_SQL_PAYLOAD_BYTES } from '../../shared/conversation/limits';
import type { ProviderKind } from '../../shared/providers/types';
import { payloadBytes, validateBatch, validateCommit } from '../../shared/streaming/batches';
import { ProviderStream, type StreamState } from '../../shared/streaming/provider-stream';
import type { StreamCommit } from '../../shared/streaming/protocol';
import type { SqlQuery } from '../generation/metrics';
import { StreamJournal } from './journal';

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

// The public stream has one canonical semantic representation. Only the unfinished
// protocol state survives alongside it; the wire history is never persisted.
export class GenerationCheckpoints extends StreamJournal {
  private parsers = new Map<string, { offset: number; parser: ProviderStream }>();
  constructor(private readonly store: SqlQuery) {
    super(store);
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
  }
  override append(commit: StreamCommit, descriptor?: { protocol: ProviderKind }) {
    const payload = validateCommit(commit),
      first = commit.batches[0],
      last = commit.batches.at(-1)!;
    const digest = createHash('sha256').update(payload).digest('hex');
    const previous = this.row(commit.runId);
    if (previous && last.chunkSeq <= previous.chunkSeq) {
      if (
        last.chunkSeq === previous.chunkSeq &&
        (last.endOffset !== previous.rawOffset || previous.digest !== digest)
      )
        throw new Error('Conflicting stream commit');
      return false;
    }
    if (
      first.chunkSeq !== (previous?.chunkSeq ?? 0) + 1 ||
      first.startOffset !== (previous?.rawOffset ?? 0)
    )
      throw new Error('Stream sequence or offset gap');
    let cached = this.parsers.get(commit.runId);
    let before: { content: string; reasoning: string };
    if (cached && cached.offset === (previous?.rawOffset ?? 0)) {
      before = { content: cached.parser.content, reasoning: cached.parser.reasoning };
    } else {
      const raw = this.store<{ content: string; reasoning: string | null }>(
        'SELECT content, reasoning FROM messages WHERE id = ?',
        commit.messageId,
      ).one();
      before = this.read(commit.messageId, raw.content, raw.reasoning ?? '');
    }
    if (!cached || cached.offset !== (previous?.rawOffset ?? 0)) {
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
    try {
      for (const batch of commit.batches) {
        cached.parser.feed(validateBatch(batch));
        cached.parser.drainDeltas();
      }
      const state = JSON.stringify(cached.parser.checkpoint());
      if (payloadBytes(state) > MAX_SQL_PAYLOAD_BYTES - 4096)
        throw new Error('生成解析检查点超过存储保护大小。');
      const fromChunks =
        this.store(
          'SELECT 1 FROM message_content_chunks WHERE messageId = ? LIMIT 1',
          commit.messageId,
        ).toArray().length > 0;
      this.writeChannel(
        commit.messageId,
        'content',
        fromChunks ? before.content : '',
        cached.parser.content,
      );
      this.writeChannel(
        commit.messageId,
        'reasoning',
        fromChunks ? before.reasoning : '',
        cached.parser.reasoning,
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
      this.parsers.set(commit.runId, { offset: last.endOffset, parser: cached.parser });
      return true;
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
  override materialize(message: Message, descriptor: { protocol: ProviderKind }): Message {
    const checkpoint = message.runId ? this.row(message.runId) : undefined;
    return {
      ...message,
      streamState: checkpoint
        ? (JSON.parse(checkpoint.state) as StreamState)
        : new ProviderStream(descriptor.protocol, true).checkpoint(),
      durableOffset: checkpoint?.rawOffset ?? message.durableOffset ?? 0,
    };
  }
  override compact(message: Message) {
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
  override purge(runId: string) {
    this.store('DELETE FROM generation_checkpoints WHERE runId = ?', runId);
    this.forget(runId);
  }
  erase(messageId: string) {
    this.store('DELETE FROM message_content_chunks WHERE messageId = ?', messageId);
  }
}
