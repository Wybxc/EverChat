import * as v from 'valibot';

export const DEFAULT_WEB_TOOL_DAILY_LIMIT = 20;
export const webToolServiceInputSchema = v.strictObject({
  provider: v.picklist(['tavily', 'deepseek']),
  dailyLimit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)),
  apiKey: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(4096),
      v.check((key) => !/[^\x21-\x7e]/.test(key)),
    ),
  ),
});
export type WebToolServiceInput = v.InferOutput<typeof webToolServiceInputSchema>;
export interface WebToolServiceConfig {
  provider: 'tavily' | 'deepseek';
  apiKey: string;
  dailyLimit: number;
}
export interface WebToolServiceSettings {
  provider: 'tavily' | 'deepseek';
  hasApiKey: boolean;
  dailyLimit: number;
  usedToday: number;
}
