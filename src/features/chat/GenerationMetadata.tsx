import { useState } from 'react';
import { Modal, ModalTitle } from '../../components/Modal';
import { Button } from '@/components/ui/button';

import type { GenerationResult } from '../../../shared/streaming/generation';
import type { StreamUsage } from '../../../shared/streaming/provider-stream';

const usageFields: [keyof StreamUsage, string][] = [
  ['inputTokens', '输入 Tokens'],
  ['cachedInputTokens', '其中缓存读取'],
  ['cacheWriteInputTokens', '其中缓存写入'],
  ['uncachedInputTokens', '其中未缓存'],
  ['toolInputTokens', '其中工具输入'],
  ['outputTokens', '输出 Tokens'],
  ['textOutputTokens', '其中正文'],
  ['reasoningTokens', '其中思考'],
  ['totalTokens', '总计 Tokens'],
];
const timings = [
  ['firstTokenMs', '云端首 Token（含思考）'],
  ['queueMs', '排队'],
  ['durationMs', '云端生成'],
] as const;
const number = new Intl.NumberFormat('zh-CN');
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const duration = (ms: number) =>
  ms < 1000 ? `${number.format(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;

export function GenerationMetadata({ generation }: { generation?: GenerationResult }) {
  const [open, setOpen] = useState(false);
  if (!generation) return null;
  const fields = usageFields.filter(([key]) => generation.usage[key] !== undefined);
  const usage = generation.usage;
  const tokens =
    usage.totalTokens !== undefined
      ? `${compact.format(usage.totalTokens)} Tokens`
      : usage.outputTokens !== undefined
        ? `输出 ${compact.format(usage.outputTokens)} Tokens`
        : usage.inputTokens !== undefined
          ? `输入 ${compact.format(usage.inputTokens)} Tokens`
          : '';
  const elapsed = generation.timing?.durationMs;
  const summary = [
    tokens && !generation.usageIsFinal ? '部分' : '',
    tokens,
    elapsed === undefined ? '' : `${(elapsed / 1000).toFixed(1)} s`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <Button
        variant="ghost"
        type="button"
        className="min-h-11 min-w-0 max-w-full px-2 text-xs text-muted-foreground"
        aria-label="生成信息"
        aria-description={summary || undefined}
        data-testid="generation-summary"
        title={summary || '生成信息'}
        onClick={() => setOpen(true)}
      >
        <span className="truncate">{summary || '生成信息'}</span>
      </Button>
      <Modal showCloseButton open={open} onOpenChange={setOpen}>
        <div data-testid="message-generation" className="w-full max-w-md space-y-4 p-5 text-xs">
          <ModalTitle>生成信息</ModalTitle>
          <div className="py-2">
            <dl className="space-y-2">
              <div className="flex items-baseline justify-between gap-4 sm:gap-6">
                <dt>Token 用量</dt>
                <dd>
                  {fields.length
                    ? generation.usageIsFinal
                      ? '供应商报告'
                      : '部分报告'
                    : '供应商未返回'}
                </dd>
              </div>
              {fields.map(([key, label]) => (
                <div key={key} className="flex items-baseline justify-between gap-4 sm:gap-6">
                  <dt>{label}</dt>
                  <dd data-testid={`generation-${key}`}>{number.format(generation.usage[key]!)}</dd>
                </div>
              ))}
              {timings
                .filter(([key]) => generation.timing?.[key] !== undefined)
                .map(([key, label]) => (
                  <div key={key} className="flex items-baseline justify-between gap-4 sm:gap-6">
                    <dt>{label}</dt>
                    <dd data-testid={`generation-${key}`}>{duration(generation.timing![key]!)}</dd>
                  </div>
                ))}
              {generation.context && (
                <>
                  <div className="flex items-baseline justify-between gap-4 sm:gap-6">
                    <dt>发送上下文（估算）</dt>
                    <dd data-testid="generation-contextTokens">
                      ≈{number.format(generation.context.totalTokens)} /{' '}
                      {number.format(generation.context.inputBudget)}
                    </dd>
                  </div>
                  {generation.context.toolTokens !== undefined && (
                    <div className="flex items-baseline justify-between gap-4 sm:gap-6">
                      <dt>其中工具（估算）</dt>
                      <dd data-testid="generation-toolTokens">
                        ≈{number.format(generation.context.toolTokens)}
                      </dd>
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-4 sm:gap-6">
                    <dt>历史消息</dt>
                    <dd data-testid="generation-contextMessages">
                      {generation.context.retainedMessages} 条 · 省略{' '}
                      {generation.context.omittedMessages} 条
                    </dd>
                  </div>
                  {generation.context.summaryTokens !== undefined && (
                    <div className="flex items-baseline justify-between gap-4 sm:gap-6">
                      <dt>摘要（估算）</dt>
                      <dd data-testid="generation-summaryTokens">
                        ≈{number.format(generation.context.summaryTokens)} · 覆盖{' '}
                        {generation.context.summarizedMessages} 条
                      </dd>
                    </div>
                  )}
                </>
              )}
            </dl>
          </div>
        </div>
      </Modal>
    </>
  );
}
