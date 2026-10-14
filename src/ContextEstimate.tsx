import type { ContextEstimate } from '../shared/context-budget';
import { metadataSourceLabels } from '../shared/model-metadata';

const number = new Intl.NumberFormat('zh-CN');
export function ContextEstimateView({ estimate }: { estimate: ContextEstimate }) {
  return <div data-testid="context-estimate" className="mt-2 text-xs text-base-content/80">
    <details>
      <summary className="cursor-pointer py-1">输入 ≈{number.format(estimate.inputTokens)} · 上下文 ≈{number.format(estimate.totalTokens)} / {number.format(estimate.inputBudget)} Tokens{estimate.windowSource === 'fallback' ? ' · 窗口未识别' : ''}</summary>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-2">
        <dt>系统提示词（估算）</dt><dd>{number.format(estimate.systemTokens)}</dd>
        <dt>历史（估算）</dt><dd>{number.format(estimate.historyTokens)} · {estimate.retainedMessages} 条</dd>
        <dt>模型窗口</dt><dd>{number.format(estimate.contextWindow)} · {metadataSourceLabels[estimate.windowSource]}</dd>
        <dt>输出预留</dt><dd>{number.format(estimate.outputReserve)}{estimate.contextScope === 'input' ? '（独立窗口）' : ''}</dd>
        <dt>估算余量</dt><dd>{number.format(estimate.safetyMargin)}</dd>
      </dl>
      <p className="mt-2">近似值；输出预留不设置请求上限，实际用量以供应商报告为准。</p>
    </details>
    {estimate.omittedMessages > 0 && <p className="mt-1" data-testid="context-omission">将省略 {estimate.omittedMessages} 条历史消息，原文仍保留。</p>}
    {estimate.totalTokens > estimate.inputBudget && <p className="mt-1">系统提示词与输入超过预算，请调整后发送。</p>}
  </div>;
}
