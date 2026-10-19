import * as v from 'valibot';
import type { ErrorIssue } from '../errors/descriptor';
import { AppError, problem } from '../errors/descriptor';

export const titleSettingsSchema = v.object({
  automatic: v.boolean(),
  model: v.nullable(
    v.object({
      providerId: v.pipe(v.string(), v.uuid()),
      model: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
    }),
  ),
});
export type TitleSettings = v.InferOutput<typeof titleSettingsSchema>;
export const DEFAULT_TITLE_SETTINGS: TitleSettings = { automatic: false, model: null };
export type TitleSource = 'fallback' | 'manual' | 'ai';
export type TitleTaskInfo = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'superseded';
  error?: string;
  issue?: ErrorIssue;
};

export function cleanTitle(value: string): string {
  const line =
    value
      .replace(/<[^>]*>/g, '')
      .split(/\r?\n/)
      .map((line) =>
        line
          .trim()
          .replace(/^```[^\s]*\s*$/u, '')
          .replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/u, ''),
      )
      .find(Boolean)
      ?.replace(/^["'“”「」`*]+|["'“”「」`*]+$/gu, '')
      .trim() ?? '';
  let title = '';
  for (const char of line.replace(/[\u0000-\u001f\u007f]/gu, '')) {
    if (title.length + char.length > 80) break;
    title += char;
  }
  if (!title.trim()) throw new AppError(problem('TITLE_FAILED'), '标题模型返回了空标题，请重试。');
  return title;
}
