import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs,TabsList,TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useEffect,useRef,useState,useSyncExternalStore,type ReactNode } from 'react';
import type { ProviderSettings } from '../../shared/providers/types';
import { DisclosureScope } from '../components/Disclosure';
import { PromptPresetsPanel } from '../features/presets/PromptPresets';
import { ProviderEditor } from '../features/providers/ProviderEditor';
import { availableModels, reconcile } from '../features/providers/selection';
import { SettingsAutosave } from '../features/providers/settings-autosave';
import { WebToolSettingsPanel } from '../features/web-tools/WebToolSettings';
import { api } from '../platform/api';
import { useMediaQuery } from '../platform/useMediaQuery';

type PanelProps = { render: (content: ReactNode) => ReactNode; open: boolean; requestedTab?: SettingsTab; onSaved: (settings: ProviderSettings) => void; themeControl: ReactNode; onLogout: () => void };
const tabs = [{ id: 'general', label: '通用' }, { id: 'providers', label: '供应商' }, { id: 'chat', label: '对话' }, { id: 'presets', label: '预设' }, { id: 'web-tools', label: '联网' }] as const;
export type SettingsTab = (typeof tabs)[number]['id'];

export function SettingsPanel(props: PanelProps) {
  const query = useQuery({
    queryKey: ['provider-settings'], queryFn: () => api<ProviderSettings>('/settings/providers'), enabled: props.open,
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  if (!query.data && query.isError) return props.render(<div className="space-y-3 p-6"><p role="alert" className="text-sm">{query.error.message}</p><Button variant="secondary" onClick={() => void query.refetch()}>重新读取</Button></div>);
  if (!query.data) return props.render(<div role="status" className="py-6 text-center"><Spinner aria-label="正在读取设置" /></div>);
  return <SettingsForm initial={query.data} {...props} />;
}

function SettingsForm({ initial, open, render, requestedTab, onSaved, themeControl, onLogout }: PanelProps & { initial: ProviderSettings }) {
  const verticalTabs = useMediaQuery('(min-width: 40rem)');
  const queryClient = useQueryClient();
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const [store] = useState(() => new SettingsAutosave(initial,
    (input) => api<ProviderSettings>('/settings/providers', 'PUT', input),
    (result) => { queryClient.setQueryData(['provider-settings'], result); onSavedRef.current(result); },
  ));
  const { settings, status, error } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>('general');
  const update = (next: ProviderSettings) => store.update(reconcile(next));
  const enabled = availableModels(settings);
  const wasOpen = useRef(open);
  useEffect(() => { if (open && requestedTab) setTab(requestedTab); }, [open, requestedTab]);
  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => {
    if (!open) { void store.flush().catch(() => {}); }
    else if (!wasOpen.current) {
      void store.refresh(() => api<ProviderSettings>('/settings/providers')).catch(() => {});
    }
    wasOpen.current = open;
  }, [open, store]);
  useEffect(() => {
    const retry = () => { void store.flush().catch(() => {}); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [store]);
  return render(<DisclosureScope><div className="settings-fields flex min-h-0 flex-1 flex-col">
    <Tabs orientation={verticalTabs ? 'vertical' : 'horizontal'} value={tab} onValueChange={(value) => { setTab(value as SettingsTab); }} className="settings-tabs">
    <TabsList aria-label="设置分类" className="settings-tab-list">
      {tabs.map((item) => <TabsTrigger key={item.id} id={`settings-tab-${item.id}`} value={item.id} aria-controls={`settings-panel-${item.id}`} onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })}>{item.label}</TabsTrigger>)}
    </TabsList>
    <div data-testid="settings-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4" onBlur={(event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) void store.flush().catch(() => {});
    }}>
      <section id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general" hidden={tab !== 'general'} className="space-y-4">
        <div>{themeControl}</div>
        <Button variant="secondary" type="button" className="gap-2" onClick={() => { void store.flush().catch(() => {}).then(onLogout); }}><LogOut className="h-[0.9375rem] w-[0.9375rem]" />退出并清除本地记录</Button>
      </section>
      <section id="settings-panel-providers" role="tabpanel" aria-labelledby="settings-tab-providers" hidden={tab !== 'providers'}>
        <ProviderEditor store={store} settings={settings} open={open} active={tab === 'providers'} />
      </section>
      <section id="settings-panel-chat" role="tabpanel" aria-labelledby="settings-tab-chat" hidden={tab !== 'chat'} className="space-y-4">
        <label className="flex items-center gap-3 text-sm"><Checkbox aria-label="显示思考内容" checked={settings.showReasoning} onCheckedChange={(checked) => update({ ...settings, showReasoning: (checked === true) })} />显示供应商返回的思考内容</label>
        <div className="space-y-1"><label htmlFor="default-model" className="block text-sm font-medium">默认模型</label><NativeSelect id="default-model" className="w-full border-input" value={settings.activeProviderId ? JSON.stringify([settings.activeProviderId, settings.activeModel]) : ''} onChange={(event) => {
          const [activeProviderId, activeModel] = event.target.value ? JSON.parse(event.target.value) as [string, string] : [null, ''];
          update({ ...settings, activeProviderId, activeModel });
        }}><option value="">未选择模型</option>{settings.providers.map((profile) => <optgroup key={profile.id} label={profile.name}>{enabled.filter((item) => item.profile.id === profile.id).map(({ model }) => <option key={model.id} value={JSON.stringify([profile.id, model.id])}>{model.name || model.id}</option>)}</optgroup>)}</NativeSelect></div>
        <div className="space-y-1"><label htmlFor="provider-prompt" className="block text-sm font-medium">系统提示词</label><Textarea id="provider-prompt" rows={6} maxLength={20000} className="w-full border-input" value={settings.systemPrompt} onChange={(event) => update({ ...settings, systemPrompt: event.target.value })} /></div>
        <div className="space-y-1"><label htmlFor="provider-tokens" className="block text-sm font-medium">输出上限（Tokens）</label><Input id="provider-tokens" type="number" min={1} max={100000} step={1} placeholder="不设置" className="w-full border-input sm:max-w-48" value={settings.maxOutputTokens ?? ''} onChange={(event) => update({ ...settings, maxOutputTokens: event.target.value === '' ? null : Number(event.target.value) })} /></div>
      </section>
      <section id="settings-panel-presets" role="tabpanel" aria-labelledby="settings-tab-presets" hidden={tab !== 'presets'}>
        <PromptPresetsPanel open={open && tab === 'presets'} />
      </section>
      <section id="settings-panel-web-tools" role="tabpanel" aria-labelledby="settings-tab-web-tools" hidden={tab !== 'web-tools'}>
        <WebToolSettingsPanel active={open && tab === 'web-tools'} />
      </section>
    </div>
    </Tabs>
    {tab !== 'presets' && tab !== 'web-tools' && <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs sm:px-4 text-muted-foreground">
      <p data-testid="settings-save-status" role={status === 'error' ? 'alert' : 'status'}>{status === 'error' ? `未保存 · ${error}` : status === 'saving' ? '保存中…' : status === 'waiting' ? '保存中…' : '已保存'}</p>
      {status === 'error' && <Button variant="ghost" type="button" onClick={() => { void store.flush().catch(() => {}); }}>重试</Button>}
    </div>}

  </div></DisclosureScope>);
}
