import { type DocumentPart } from '../../shared/attachments/documents';
import { type ImagePart } from '../../shared/attachments/images';
import {
  messageFiles,
  messageImages,
  messageParts,
  messageText,
} from '../../shared/conversation/content';
import { isActive } from '../../shared/conversation/message-state';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../shared/conversation/settings';
import type { ConversationSettings, Message } from '../../shared/conversation/types';
import type { ProviderConfig } from '../../shared/providers/types';
import type { SearchDocument } from '../../shared/search/query';
import { STREAM_VERSION } from '../../shared/streaming/batches';
import type { Change, Snapshot } from '../../shared/streaming/protocol';
import { type PublicToolTask } from '../../shared/web-tools/tasks';
import type { SqlQuery } from '../generation/metrics';
import { StreamJournal } from '../streaming/journal';

export type Row = Omit<Message, 'parts' | 'waitingForSummary'> & {
  content: string;
  reasoning: string | null;
  generationResult: string | null;
  summaryResult: string | null;
  imageResult?: string | null;
  fileResult?: string | null;
  toolResult?: string | null;
  waitingForSummary?: string | null;
} & Record<string, SqlStorageValue>;

// All operations run in the owning DO's existing transaction and output gate.
export class ConversationMessages {
  constructor(
    private readonly query: SqlQuery,
    private readonly journal: StreamJournal,
    private readonly runConfig: (id: string) => string | null | undefined,
    private readonly onEvent: (payload: string) => void,
  ) {}
  decorate(row: Row): Message {
    const {
      generationResult,
      summaryResult,
      imageResult,
      fileResult,
      toolResult,
      waitingForSummary,
      content,
      reasoning,
      ...message
    } = row;
    return {
      ...message,
      ...(toolResult && !message.deletedAt
        ? { tools: JSON.parse(toolResult) as PublicToolTask }
        : {}),
      parts: [
        ...messageParts(content, reasoning ?? ''),
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

  rows() {
    return this.query<Row>(
      'SELECT messages.*, message_deletions.deletedAt, message_generations.payload AS generationResult, message_summaries.payload AS summaryResult, message_images.payload AS imageResult, message_files.payload AS fileResult, message_web_tools.payload AS toolResult, run_dependencies.summaryId AS waitingForSummary FROM messages LEFT JOIN message_deletions ON message_deletions.id = messages.id LEFT JOIN message_generations ON message_generations.messageId = messages.id LEFT JOIN message_summaries ON message_summaries.messageId = messages.id LEFT JOIN message_images ON message_images.messageId = messages.id LEFT JOIN message_files ON message_files.messageId = messages.id LEFT JOIN message_web_tools ON message_web_tools.messageId = messages.id LEFT JOIN run_dependencies ON run_dependencies.runId = messages.runId ORDER BY messages.rowid',
    );
  }

  all(): Message[] {
    return Array.from(this.rows(), (row) => this.materialize(this.decorate(row)));
  }

  settings(): ConversationSettings {
    const row = this.query<{ payload: string }>(
      'SELECT payload FROM conversation_settings WHERE id = 1',
    ).toArray()[0];
    return {
      ...DEFAULT_CONVERSATION_SETTINGS,
      ...(row ? (JSON.parse(row.payload) as ConversationSettings) : {}),
    };
  }

  writeSettings(settings: ConversationSettings) {
    this.query(
      'INSERT INTO conversation_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
      JSON.stringify(settings),
    );
  }

  rawMessage(id: string): Message | undefined {
    const row = this.query<Row>(
      'SELECT messages.*, message_deletions.deletedAt, message_generations.payload AS generationResult, message_summaries.payload AS summaryResult, message_images.payload AS imageResult, message_files.payload AS fileResult, message_web_tools.payload AS toolResult, run_dependencies.summaryId AS waitingForSummary FROM messages LEFT JOIN message_deletions ON message_deletions.id = messages.id LEFT JOIN message_generations ON message_generations.messageId = messages.id LEFT JOIN message_summaries ON message_summaries.messageId = messages.id LEFT JOIN message_images ON message_images.messageId = messages.id LEFT JOIN message_files ON message_files.messageId = messages.id LEFT JOIN message_web_tools ON message_web_tools.messageId = messages.id LEFT JOIN run_dependencies ON run_dependencies.runId = messages.runId WHERE messages.id = ?',
      id,
    ).toArray()[0];
    return row && this.decorate(row);
  }

  message(id: string): Message | undefined {
    const message = this.rawMessage(id);
    return message && this.materialize(message);
  }

  seq(): number {
    return this.query<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').one().seq;
  }

  snapshot(): Snapshot {
    return { messages: this.all(), seq: this.seq(), settings: this.settings() };
  }

  record(messages: Message[], conversationId?: string, settings?: ConversationSettings): Change {
    const seq = this.recordPayload(JSON.stringify(settings ? { messages, settings } : messages));
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
    return { type: 'change', seq, messages, ...(settings ? { settings } : {}) };
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

  recordPayload(payload: string): number {
    this.onEvent(payload);
    this.query('INSERT INTO events (payload) VALUES (?)', payload);
    const seq = this.seq();
    this.query('DELETE FROM events WHERE seq < ?', seq - 500);
    return seq;
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
