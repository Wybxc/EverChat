import { Infinity as InfinityIcon } from 'lucide-react';

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-accent-foreground">
      <InfinityIcon
        className={`shrink-0 text-primary ${small ? 'size-8' : 'size-10'}`}
        strokeWidth={1.8}
      />
      <span className="truncate text-xl font-bold tracking-tight">EverChat</span>
    </div>
  );
}
