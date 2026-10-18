export type StoreKind = 'conversation' | 'library';
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
export const MIGRATION_TABLES: Record<StoreKind, string[]> = {
  conversation: [
    'storage_schema',
    'conversation_deletion',
    'messages',
    'submissions',
    'events',
    'stream_commits',
    'runs',
    'message_web_tools',
    'conversation_state',
    'message_versions',
    'generation_checkpoints',
    'message_content_chunks',
  ],
  library: [
    'storage_schema',
    'conversation_metadata',
    'conversation_copies',
    'web_tool_service',
    'web_tool_credentials',
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
