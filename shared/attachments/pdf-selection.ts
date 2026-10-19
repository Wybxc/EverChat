import { AppError, problem } from '../errors/descriptor';
import type { DocumentRange } from './documents';

export function pageRanges(input: string, offsets: number[], characters: number): DocumentRange[] {
  const pages: { start: number; end: number }[] = [];
  for (const item of input.trim().split(/[,，]/u)) {
    const match = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(item.trim());
    if (!match) throw new AppError(problem('PDF_SELECTION_INVALID'), '页码格式如 1-3, 5。');
    const start = Number(match[1]),
      end = Number(match[2] ?? match[1]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end > offsets.length
    )
      throw new AppError(
        problem('PDF_SELECTION_RANGE', { limit: offsets.length! }),
        `请选择 1–${offsets.length} 页。`,
      );
    pages.push({ start, end });
  }
  const ranges: DocumentRange[] = [];
  for (const page of pages.sort((a, b) => a.start - b.start)) {
    const range = { start: offsets[page.start - 1], end: offsets[page.end] ?? characters },
      last = ranges.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else ranges.push(range);
  }
  return ranges;
}
