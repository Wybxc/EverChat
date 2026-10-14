import * as v from 'valibot';
import type { PromptPresetInput } from './types';

export const MAX_PROMPT_PRESETS = 50;
export const MAX_PRESET_TEXT_BYTES = 512 * 1024;
export const PRESET_CAPACITY_MESSAGE = '预设数量或内容总量已达上限，请整理已有预设。';
export const promptPresetInputSchema = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
  systemPrompt: v.pipe(v.string(), v.maxLength(20_000)),
});
export const promptPresetSchema = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  ...promptPresetInputSchema.entries,
  updatedAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
});
export const promptPresetListSchema = v.pipe(v.array(promptPresetSchema), v.maxLength(MAX_PROMPT_PRESETS),
  v.check((presets) => new Set(presets.map((preset) => preset.id)).size === presets.length),
  v.check((presets) => presets.reduce((size, preset) => size + presetTextBytes(preset), 0) <= MAX_PRESET_TEXT_BYTES));

export function presetTextBytes(preset: PromptPresetInput) {
  return new TextEncoder().encode(preset.name).byteLength + new TextEncoder().encode(preset.systemPrompt).byteLength;
}
