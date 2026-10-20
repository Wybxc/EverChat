import * as v from 'valibot';

// Public, bounded diagnostics only. Provider continuation metadata stays private.
export const generationDiagnosticsSchema = v.strictObject({
  warnings: v.pipe(v.array(v.pipe(v.string(), v.maxLength(512))), v.maxLength(8)),
  response: v.optional(
    v.strictObject({
      requestId: v.optional(v.pipe(v.string(), v.maxLength(200))),
      id: v.optional(v.pipe(v.string(), v.maxLength(200))),
      model: v.optional(v.pipe(v.string(), v.maxLength(200))),
      timestamp: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000)),
      ),
    }),
  ),
});
export type GenerationDiagnostics = v.InferOutput<typeof generationDiagnosticsSchema>;

/** Keep distinct warnings across tool rounds, and the latest response identity. */
export function mergeGenerationDiagnostics(
  previous: GenerationDiagnostics | undefined,
  current: GenerationDiagnostics | undefined,
): GenerationDiagnostics | undefined {
  if (!previous && !current) return;
  return {
    warnings: [...new Set([...(previous?.warnings ?? []), ...(current?.warnings ?? [])])].slice(
      0,
      8,
    ),
    ...(previous?.response || current?.response
      ? { response: { ...previous?.response, ...current?.response } }
      : {}),
  };
}
