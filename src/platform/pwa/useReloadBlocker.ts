import { useEffect, useRef } from 'react';
import { setReloadBlocker } from './reload-guard';

export function useReloadBlocker(reason: string | null) {
  const latest = useRef(reason);
  latest.current = reason;
  useEffect(() => {
    const owner = {};
    setReloadBlocker(owner, () => latest.current);
    return () => setReloadBlocker(owner, null);
  }, []);
}
