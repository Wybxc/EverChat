export const MAX_CONVERSATIONS = 128;
export const MAX_MESSAGES = 1000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
// Reserve room for a new input, decoded output, incomplete SSE and protocol checkpoint.
export const MAX_HISTORY_START_BYTES = MAX_SNAPSHOT_BYTES - 4 * 1024 * 1024;
export const MAX_DATABASE_BYTES = 32 * 1024 * 1024;
export const MAX_DATABASE_START_BYTES = MAX_DATABASE_BYTES - 16 * 1024 * 1024;
// Keep room for atomically materializing the last committed prefix and its terminal event.
export const MAX_DATABASE_WRITE_BYTES = MAX_DATABASE_BYTES - 2 * 1024 * 1024;
export const HISTORY_LIMIT_MESSAGE = '这个对话已达到历史容量限制。已有内容仍可读取，请新建对话继续。';
export const DATABASE_LIMIT_MESSAGE = '这个对话已达到存储容量限制。已保留保存的内容，请新建对话继续。';
export const STORAGE_QUOTA_MESSAGE = '云端存储额度不足，暂时无法保存。请稍后重试或释放空间。';

// Match specific platform storage errors; never pass an upstream diagnostic to the browser.
export function storageErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error.message.includes(DATABASE_LIMIT_MESSAGE)) return DATABASE_LIMIT_MESSAGE;
  if (error.message.includes(STORAGE_QUOTA_MESSAGE) || /\bSQLITE_FULL\b|database or disk is full/i.test(error.message)) return STORAGE_QUOTA_MESSAGE;
  return null;
}
