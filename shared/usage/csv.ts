import { formatAmount } from './pricing';
import type { UsageRecord, UsageKind, UsageStatus } from './types';

export interface UsageCsvLabels {
  header: string[];
  kinds: Record<UsageKind, string>;
  statuses: Record<UsageStatus, string>;
  yes: string;
  no: string;
}
export const usageCsvHeader = (labels: UsageCsvLabels) =>
  labels.header.map(csvCell).join(',') + '\r\n';
export function csvCell(value: string | number | undefined) {
  const text = String(value ?? '');
  // Spreadsheet applications also interpret formulas after whitespace/control characters.
  const safe =
    /^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function usageCsvRow(record: UsageRecord, labels: UsageCsvLabels) {
  return (
    [
      new Date(record.startedAt).toISOString(),
      labels.kinds[record.kind],
      record.providerName,
      record.modelName,
      labels.statuses[record.status],
      record.usage.inputTokens,
      record.usage.outputTokens,
      record.usage.cachedInputTokens,
      record.usageIsFinal ? labels.yes : labels.no,
      record.cost.currency ?? '',
      record.cost.amount === null ? '' : formatAmount(record.cost.amount, 12),
    ]
      .map(csvCell)
      .join(',') + '\r\n'
  );
}
