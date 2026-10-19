import { usageKinds, usageStatuses } from '../../../shared/usage/types';
import type { UsageCsvLabels } from '../../../shared/usage/csv';
import { t } from './locales';
import { usageKindLabel, usageStatusLabel } from './labels';
export { usageCsvHeader, usageCsvRow } from '../../../shared/usage/csv';
export function csvLabels(): UsageCsvLabels {
  return {
    header: (
      [
        'csvTime',
        'csvKind',
        'csvProvider',
        'csvModel',
        'csvStatus',
        'csvInput',
        'csvOutput',
        'csvCache',
        'csvFinal',
        'currency',
        'estimatedCost',
      ] as const
    ).map((key) => t(($) => $[key])),
    kinds: Object.fromEntries(
      usageKinds.map((kind) => [kind, usageKindLabel(kind)]),
    ) as UsageCsvLabels['kinds'],
    statuses: Object.fromEntries(
      usageStatuses.map((status) => [status, usageStatusLabel(status)]),
    ) as UsageCsvLabels['statuses'],
    yes: t(($) => $.yes),
    no: t(($) => $.no),
  };
}
