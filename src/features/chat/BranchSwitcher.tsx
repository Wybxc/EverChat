import { useTranslation } from 'react-i18next';
import './locales';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { IconButton } from '../../components/IconButton';

export interface BranchNavigation {
  count: number;
  position: number;
  label: string;
  parent: string;
  change: (direction: -1 | 1) => void;
}
export function BranchSwitcher({ count, position, label, parent, change }: BranchNavigation) {
  const { t } = useTranslation('chat', { useSuspense: false });

  if (count < 2) return null;
  return (
    <div
      role="group"
      aria-label={t(($) => $.switchVersion, { label })}
      data-branch-switcher={parent}
      className="branch-switcher flex shrink-0 items-center text-foreground"
    >
      <IconButton
        type="button"
        data-branch-direction="-1"
        label={t(($) => $.previousVersion, { label })}
        disabled={position === 0}
        onClick={() => change(-1)}
      >
        <ChevronLeft className="size-4" />
      </IconButton>
      <span
        className="min-w-8 text-center text-xs tabular-nums"
        aria-label={t(($) => $.versionPosition, { label, position: position + 1, count })}
      >
        {position + 1} / {count}
      </span>
      <IconButton
        type="button"
        data-branch-direction="1"
        label={t(($) => $.nextVersion, { label })}
        disabled={position === count - 1}
        onClick={() => change(1)}
      >
        <ChevronRight className="size-4" />
      </IconButton>
    </div>
  );
}
