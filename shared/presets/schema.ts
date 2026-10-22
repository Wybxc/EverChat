import { MAX_SQL_PAYLOAD_BYTES } from '../conversation/limits';
import * as v from 'valibot';

export const promptPresetInputSchema = v.pipe(
  v.strictObject({
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
    systemPrompt: v.string(),
  }),
  v.check(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_SQL_PAYLOAD_BYTES,
  ),
);
const promptPresetSchema = v.pipe(
  v.strictObject({
    id: v.pipe(v.string(), v.uuid()),
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
    systemPrompt: v.string(),
    updatedAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  }),
  v.check(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_SQL_PAYLOAD_BYTES,
  ),
);
export const promptPresetListSchema = v.pipe(
  v.array(promptPresetSchema),
  v.check((presets) => new Set(presets.map((preset) => preset.id)).size === presets.length),
);
