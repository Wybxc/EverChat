import * as v from 'valibot';

const version = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const updatedAt = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const conversationActivitySchema = v.variant('status', [
  v.strictObject({ status: v.literal('idle'), version, updatedAt }),
  v.strictObject({
    status: v.picklist(['queued', 'running', 'stopping']),
    version,
    updatedAt,
    messageId: v.pipe(v.string(), v.uuid()),
    runId: v.pipe(v.string(), v.uuid()),
  }),
]);
export type ConversationActivity = v.InferOutput<typeof conversationActivitySchema>;
export type ActivityIndex = Record<string, ConversationActivity>;

/** Keep idle watermarks too: an old running report must never resurrect a finished task. */
export function mergeActivity(
  index: ActivityIndex,
  id: string,
  next: ConversationActivity,
): ActivityIndex {
  if (
    !Number.isSafeInteger(next.version) ||
    next.version < 1 ||
    (index[id]?.version ?? 0) >= next.version
  )
    return index;
  return { ...index, [id]: next };
}
