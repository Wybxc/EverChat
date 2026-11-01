import * as v from 'valibot';

export const libraryWatermarkSchema = v.object({
  epoch: v.pipe(v.string(), v.minLength(1)),
  revision: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
export type LibraryWatermark = v.InferOutput<typeof libraryWatermarkSchema>;
export const sameLibraryVersion = (a: LibraryWatermark | undefined, b: LibraryWatermark) =>
  a?.epoch === b.epoch && a.revision === b.revision;
export const coversLibraryVersion = (a: LibraryWatermark | undefined, b: LibraryWatermark) =>
  a?.epoch === b.epoch && a.revision >= b.revision;

export const controlReadySchema = v.object({
  type: v.literal('ready'),
  library: libraryWatermarkSchema,
  revalidateAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
export const libraryChangedSchema = v.object({
  type: v.literal('library-changed'),
  library: libraryWatermarkSchema,
});

/** Shared by both authenticated sockets; automatic ping responses never renew it. */
export const ACCESS_REVALIDATION_SECONDS = 300;
