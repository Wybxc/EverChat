import { useEffect, useRef } from 'react';
import { setReloadBlocker } from './reload-guard';
import type { ReloadReason } from './protocol';

export function useReloadBlocker(reason: ReloadReason | null) {
  const latest = useRef(reason);
  latest.current = reason;
  useEffect(() => {
    const owner = {};
    setReloadBlocker(owner, () => latest.current);
    return () => setReloadBlocker(owner, null);
  }, []);
}
