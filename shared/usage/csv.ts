import { formatAmount } from './pricing';
import { usageKindLabels, usageStatusLabels, type UsageRecord } from './types';

export const usageCsvHeader =
  '时间,类型,供应商,模型,状态,输入 Token,输出 Token,缓存读取 Token,用量完整,币种,原估算,修正金额,修正原因\r\n';
export function csvCell(value: string | number | undefined) {
  const text = String(value ?? '');
  // Spreadsheet applications also interpret formulas after whitespace/control characters.
  const safe =
    /^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function usageCsvRow(record: UsageRecord) {
  return (
    [
      new Date(record.startedAt).toISOString(),
      usageKindLabels[record.kind],
      record.providerName,
      record.modelName,
      usageStatusLabels[record.status],
      record.usage.inputTokens,
      record.usage.outputTokens,
      record.usage.cachedInputTokens,
      record.usageIsFinal ? '是' : '否',
      record.cost.currency ?? '',
      record.cost.amount === null ? '' : formatAmount(record.cost.amount, 12),
      record.correction ? formatAmount(record.correction.amount, 12) : '',
      record.correction?.reason,
    ]
      .map(csvCell)
      .join(',') + '\r\n'
  );
}
