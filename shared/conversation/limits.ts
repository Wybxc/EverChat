// Cloudflare SQLite limits each row/string to 2,000,000 bytes. Leave space for
// IDs, metadata and serialization envelopes; this is a per-row bound, not a chat quota.
export const MAX_SQL_PAYLOAD_BYTES = 1_900_000;
export const MAX_MESSAGE_TEXT_BYTES = MAX_SQL_PAYLOAD_BYTES;
export const MAX_SYSTEM_PROMPT_LENGTH = MAX_SQL_PAYLOAD_BYTES;
export const MESSAGE_TEXT_LIMIT_MESSAGE = '消息正文与思考内容超过数据库单行存储大小。';

// Count JSON string contents, excluding the surrounding quotes. Control characters
// and lone surrogates must count their escaped size, not just their UTF-8 size.
const encoder = new TextEncoder();
export const jsonTextBytes = (text: string) => encoder.encode(JSON.stringify(text)).byteLength - 2;

export function textWithinBytes(text: string, maxBytes: number): string {
  if (jsonTextBytes(text) <= maxBytes) return text;
  let size = 0,
    length = 0;
  for (const point of text) {
    const code = point.codePointAt(0)!;
    const bytes =
      code === 34 ||
      code === 92 ||
      code === 8 ||
      code === 9 ||
      code === 10 ||
      code === 12 ||
      code === 13
        ? 2
        : code < 32 || (code >= 0xd800 && code <= 0xdfff)
          ? 6
          : code < 128
            ? 1
            : code < 2048
              ? 2
              : code < 65536
                ? 3
                : 4;
    if (size + bytes > maxBytes) break;
    size += bytes;
    length += point.length;
  }
  return text.slice(0, length);
}

export const messageTextFits = (text: string, reasoning = '') =>
  text.length + reasoning.length <= MAX_MESSAGE_TEXT_BYTES &&
  jsonTextBytes(text) + jsonTextBytes(reasoning) <= MAX_MESSAGE_TEXT_BYTES;
