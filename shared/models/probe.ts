import * as v from 'valibot';
import { providerFailureSchema } from '../providers/failure';

export const probeCapabilities = ['text', 'imageInput', 'toolCalls'] as const;
export type ProbeCapability = (typeof probeCapabilities)[number];
export const probeCapabilityLabels: Record<ProbeCapability, string> = {
  text: '文本',
  imageInput: '图片',
  toolCalls: '工具',
};
export const modelProbeInputSchema = v.strictObject({
  model: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  capability: v.picklist(probeCapabilities),
});
export const modelProbeResultSchema = v.strictObject({
  capability: v.picklist(probeCapabilities),
  status: v.picklist(['confirmed', 'unconfirmed']),
  reason: v.picklist(['matched', 'mismatch', 'request-failed', 'timeout', 'response-too-large']),
  testedAt: v.pipe(v.number(), v.integer(), v.minValue(1)),
  failure: v.optional(providerFailureSchema),
});
export type ModelProbeResult = v.InferOutput<typeof modelProbeResultSchema>;
export const probeReasonLabels: Record<ModelProbeResult['reason'], string> = {
  matched: '已验证',
  mismatch: '结果不符，未确认',
  'request-failed': '请求失败，未确认',
  timeout: '超时，未确认',
  'response-too-large': '响应过大，未确认',
};
