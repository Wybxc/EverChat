import * as v from 'valibot';

const time = v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0)));
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const generationPhases = [
  'queued',
  'preparing',
  'waiting_provider',
  'generating',
  'waiting_tools',
  'finalizing',
] as const;
export type GenerationPhase = (typeof generationPhases)[number];
export const generationProgressSchema = v.strictObject({
  phase: v.nullable(v.picklist(generationPhases)),
  acceptedAt: count,
  phaseStartedAt: count,
  providerRequestedAt: time,
  firstContentAt: time,
  lastProgressAt: count,
  lastContentAt: time,
  persistedAt: count,
  revision: count,
  content: v.strictObject({ length: count, epoch: count }),
  reasoning: v.strictObject({ length: count, epoch: count }),
});
export type GenerationProgress = v.InferOutput<typeof generationProgressSchema>;
