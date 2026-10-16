import { useEffect, useState } from 'react';
export function useSidebar(_open: boolean, close: () => void) {
  const [desktop, setDesktop] = useState(() => matchMedia('(min-width: 64rem)').matches);
  useEffect(() => {
    const query = matchMedia('(min-width: 64rem)');
    const update = () => { setDesktop(query.matches); close(); };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [close]);
  return { desktop };
}
