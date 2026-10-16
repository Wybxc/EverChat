import { Infinity as InfinityIcon } from 'lucide-react';



export function Brand({ small = false }: { small?: boolean }) {
  return <div className="flex items-center gap-2 text-primary"><InfinityIcon className={small ? 'size-8' : 'size-10'} strokeWidth={1.8} /><span className="text-xl font-bold tracking-tight">EverChat</span></div>;
}
