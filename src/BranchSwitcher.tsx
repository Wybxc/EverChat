import { ChevronLeft, ChevronRight } from 'lucide-react';
import { IconButton } from './IconButton';

export interface BranchNavigation {
  count: number; position: number; label: string; parent: string;
  change: (direction: -1 | 1) => void;
}
export function BranchSwitcher({ count, position, label, parent, change }: BranchNavigation) {
  if (count < 2) return null;
  return <div role="group" aria-label={`${label}切换`} data-branch-switcher={parent} className="branch-switcher flex shrink-0 items-center text-foreground">
    <IconButton type="button" data-branch-direction="-1" label={`上一个${label}`} disabled={position === 0} onClick={() => change(-1)}><ChevronLeft className="size-4" /></IconButton>
    <span className="min-w-10 text-center text-xs tabular-nums" aria-label={`${label} ${position + 1}，共 ${count} 个`}>{position + 1} / {count}</span>
    <IconButton type="button" data-branch-direction="1" label={`下一个${label}`} disabled={position === count - 1} onClick={() => change(1)}><ChevronRight className="size-4" /></IconButton>
  </div>;
}
