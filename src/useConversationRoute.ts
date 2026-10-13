import { useCallback, useEffect, useState } from 'react';

const conversationPath = /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const readRoute = () => {
  const id = conversationPath.exec(location.pathname)?.[1] ?? null;
  return { id, invalid: location.pathname !== '/' && !id };
};
export const conversationUrl = (id: string | null) => id ? `/c/${encodeURIComponent(id)}` : '/';

export function useConversationRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const restore = () => setRoute(readRoute());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const navigate = useCallback((id: string | null, replace = false) => {
    const path = conversationUrl(id);
    if (location.pathname !== path) {
      if (replace) history.replaceState(null, '', path);
      else history.pushState(null, '', path);
    }
    setRoute(readRoute());
  }, []);
  return { ...route, navigate };
}
