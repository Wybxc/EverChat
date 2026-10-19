import type { UsageKind, UsageStatus } from '../../../shared/usage/types';
import { t } from './locales';
const kinds = {
  chat: 'kindChat',
  summary: 'kindSummary',
  title: 'kindTitle',
  probe: 'kindProbe',
  web_search: 'webSearch',
  read_webpage: 'webFetch',
} as const;
const statuses = {
  running: 'statusRunning',
  completed: 'statusCompleted',
  failed: 'statusFailed',
  cancelled: 'statusCancelled',
  unknown: 'statusUnknown',
} as const;
export const usageKindLabel = (kind: UsageKind) => t(($) => $[kinds[kind]]);
export const usageStatusLabel = (status: UsageStatus) => t(($) => $[statuses[status]]);
