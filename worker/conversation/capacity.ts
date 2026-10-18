// Read-only accounting. Unsupported PRAGMAs fall back to the platform's allocated
// size; never assume that a deleted payload has already shrunk the database file.
export function databaseUsage(sql: SqlStorage) {
  const allocatedBytes = sql.databaseSize;
  try {
    const size = sql.exec<{ page_size: number }>('PRAGMA page_size').one().page_size;
    const free = sql.exec<{ freelist_count: number }>('PRAGMA freelist_count').one().freelist_count;
    if (
      Number.isSafeInteger(size) &&
      size > 0 &&
      Number.isSafeInteger(free) &&
      free >= 0 &&
      free * size <= allocatedBytes
    )
      return {
        allocatedBytes,
        usedBytes: allocatedBytes - free * size,
        reusableBytes: free * size,
      };
  } catch {
    /* The native runtime restricts some read-only SQLite introspection. */
  }
  return { allocatedBytes, usedBytes: allocatedBytes, reusableBytes: null };
}
