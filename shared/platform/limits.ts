// Workers Free HTTP request bodies are limited to 100 MB by Cloudflare.
// This bounds one transfer, not accumulated chat/file storage.
export const MAX_HTTP_BODY_BYTES = 100_000_000;

// Whole-body parsing is different from streaming. Workers have 128 MB per
// isolate; allow for UTF-16 decoding, parsed objects, serialization and in-flight
// copies. This working-set guard does not limit saved files or usage counts.
export const MAX_BUFFERED_BODY_BYTES = 16 * 1024 * 1024;

// Plain UTF-8 text has no arbitrary JSON object graph. Keep its existing 32 MiB
// extraction ceiling as a working-set bound, independent of retained file totals.
export const MAX_BUFFERED_TEXT_BYTES = 32 * 1024 * 1024;
