import * as v from 'valibot';
const id = v.pipe(v.string(), v.uuid());
export const materialBindingSchema = v.strictObject({
  documentId: id,
  versionId: id,
  mode: v.picklist(['reuse', 'replace', 'include_both']),
  supersedes: v.nullable(id),
});
export type MaterialBinding = v.InferOutput<typeof materialBindingSchema>;
