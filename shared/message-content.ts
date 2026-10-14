import * as v from 'valibot';

/** Current channels are aggregated independently; parts do not imply SSE event order. */
export type MessagePart = { type: 'text'; text: string } | { type: 'reasoning'; text: string };

/** One nonempty part per channel, with reasoning before the answer. */
export function messageParts(text: string, reasoning = ''): MessagePart[] {
  const parts: MessagePart[] = [];
  if (reasoning) parts.push({ type: 'reasoning', text: reasoning });
  if (text) parts.push({ type: 'text', text });
  return parts;
}

export function messageText(message: { parts: readonly MessagePart[] } | undefined, type: MessagePart['type'] = 'text'): string {
  return message?.parts.find((part) => part.type === type)?.text ?? '';
}

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(100_000));
export const messagePartsSchema = v.pipe(
  v.array(v.variant('type', [
    v.strictObject({ type: v.literal('text'), text }),
    v.strictObject({ type: v.literal('reasoning'), text }),
  ])),
  v.maxLength(2),
  v.check((parts) => parts.length < 2 || (parts[0].type === 'reasoning' && parts[1].type === 'text'), '消息内容部分的顺序或类型重复。'),
);
