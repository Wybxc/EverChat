import { Button } from '@/components/ui/button';
import type { ContextEstimate } from '../shared/context-budget';
import { metadataSourceLabels } from '../shared/model-metadata';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const number = new Intl.NumberFormat('zh-CN');
export function ContextEstimateView({ estimate, compressing = false }: { estimate: ContextEstimate; compressing?: boolean }) {
  return <div data-testid="context-estimate" className="mt-1 text-xs text-muted-foreground">
    <Popover><PopoverTrigger asChild><Button variant="ghost" type="button" className="context-trigger min-h-6 max-w-full cursor-pointer truncate rounded-lg px-2 text-left underline-offset-4 hover:underline" aria-label="查看上下文估算">上下文 ≈{number.format(estimate.totalTokens)} / {number.format(estimate.inputBudget)}</Button></PopoverTrigger>
    <PopoverContent aria-label="上下文估算" side="top" align="start" className="w-80 max-w-[calc(100vw-2rem)] p-4 text-xs">
      <p>输入 ≈{number.format(estimate.inputTokens)} Tokens{estimate.windowSource === 'fallback' ? ' · 模型窗口未识别' : ''}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <dt>系统提示词（估算）</dt><dd>{number.format(estimate.systemTokens)}</dd>
        <dt>历史（估算）</dt><dd>{number.format(estimate.historyTokens)} · {estimate.retainedMessages} 条</dd>
        {estimate.imageTokens !== undefined && <><dt>其中图片规划额度</dt><dd>{number.format(estimate.imageTokens)}</dd></>}
        {estimate.summaryTokens !== undefined && <><dt>摘要（估算）</dt><dd>{number.format(estimate.summaryTokens)} · 覆盖 {estimate.summarizedMessages} 条</dd></>}
        {estimate.documentTokens !== undefined && <><dt>其中文件（估算）</dt><dd>{number.format(estimate.documentTokens)}</dd></>}
        <dt>模型窗口</dt><dd>{number.format(estimate.contextWindow)} · {metadataSourceLabels[estimate.windowSource]}</dd>
        <dt>输出预留</dt><dd>{number.format(estimate.outputReserve)}{estimate.contextScope === 'input' ? '（独立窗口）' : ''}</dd>
        <dt>估算余量</dt><dd>{number.format(estimate.safetyMargin)}</dd>
      </dl>
      <p className="mt-2">近似值；输出预留不设置请求上限，实际用量以供应商报告为准。</p>
    </PopoverContent></Popover>
    {compressing ? <p className="mt-1" data-testid="automatic-compression-preview">发送时先自动压缩历史，会额外调用摘要模型。</p> : estimate.omittedMessages > 0 && <p className="mt-1" data-testid="context-omission">将省略 {estimate.omittedMessages} 条历史消息，原文仍保留。</p>}
    {!compressing && estimate.totalTokens > estimate.inputBudget && <p className="mt-1">{estimate.summaryTokens ? '系统提示词、摘要与输入' : '系统提示词与输入'}超过预算，请调整后发送。</p>}
  </div>;
}
