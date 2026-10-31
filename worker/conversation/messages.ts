import { type DocumentPart } from '../../shared/attachments/documents';
import { type ImagePart } from '../../shared/attachments/images';
import {
  messageFiles,
  messageImages,
  messageParts,
  messageText,
} from '../../shared/conversation/content';
import { isActive } from '../../shared/conversation/message-state';
import { branchPath } from '../../shared/conversation/branch-path';
import { conversationSettingsDefaults } from '../../shared/conversation/settings';
import type { ConversationSettings, Message } from '../../shared/conversation/types';
import type { ProviderConfig } from '../../shared/providers/types';
import type { SearchDocument } from '../../shared/search/query';
import { STREAM_VERSION, payloadBytes } from '../../shared/streaming/batches';
import type { Change, Snapshot } from '../../shared/streaming/protocol';
import { type PublicToolTask } from '../../shared/web-tools/tasks';
import type { SqlQuery } from '../generation/metrics';
import type { ConversationActivityJournal } from './activity';
import { ConversationState } from './state';
import { GenerationCheckpoints } from '../streaming/checkpoints';
import { GenerationProgressStore } from '../generation/progress';
import { answerStage } from '../../shared/conversation/continuation';

export type Row = Omit<Message, 'parts' | 'waitingForSummary'> & {
  content: string;
  reasoning: string | null;
  generationResult: string | null;
  summaryResult: string | null;
  imageResult?: string | null;
  fileResult?: string | null;
  toolResult?: string | null;
  continuationResult?: string | null;
  waitingForSummary?: string | null;
} & Record<string, SqlStorageValue>;

// All operations run in the owning DO's existing transaction and output gate.
export class ConversationMessages {
  constructor(
    private readonly query: SqlQuery,
    private readonly journal: GenerationCheckpoints,
    private readonly runConfig: (id: string) => string | null | undefined,
    _onEvent: (payload: string) => void,
    private readonly activity?: ConversationActivityJournal,
  ) {}
  decorate(row: Row, includeContent = true): Message {
    const {
      generationResult,
      summaryResult,
      imageResult,
      fileResult,
      toolResult,
      continuationResult,
      waitingForSummary,
      content,
      reasoning,
      ...message
    } = row;
    const text =
      includeContent && this.journal instanceof GenerationCheckpoints
        ? this.journal.read(message.id, content, reasoning ?? '')
        : { content, reasoning: reasoning ?? '' };
    return {
      ...message,
      ...(toolResult ? { tools: JSON.parse(toolResult) as PublicToolTask } : {}),
      ...(continuationResult
        ? { continuation: { stages: [], ...JSON.parse(continuationResult) } }
        : {}),
      parts: [
        ...messageParts(text.content, text.reasoning),
        ...(imageResult ? (JSON.parse(imageResult) as ImagePart[]) : []),
        ...(fileResult ? (JSON.parse(fileResult) as DocumentPart[]) : []),
      ],
      ...(generationResult
        ? { generation: JSON.parse(generationResult) as Message['generation'] }
        : {}),
      ...(summaryResult ? { summary: JSON.parse(summaryResult) as Message['summary'] } : {}),
      ...(waitingForSummary ? { waitingForSummary } : {}),
    };
  }

  materialize(message: Message): Message {
    if (!isActive(message) || !message.runId || message.streamVersion !== STREAM_VERSION)
      return message;
    const config = this.runConfig(message.runId);
    if (!config) return message;
    const descriptor = JSON.parse(config) as ProviderConfig;
    return this.journal.materialize(message, {
      protocol: message.tools ? 'openai-chat' : descriptor.provider,
    });
  }

  rows(metadataOnly = false) {
    const columns = metadataOnly
      ? "messages.id, messages.role, '' AS content, NULL AS reasoning, messages.status, messages.createdAt, messages.runId, messages.parentId, messages.revisionOf, messages.error, messages.providerId, messages.model, messages.modelName, messages.streamVersion, messages.durableOffset"
      : 'messages.*';
    const attachments = metadataOnly
      ? 'NULL AS imageResult, NULL AS fileResult, NULL AS toolResult'
      : 'message_images.payload AS imageResult, message_files.payload AS fileResult, message_web_tools.payload AS toolResult';
    return this.query<Row>(
      `SELECT ${columns}, message_continuations.payload AS continuationResult, message_deletions.deletedAt, message_generations.payload AS generationResult, message_summaries.payload AS summaryResult, ${attachments}, run_dependencies.summaryId AS waitingForSummary FROM messages LEFT JOIN message_continuations ON message_continuations.messageId = messages.id LEFT JOIN message_deletions ON message_deletions.id = messages.id LEFT JOIN message_generations ON message_generations.messageId = messages.id LEFT JOIN message_summaries ON message_summaries.messageId = messages.id LEFT JOIN message_images ON message_images.messageId = messages.id LEFT JOIN message_files ON message_files.messageId = messages.id LEFT JOIN message_web_tools ON message_web_tools.messageId = messages.id LEFT JOIN run_dependencies ON run_dependencies.runId = messages.runId ORDER BY messages.rowid`,
    );
  }

  all(): Message[] {
    const local = new Map(
      Array.from(this.rows(), (row) => {
        const message = this.decorate(row);
        return [message.id, message] as const;
      }),
    );
    return [...local.values()].map((message) => this.compose(this.materialize(message), local));
  }

  count(): number {
    return this.query<{ count: number }>('SELECT COUNT(*) AS count FROM messages').one().count;
  }

  forHead(headId: string | null | undefined): Message[] {
    const graph = Array.from(this.rows(true), (row) => this.decorate(row, false));
    let path: Message[];
    try {
      path = headId ? branchPath(graph, headId) : [];
    } catch {
      // Submission validation reports missing or cyclic parents without reading unrelated bodies.
      return graph;
    }
    const needed = new Set(path.map(({ id }) => id));
    for (const message of graph) {
      const source = message.summary?.sourceIds;
      if (
        !message.deletedAt &&
        source &&
        source.length <= path.length &&
        source.every((id, index) => path[index].id === id)
      )
        needed.add(message.id);
    }
    const local = new Map([...needed].map((id) => [id, this.rawMessage(id)!]));
    return graph.map((message) =>
      needed.has(message.id)
        ? this.compose(this.materialize(local.get(message.id)!), local)
        : message,
    );
  }

  settings(): ConversationSettings {
    const row = this.query<{ payload: string }>(
      'SELECT payload FROM conversation_settings WHERE id = 1',
    ).toArray()[0];
    return conversationSettingsDefaults(row ? JSON.parse(row.payload) : {});
  }

  writeSettings(settings: ConversationSettings) {
    this.query(
      'INSERT INTO conversation_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
      JSON.stringify(settings),
    );
  }

  rawMessage(id: string): Message | undefined {
    const row = this.query<Row>(
      'SELECT messages.*, message_continuations.payload AS continuationResult, message_deletions.deletedAt, message_generations.payload AS generationResult, message_summaries.payload AS summaryResult, message_images.payload AS imageResult, message_files.payload AS fileResult, message_web_tools.payload AS toolResult, run_dependencies.summaryId AS waitingForSummary FROM messages LEFT JOIN message_continuations ON message_continuations.messageId = messages.id LEFT JOIN message_deletions ON message_deletions.id = messages.id LEFT JOIN message_generations ON message_generations.messageId = messages.id LEFT JOIN message_summaries ON message_summaries.messageId = messages.id LEFT JOIN message_images ON message_images.messageId = messages.id LEFT JOIN message_files ON message_files.messageId = messages.id LEFT JOIN message_web_tools ON message_web_tools.messageId = messages.id LEFT JOIN run_dependencies ON run_dependencies.runId = messages.runId WHERE messages.id = ?',
      id,
    ).toArray()[0];
    return row && this.decorate(row);
  }

  message(id: string): Message | undefined {
    const message = this.rawMessage(id);
    return message && this.compose(this.materialize(message));
  }

  private compose(message: Message, cache = new Map<string, Message>()): Message {
    if (message.deletedAt)
      return {
        ...message,
        parts: [],
        tools: undefined,
        generation: undefined,
        continuation: undefined,
      };
    if (!message.continuation || message.continuation.detached) return message;
    const chain: Message[] = [],
      seen = new Set([message.id]);
    let current = message;
    while (current.continuation && !current.continuation.detached) {
      const id = current.continuation.sourceId;
      if (seen.has(id)) throw new Error('Cyclic answer continuation');
      seen.add(id);
      const source = cache.get(id) ?? this.rawMessage(id);
      if (!source) throw new Error('Missing answer continuation source');
      cache.set(id, source);
      chain.push(source);
      current = source;
    }
    chain.reverse();
    return {
      ...message,
      parts: messageParts(
        chain.map((part) => messageText(part)).join('') + messageText(message),
        chain.map((part) => messageText(part, 'reasoning')).join('') +
          messageText(message, 'reasoning'),
      ),
      continuation: {
        ...message.continuation,
        stages: chain.flatMap((part) =>
          part.continuation?.detached
            ? [...part.continuation.stages, answerStage(part)]
            : [answerStage({ ...part, continuation: undefined })],
        ),
      },
    };
  }

  retainSource(messageId: string) {
    return (
      this.query(
        'SELECT 1 FROM message_continuations WHERE sourceId=? LIMIT 1',
        messageId,
      ).toArray().length > 0
    );
  }
  pruneDeletedSources() {
    for (;;) {
      const rows = this.query<{ id: string }>(
        `SELECT m.id FROM messages m JOIN message_deletions d ON d.id=m.id
        WHERE NOT EXISTS (SELECT 1 FROM message_continuations c WHERE c.sourceId=m.id)
        AND (m.content!='' OR m.reasoning IS NOT NULL
          OR EXISTS (SELECT 1 FROM message_content_chunks WHERE messageId=m.id)
          OR EXISTS (SELECT 1 FROM message_continuations WHERE messageId=m.id)
          OR EXISTS (SELECT 1 FROM message_generations WHERE messageId=m.id)
          OR EXISTS (SELECT 1 FROM message_web_tools WHERE messageId=m.id))`,
      ).toArray();
      if (!rows.length) return;
      for (const { id } of rows) {
        this.query("UPDATE messages SET content='',reasoning=NULL,error=NULL WHERE id=?", id);
        this.journal.erase(id);
        this.query('DELETE FROM message_continuations WHERE messageId=?', id);
        this.query('DELETE FROM message_generations WHERE messageId=?', id);
        this.query('DELETE FROM message_web_tools WHERE messageId=?', id);
      }
    }
  }

  seq(): number {
    return new ConversationState(this.query).current().seq;
  }

  page(after: number) {
    const rows = this.query<{ id: string; ordinal: number }>(
      'SELECT id, rowid AS ordinal FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 32',
      after,
    ).toArray();
    const messages: Message[] = [];
    let bytes = 0,
      cursor = after;
    for (const row of rows) {
      const message = this.message(row.id)!;
      const size = payloadBytes(JSON.stringify(message));
      if (messages.length && bytes + size > 1024 * 1024) break;
      messages.push(message);
      bytes += size;
      cursor = row.ordinal;
    }
    const done = !this.query('SELECT id FROM messages WHERE rowid > ? LIMIT 1', cursor).toArray()
      .length;
    return { snapshot: { ...this.snapshotHeader(), messages }, after: cursor, done };
  }

  snapshot(): Snapshot {
    const activity = this.activity?.snapshot();
    return {
      messages: this.all(),
      seq: this.seq(),
      epoch: new ConversationState(this.query).current().epoch,
      settings: this.settings(),
      ...(activity ? { activity } : {}),
    };
  }

  record(messages: Message[], conversationId?: string, settings?: ConversationSettings): Change {
    messages = messages.map((message) =>
      message.deletedAt ||
      (message.continuation &&
        !message.continuation.detached &&
        !message.continuation.stages.length)
        ? this.compose(message)
        : message,
    );
    const activity = this.activity?.record();
    const seq = this.advance(messages.map((message) => message.id));
    if (conversationId)
      for (const message of messages)
        if (!isActive(message) && !message.summary) {
          this.query(
            'INSERT INTO message_search_versions VALUES (?, ?) ON CONFLICT(messageId) DO UPDATE SET version = excluded.version',
            message.id,
            seq,
          );
          this.query(
            'INSERT INTO search_outbox VALUES (?, ?, ?) ON CONFLICT(messageId) DO UPDATE SET version = excluded.version',
            message.id,
            conversationId,
            seq,
          );
        }
    return {
      type: 'change',
      seq,
      messages,
      ...(settings ? { settings } : {}),
      ...(activity ? { activity } : {}),
    };
  }

  searchDocument(message: Message, version: number): SearchDocument {
    return {
      messageId: message.id,
      version,
      role: message.role,
      content: messageText(message),
      reasoning: messageText(message, 'reasoning'),
    };
  }

  advance(ids: string[]): number {
    return new ConversationState(this.query).advance(ids);
  }

  changes(after: number): Snapshot;
  changes(after: number, maxBytes: number): Snapshot | undefined;
  changes(after: number, maxBytes = Infinity): Snapshot | undefined {
    const ids = new Set(
      this.query<{ messageId: string }>(
        'SELECT messageId FROM message_versions WHERE version > ?',
        after,
      )
        .toArray()
        .map((row) => row.messageId),
    );
    const messages: Message[] = [];
    let bytes = 0;
    for (const id of ids) {
      const message = this.message(id);
      if (!message) continue;
      bytes += payloadBytes(JSON.stringify(message));
      if (bytes > maxBytes) return undefined;
      messages.push(message);
    }
    return { ...this.snapshotHeader(), messages };
  }

  private snapshotHeader() {
    return {
      ...new ConversationState(this.query).current(),
      settings: this.settings(),
      activity: this.activity?.snapshot(),
    };
  }

  insert(message: Message) {
    this.query(
      'INSERT INTO messages (id, role, content, status, createdAt, runId, parentId, revisionOf, error, providerId, model, modelName, reasoning, streamVersion, durableOffset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      message.id,
      message.role,
      messageText(message),
      message.status,
      message.createdAt,
      message.runId,
      message.parentId,
      message.revisionOf,
      message.error,
      message.providerId ?? null,
      message.model ?? null,
      message.modelName ?? null,
      messageText(message, 'reasoning'),
      message.streamVersion ?? null,
      message.durableOffset ?? 0,
    );
    if (message.role === 'assistant' && isActive(message) && !message.deletedAt)
      new GenerationProgressStore(this.query).begin(message.id, message.createdAt);
    if (message.continuation) {
      const { stages, ...reference } = message.continuation;
      this.query(
        'INSERT INTO message_continuations VALUES (?, ?, ?)',
        message.id,
        reference.detached ? '' : reference.sourceId,
        JSON.stringify({ ...reference, ...(reference.detached ? { stages } : {}) }),
      );
    }
    if (message.role === 'assistant' && !message.deletedAt && message.generation)
      this.query(
        'INSERT INTO message_generations VALUES (?, ?)',
        message.id,
        JSON.stringify(message.generation),
      );
    if (message.summary)
      this.query(
        'INSERT INTO message_summaries VALUES (?, ?)',
        message.id,
        JSON.stringify(message.summary),
      );
    if (messageFiles(message).length && !message.deletedAt)
      this.query(
        'INSERT INTO message_files VALUES (?, ?)',
        message.id,
        JSON.stringify(messageFiles(message)),
      );
    if (message.tools && !message.deletedAt)
      this.query(
        'INSERT INTO message_web_tools VALUES (?, ?, ?, ?, ?)',
        message.id,
        crypto.randomUUID(),
        '[]',
        '',
        JSON.stringify(message.tools),
      );
    if (messageImages(message).length && !message.deletedAt)
      this.query(
        'INSERT INTO message_images VALUES (?, ?)',
        message.id,
        JSON.stringify(messageImages(message)),
      );
  }
}
