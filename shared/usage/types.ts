import * as v from 'valibot';
import type { StreamUsage } from '../streaming/provider-stream';

export const usageKinds = [
  'chat',
  'summary',
  'title',
  'probe',
  'web_search',
  'read_webpage',
] as const;
export type UsageKind = (typeof usageKinds)[number];
export const usageStatuses = ['running', 'completed', 'failed', 'cancelled', 'unknown'] as const;
export type UsageStatus = (typeof usageStatuses)[number];
const rate = v.nullable(v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/)));
export const priceInputSchema = v.strictObject({
  providerId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  currency: v.pipe(v.string(), v.regex(/^[A-Z]{3}$/)),
  input: rate,
  output: rate,
  reasoning: v.optional(rate),
  cacheRead: rate,
  cacheWrite: rate,
  perRequest: rate,
  source: v.optional(v.pipe(v.string(), v.maxLength(500)), ''),
});
export type UsagePriceInput = v.InferOutput<typeof priceInputSchema>;
export interface UsagePrice extends UsagePriceInput {
  id: string;
  effectiveFrom: number;
}
export interface CostEstimate {
  currency: string | null;
  /** Integer trillionths of the original currency; never a floating point amount. */
  amount: string | null;
  state: 'priced' | 'partial' | 'unpriced' | 'invalid';
}
export interface UsageAttempt {
  id: string;
  version: number;
  conversationId: string | null;
  messageId: string | null;
  taskId: string;
  kind: UsageKind;
  providerId: string;
  providerName: string;
  protocol: string;
  model: string;
  modelName: string;
  startedAt: number;
  endedAt: number | null;
  status: UsageStatus;
  usage: StreamUsage;
  usageIsFinal: boolean;
  /** True only for the first model call of a new answer, not every tool round. */
  answer?: boolean;
  firstTokenMs?: number;
  httpStatus?: number;
  price: UsagePrice | null;
}
export interface UsageRecord extends UsageAttempt {
  cost: CostEstimate;
  correction?: { amount: string; reason: string; at: number };
}
export interface UsageFilter {
  from?: number;
  to?: number;
  providerId?: string;
  model?: string;
  kind?: UsageKind;
  status?: UsageStatus;
  cursor?: string;
  limit?: number;
}
export interface UsageTotals {
  requests: number;
  modelRequests: number;
  answers: number;
  completed: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheEligibleInputTokens: number;
  cacheReportedReadTokens: number;
  cacheWriteInputTokens: number;
  incomplete: number;
  unpriced: number;
  currencies: Record<string, string>;
  durationMs: number;
  durationSamples: number;
  firstTokenMs: number;
  firstTokenSamples: number;
}
export interface UsageGroup extends UsageTotals {
  at?: number;
  key: string;
  label: string;
  providerId?: string;
  model?: string;
}
export interface UsageReport {
  totals: UsageTotals;
  providers: UsageGroup[];
  models: UsageGroup[];
  trend: UsageGroup[];
  collectedSince: number | null;
}
export const usageKindLabels: Record<UsageKind, string> = {
  chat: '对话',
  summary: '摘要',
  title: '标题',
  probe: '能力检测',
  web_search: '网页搜索',
  read_webpage: '网页读取',
};
export const usageStatusLabels: Record<UsageStatus, string> = {
  running: '进行中',
  completed: '成功',
  failed: '失败',
  cancelled: '已取消',
  unknown: '结果未知',
};
