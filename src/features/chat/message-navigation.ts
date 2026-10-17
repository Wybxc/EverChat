export interface AnswerAnchor {
  id: string;
  top: number;
}

export const POSITION_TOLERANCE = 2;

/** A landed ID disambiguates answers whose starts clamp to the same bottom position. */
export function answerTargets(
  anchors: readonly AnswerAnchor[],
  readingLine: number,
  landedId?: string,
) {
  const landed = landedId ? anchors.findIndex(({ id }) => id === landedId) : -1;
  if (landed !== -1) return { previous: anchors[landed - 1]?.id, next: anchors[landed + 1]?.id };
  let previous: string | undefined;
  for (const anchor of anchors) {
    if (anchor.top < readingLine - POSITION_TOLERANCE) previous = anchor.id;
    else if (anchor.top > readingLine + POSITION_TOLERANCE) return { previous, next: anchor.id };
  }
  return { previous, next: undefined };
}
