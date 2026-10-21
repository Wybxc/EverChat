export type StoreKind = 'conversation' | 'library' | 'usage';
export type WireValue = string | number | null | { blob: string };
export interface Statement {
  sql: string;
  args: WireValue[];
}
export interface TableSchema {
  name: string;
  sql: string;
}
export interface IndexSchema extends TableSchema {
  table: string;
}
export interface StorageSnapshot {
  schema: TableSchema[];
  indexes: IndexSchema[];
  rows: Record<string, Record<string, WireValue>[]>;
}
export const MIGRATION_TABLES: Record<StoreKind, string[]> = {
  usage: ['storage_schema', 'usage_attempts', 'usage_prices', 'usage_rollups'],
  conversation: [
    'storage_schema',
    'usage_outbox',
    'conversation_deletion',
    'messages',
    'submissions',
    'events',
    'stream_commits',
    'tool_stream_commits',
    'conversation_settings',
    'runs',
    'message_web_tools',
    'conversation_state',
    'message_versions',
    'generation_checkpoints',
    'message_content_chunks',
    'message_search_versions',
    'message_summaries',
    'message_deletions',
  ],
  library: [
    'mcp_requests',
    'mcp_keys',
    'storage_schema',
    'usage_outbox',
    'conversation_metadata',
    'conversation_copies',
    'web_tool_service',
    'web_tool_credentials',
    'conversations',
    'conversation_deletions',
    'archive_imports',
    'search_revision',
    'search_messages',
    'search_fields',
    'search_fts',
    'search_backfill',
    'search_problems',
  ],
};
export const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const encodeValue = (
  value: string | number | bigint | null | ArrayBuffer | ArrayBufferView,
): WireValue => {
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) throw new Error('SQL integer exceeds JavaScript precision');
    return numeric;
  }
  if (typeof value === 'string' || typeof value === 'number' || value === null) return value;
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  let binary = '';
  for (let at = 0; at < bytes.length; at += 8192)
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return { blob: btoa(binary) };
};
export const decodeValue = (value: WireValue) =>
  typeof value === 'object' && value !== null
    ? Uint8Array.from(atob(value.blob), (char) => char.charCodeAt(0))
    : value;
