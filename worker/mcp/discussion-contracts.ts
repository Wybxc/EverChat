import * as v from 'valibot';
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const citationEntries = {
  messageRef: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
  revision: count,
  sha256: hash,
  range: v.optional(v.strictObject({ start: count, end: count })),
  quoteHash: v.optional(hash),
};
const citationCheck = (s: { range?: { start: number; end: number }; quoteHash?: string }) =>
  Boolean(s.range) === Boolean(s.quoteHash) && (!s.range || s.range.end > s.range.start);
export const discussionCitationSchema = v.pipe(
  v.strictObject(citationEntries),
  v.check((source) => citationCheck(source)),
);
export type DiscussionCitation = v.InferOutput<typeof discussionCitationSchema>;
export const discussionSchema = v.pipe(
  v.strictObject({
    mode: v.picklist(['independent', 'review']),
    background: v.optional(v.array(discussionCitationSchema), []),
    files: v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(2048))), []),
    targets: v.optional(
      v.array(
        v.pipe(
          v.strictObject({
            ...citationEntries,
            claimId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
          }),
          v.check((source) => citationCheck(source)),
        ),
      ),
    ),
  }),
  v.check((s) => (s.mode === 'review' ? Boolean(s.targets?.length) : !s.targets?.length)),
);
export type Discussion = v.InferOutput<typeof discussionSchema>;
