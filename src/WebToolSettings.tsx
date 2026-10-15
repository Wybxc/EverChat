import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import { webToolServiceInputSchema, type WebToolServiceInput, type WebToolServiceSettings } from '../shared/web-tool-service';
import { Autosave } from './autosave';
import { api } from './api';
import { storageEpoch, write } from './storage';
import { loadWebToolSettings, useWebToolSettings, WEB_TOOL_SETTINGS_KEY } from './web-tool-settings';

type Draft = WebToolServiceSettings & { apiKey?: string };
export function WebToolSettingsPanel({ active }: { active: boolean }) {
  const query = useWebToolSettings(active);
  if (!query.data) return query.isError
    ? <div className="space-y-3"><p role="alert">{query.error.message}</p><button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>重新读取</button></div>
    : <span role="status" className="loading loading-spinner loading-sm" aria-label="读取联网服务" />;
  return <ServiceEditor initial={query.data} active={active} />;
}

function ServiceEditor({ initial, active }: { initial: WebToolServiceSettings; active: boolean }) {
  const queryClient = useQueryClient();
  const [epoch] = useState(storageEpoch);
  const [store] = useState(() => new Autosave<Draft, WebToolServiceInput>(initial,
    async (input) => {
      if (storageEpoch() !== epoch) throw new Error('登录状态已改变。');
      return api<WebToolServiceSettings>('/settings/web-tools', 'PUT', input);
    }, (result) => {
      if (storageEpoch() !== epoch) return;
      queryClient.setQueryData(WEB_TOOL_SETTINGS_KEY, result); write('web-tool-settings', result);
    }, (_saved, draft) => {
      const parsed = v.safeParse(webToolServiceInputSchema, { provider: 'tavily', dailyLimit: draft.dailyLimit,
        ...(draft.apiKey === undefined ? {} : { apiKey: draft.apiKey }) });
      if (!parsed.success) throw new Error('每日上限须为 1–1,000 的整数，密钥不能包含空格或控制字符。');
      return parsed.output;
    }));
  const { settings, status, error } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [revealed, setRevealed] = useState<string | null>(null), [reading, setReading] = useState(false), [readError, setReadError] = useState('');
  const revealRequest = useRef<AbortController | null>(null), activeRef = useRef(active); activeRef.current = active;
  const hide = () => { revealRequest.current?.abort(); revealRequest.current = null; setRevealed(null); setReading(false); setReadError(''); };
  useEffect(() => { store.receive(initial); }, [initial, store]);
  useEffect(() => {
    if (!active) { hide(); void store.flush().catch(() => {}); }
    else void store.refresh(() => loadWebToolSettings()).catch(() => {});
  }, [active, store]);
  useEffect(() => {
    const retry = () => { void store.flush().catch(() => {}); };
    window.addEventListener('online', retry);
    return () => { window.removeEventListener('online', retry); revealRequest.current?.abort(); store.dispose(); };
  }, [store]);
  const update = (patch: Partial<Draft>) => { hide(); store.update({ ...store.getSnapshot().settings, ...patch }); };
  const reveal = async () => {
    if (revealed !== null || reading) { hide(); return; }
    const controller = new AbortController(); revealRequest.current = controller; setReading(true); setReadError('');
    try {
      await store.flush(); controller.signal.throwIfAborted();
      const result = await api<{ apiKey: string }>('/settings/web-tools/key', 'GET', undefined, controller.signal);
      if (!controller.signal.aborted && activeRef.current && storageEpoch() === epoch) setRevealed(result.apiKey);
    } catch (error) { if (!controller.signal.aborted && activeRef.current && storageEpoch() === epoch) setReadError(error instanceof Error ? error.message : '密钥读取失败。'); }
    finally { if (revealRequest.current === controller) { revealRequest.current = null; setReading(false); } }
  };
  return <div className="space-y-5" onBlur={() => void store.flush().catch(() => {})}>
    <h3 className="text-lg font-semibold">Tavily</h3>
    <div className="space-y-2"><label htmlFor="web-tool-key" className="block text-sm font-medium">API 密钥</label>
      <div className="flex gap-2"><input id="web-tool-key" aria-label="联网服务 API 密钥" type={revealed === null ? 'password' : 'text'} autoComplete="new-password" maxLength={4096} className="input min-w-0 flex-1 border-base-content/50" placeholder={settings.hasApiKey ? '已配置，输入可替换' : '未配置'} value={settings.apiKey ?? revealed ?? ''} onChange={(event) => update({ apiKey: event.currentTarget.value })} />
        <button type="button" className="btn btn-square" aria-label={revealed === null ? '查看联网服务密钥' : '隐藏联网服务密钥'} aria-pressed={revealed !== null} onClick={() => void reveal()}>{reading ? <span className="loading loading-spinner loading-xs" /> : revealed === null ? <Eye size={17} /> : <EyeOff size={17} />}</button>
        <button type="button" className="btn" disabled={!settings.hasApiKey && !settings.apiKey} onClick={() => update({ apiKey: '' })}>清除密钥</button>
      </div>
    </div>
    <label className="block space-y-2 text-sm"><span>每日请求上限（UTC）</span><input aria-label="联网服务每日请求上限" type="number" min={1} max={1000} step={1} className="input block w-full border-base-content/50 sm:max-w-56" value={Number.isFinite(settings.dailyLimit) ? settings.dailyLimit : ''} onChange={(event) => update({ dailyLimit: event.currentTarget.valueAsNumber })} /></label>
    <div className="flex flex-wrap items-center gap-2 text-sm"><span>今日已用：{settings.usedToday} / {Number.isFinite(settings.dailyLimit) ? settings.dailyLimit : '—'}</span><button type="button" className="btn btn-ghost btn-square btn-xs" aria-label="刷新联网服务用量" onClick={() => void store.refresh(() => loadWebToolSettings()).catch(() => {})}><RefreshCw size={14} /></button></div>
    <p className="text-xs text-base-content/70">会话参数中开启搜索或网页读取。请求上限按次数计算，可能产生服务与模型费用。</p>
    <div className="flex items-center gap-3 text-xs text-base-content/70"><span data-testid="web-tool-save-status" role={status === 'error' ? 'alert' : 'status'}>{status === 'error' ? error : status === 'saving' ? '保存中…' : status === 'waiting' ? '保存中…' : '已保存'}</span>{status === 'error' && <button type="button" className="btn btn-xs" onClick={() => void store.flush().catch(() => {})}>重试保存</button>}</div>
    {readError && <p role="alert" className="text-sm">{readError}</p>}
  </div>;
}
