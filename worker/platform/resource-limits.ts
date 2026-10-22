export const STORAGE_QUOTA_MESSAGE = '云端存储额度不足，暂时无法保存。请稍后重试或释放空间。';

// Match specific platform storage errors; never pass an upstream diagnostic to the browser.
export function storageErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (
    error.message.includes(STORAGE_QUOTA_MESSAGE) ||
    /\bSQLITE_FULL\b|database or disk is full/i.test(error.message)
  )
    return STORAGE_QUOTA_MESSAGE;
  return null;
}
