import { useCallback,useEffect,useRef,useState } from 'react';
import { chatModels } from '../../shared/models/selection';
import { type ProviderSettings,type SessionInfo } from '../../shared/providers/types';
import { api } from '../platform/api';
import { read, write } from '../platform/storage';



const EMPTY_SESSION: SessionInfo = { authenticated: false, configured: false, attachmentsConfigured: false, provider: '', model: '' };

export function useSession() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [bootError, setBootError] = useState('');
  const providerSaved = useCallback((config: ProviderSettings) => {
    const profile = config.providers.find((profile) => profile.id === config.activeProviderId);
    const model = profile?.models.find((model) => model.id === config.activeModel && model.enabled);
    setSession((current) => {
      if (!current?.authenticated) return current;
      const next = { ...current, provider: model ? profile!.provider : '', model: model?.id ?? '', modelName: model?.name || model?.id || '', activeProviderId: model ? profile!.id : null, models: chatModels(config), showReasoning: config.showReasoning, systemPrompt: config.systemPrompt, maxOutputTokens: config.maxOutputTokens };
      write('session', next); return next;
    });
  }, []);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const loggedOut = useCallback(() => { setSession((current) => ({ ...(current ?? EMPTY_SESSION), authenticated: false })); }, []);
  const boot = useCallback(async () => {
    setBootError('');
    try {
      const current = await api<SessionInfo>('/session'); setSession(current); write('session', current);
    } catch {
      const cached = read<SessionInfo | null>('session', null);
      if (cached?.authenticated) setSession(cached);
      else setBootError('暂时无法连接你的空间。请检查网络和服务是否已启动。');
    }
  }, []);
  useEffect(() => {
    void boot();
    const refresh = () => { void boot(); };
    window.addEventListener('online', refresh); window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh); };
  }, [boot]);
  return { session, sessionRef, bootError, boot, loggedOut, providerSaved };
}
