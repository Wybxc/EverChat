import * as v from 'valibot';
import { ATTACHMENT_MEDIA_TYPES, attachmentInputSchema } from './files';

export const MAX_TOOL_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_TOOL_ARTIFACTS = 8;
export const toolArtifactSchema = v.strictObject({
  type: v.literal('artifact'),
  attachmentId: attachmentInputSchema.entries.id,
  name: attachmentInputSchema.entries.name,
  mediaType: v.picklist([...ATTACHMENT_MEDIA_TYPES, 'application/octet-stream']),
  size: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(MAX_TOOL_ARTIFACT_BYTES)),
  sha256: attachmentInputSchema.entries.sha256,
});
export type ToolArtifact = v.InferOutput<typeof toolArtifactSchema>;

export function mergeToolArtifacts(
  before: readonly ToolArtifact[],
  added: readonly ToolArtifact[],
) {
  return [...new Map([...before, ...added].map((part) => [part.attachmentId, part])).values()];
}
