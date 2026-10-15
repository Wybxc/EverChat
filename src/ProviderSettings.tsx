import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowLeft, Eye, EyeOff, LogOut, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { providerOptions } from '../shared/providers';
import type { DiscoveredModel, ProviderApiKind, ProviderModel, ProviderProfile, ProviderSettings } from '../shared/types';
import { api } from './api';
import { SettingsAutosave } from './settings-autosave';
import { PromptPresetsPanel } from './PromptPresets';
import { ModelMetadataFields } from './ModelMetadataFields';
import { WebToolSettingsPanel } from './WebToolSettings';

type PanelProps = { open: boolean; requestedTab?: SettingsTab; onSaved: (settings: ProviderSettings) => void; themeControl: ReactNode; onLogout: () => void };
const tabs = [{ id: 'general', label: '通用' }, { id: 'providers', label: '供应商' }, { id: 'chat', label: '对话' }, { id: 'presets', label: '预设' }, { id: 'web-tools', label: '联网' }] as const;
export type SettingsTab = (typeof tabs)[number]['id'];

function ModelOptions({ model, index, provider, globalPrompt, onChange }: {
  model: ProviderModel; index: number; provider: ProviderApiKind; globalPrompt: string; onChange: (patch: Partial<ProviderModel>) => void;
}) {
  return <div className="space-y-4 border-t border-base-300 pt-4">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0 space-y-1"><span className="text-xs">ID</span><input aria-label={`模型 ID ${index + 1}`} required maxLength={200} className="input w-full border-base-content/50" value={model.id} onChange={(event) => onChange({ id: event.target.value })} /></label>
        <label className="min-w-0 space-y-1"><span className="text-xs">显示名</span><input aria-label={`模型显示名 ${index + 1}`} maxLength={200} className="input w-full border-base-content/50" value={model.name} placeholder={model.id} onChange={(event) => onChange({ name: event.target.value })} /></label>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="checkbox checkbox-sm" aria-label={`继承统一提示词 ${index + 1}`} checked={model.useGlobalSystemPrompt !== false} onChange={(event) => onChange({ useGlobalSystemPrompt: event.target.checked, systemPrompt: model.systemPrompt ?? globalPrompt })} />使用统一系统提示词</label>
      {model.useGlobalSystemPrompt === false && <label className="block space-y-2"><span className="text-sm">模型专属提示词</span><textarea aria-label={`模型专属提示词 ${index + 1}`} rows={4} maxLength={20000} className="textarea w-full border-base-content/50" value={model.systemPrompt ?? ''} onChange={(event) => onChange({ systemPrompt: event.target.value })} /></label>}
      <ModelMetadataFields provider={provider} model={model} index={index} onChange={onChange} />
  </div>;
}

export function ProviderSettingsPanel(props: PanelProps) {
  const query = useQuery({
    queryKey: ['provider-settings'], queryFn: () => api<ProviderSettings>('/settings/providers'), enabled: props.open,
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  if (!query.data && query.isError) return <div className="space-y-3 p-6"><p role="alert" className="text-sm">{query.error.message}</p><button className="btn btn-sm" onClick={() => void query.refetch()}>重新读取</button></div>;
  if (!query.data) return <div role="status" className="py-6 text-center"><span className="loading loading-spinner loading-sm" aria-label="正在读取设置" /></div>;
  return <ProviderManager initial={query.data} {...props} />;
}

function availableModels(settings: ProviderSettings) {
  return settings.providers.flatMap((profile) => profile.hasApiKey || profile.apiKey?.trim()
    ? profile.models.filter((model) => model.enabled && model.id.trim()).map((model) => ({ profile, model })) : []);
}
function reconcile(settings: ProviderSettings, chooseIfEmpty = false): ProviderSettings {
  const models = availableModels(settings);
  if (models.some(({ profile, model }) => profile.id === settings.activeProviderId && model.id === settings.activeModel)) return settings;
  if (!settings.activeProviderId && !chooseIfEmpty) return settings;
  return { ...settings, activeProviderId: models[0]?.profile.id ?? null, activeModel: models[0]?.model.id ?? '' };
}

function ProviderManager({ initial, open, requestedTab, onSaved, themeControl, onLogout }: PanelProps & { initial: ProviderSettings }) {
  const queryClient = useQueryClient();
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const [store] = useState(() => new SettingsAutosave(initial,
    (input) => api<ProviderSettings>('/settings/providers', 'PUT', input),
    (result) => { queryClient.setQueryData(['provider-settings'], result); onSavedRef.current(result); },
  ));
  const { settings, status, error } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>('general');
  const [selectedId, setSelectedId] = useState(initial.activeProviderId ?? initial.providers[0]?.id ?? null);
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [newName, setNewName] = useState('');
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [editingModel, setEditingModel] = useState<number | null>(null);
  const [modelFilter, setModelFilter] = useState('');
  const [removal, setRemoval] = useState<{ kind: 'provider' | 'model'; providerId: string; index?: number; name: string } | null>(null);
  const deletionDialog = useRef<HTMLDialogElement>(null), cancelDeletion = useRef<HTMLButtonElement>(null);
  const addProviderButton = useRef<HTMLButtonElement>(null), fetchModelsButton = useRef<HTMLButtonElement>(null);
  const providerList = useRef<HTMLDivElement>(null), detailBack = useRef<HTMLButtonElement>(null);
  const focusDetails = () => requestAnimationFrame(() => {
    if (detailBack.current?.checkVisibility()) detailBack.current.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (removal) { deletionDialog.current?.showModal(); cancelDeletion.current?.focus(); }
    else deletionDialog.current?.close();
  }, [removal]);
  const wasOpen = useRef(open);
  useEffect(() => { if (open && requestedTab) setTab(requestedTab); }, [open, requestedTab]);
  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => {
    if (!open) { setShowKey(false); void store.flush().catch(() => {}); }
    else if (!wasOpen.current) {
      void store.refresh(() => api<ProviderSettings>('/settings/providers')).catch(() => {});
    }
    wasOpen.current = open;
  }, [open, store]);
  useEffect(() => {
    if (selectedId && !settings.providers.some((profile) => profile.id === selectedId)) {
      setSelectedId(settings.activeProviderId ?? settings.providers[0]?.id ?? null); setShowKey(false);
    }
  }, [selectedId, settings]);
  useEffect(() => {
    const retry = () => { void store.flush().catch(() => {}); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [store]);
  const selected = settings.providers.find((profile) => profile.id === selectedId) ?? null;
  const update = (next: ProviderSettings, chooseIfEmpty = false) => { setNotice(''); store.update(reconcile(next, chooseIfEmpty)); };
  const changeProvider = (id: string, patch: Partial<ProviderProfile>) => {
    const current = store.getSnapshot().settings;
    const profile = current.providers.find((profile) => profile.id === id)!;
    const endpointChanged = Boolean((patch.provider && patch.provider !== profile.provider) ||
      (patch.baseUrl !== undefined && patch.baseUrl.trim().replace(/\/+$/, '') !== profile.baseUrl.trim().replace(/\/+$/, '')));
    if (endpointChanged) setShowKey(false);
    update({ ...current, providers: current.providers.map((profile) => profile.id === id
      ? { ...profile, ...(endpointChanged ? { apiKey: undefined, hasApiKey: false } : {}), ...patch,
        models: (patch.models ?? profile.models).map((model) => endpointChanged ? { ...model, reportedMetadata: undefined } : model) } : profile) });
  };
  const changeModel = (index: number, patch: Partial<ProviderModel>) => {
    if (!selected) return;
    const current = store.getSnapshot().settings;
    const profile = current.providers.find((profile) => profile.id === selected.id)!;
    const previous = profile.models[index];
    update({ ...current, providers: current.providers.map((item) => item.id === profile.id
      ? { ...item, models: item.models.map((model, i) => i === index ? { ...model, ...patch,
        ...(patch.id !== undefined && patch.id.trim() !== model.id ? { reportedMetadata: undefined } : {}) } : model) } : item),
      ...(current.activeProviderId === profile.id && current.activeModel === previous.id && patch.id !== undefined ? { activeModel: patch.id } : {}),
    }, patch.enabled === true);
  };
  const addProvider = () => {
    const option = providerOptions[0];
    const profile: ProviderProfile = { id: crypto.randomUUID(), name: option.label, provider: option.value,
      baseUrl: option.baseUrl, models: [], hasApiKey: false };
    update({ ...settings, providers: [...settings.providers, profile] });
    setSelectedId(profile.id); setMobileDetail(true); setEditingModel(null); setModelFilter(''); setNewModel(''); setNewName(''); setShowKey(false);
    focusDetails();
  };
  const removeProvider = (id: string) => {
    const providers = settings.providers.filter((profile) => profile.id !== id);
    update({ ...settings, providers });
    if (selectedId === id) { setSelectedId(providers[0]?.id ?? null); setMobileDetail(false); setEditingModel(null); setNewModel(''); setNewName(''); setShowKey(false); }
  };
  const fetchModels = async () => {
    if (!selected) return;
    const target = selected;
    setNotice(''); setFetchingId(target.id);
    try {
      await store.flush();
      const result = await api<{ models: DiscoveredModel[] }>(`/settings/providers/${target.id}/models`);
      const current = store.getSnapshot().settings;
      const profile = current.providers.find((profile) => profile.id === target.id);
      if (!profile || profile.provider !== target.provider || profile.baseUrl !== target.baseUrl) return;
      const existing = new Set(profile.models.map((model) => model.id));
      const discovered = new Map(result.models.map((model) => [model.id, model]));
      const models = [...profile.models.map((model) => discovered.has(model.id) ? { ...model, reportedMetadata: discovered.get(model.id)!.reportedMetadata } : model),
        ...result.models.filter((model) => !existing.has(model.id)).map((model) => ({ ...model, enabled: false }))].slice(0, 200);
      update({ ...current, providers: current.providers.map((profile) => profile.id === target.id ? { ...profile, models } : profile) });
      await store.flush();
      setNotice(`已获取 ${result.models.length} 个模型`);
    } catch (error) { setNotice(error instanceof Error ? error.message : '获取失败'); }
    finally { setFetchingId(null); }
  };
  const addModel = () => {
    if (!selected || !newModel.trim()) return;
    const id = newModel.trim();
    if (selected.models.some((model) => model.id === id)) { setNotice('模型 ID 已存在'); return; }
    if (selected.models.length >= 200) { setNotice('最多添加 200 个模型'); return; }
    update({ ...settings, providers: settings.providers.map((profile) => profile.id === selected.id
      ? { ...profile, models: [...profile.models, { id, name: newName.trim() || id, enabled: true }] } : profile) }, true);
    setNewModel(''); setNewName('');
  };
  const enabled = availableModels(settings);
  const confirmRemoval = () => {
    if (!removal) return;
    if (removal.kind === 'provider') removeProvider(removal.providerId);
    else {
      const current = store.getSnapshot().settings.providers.find((item) => item.id === removal.providerId);
      if (current) changeProvider(removal.providerId, { models: current.models.filter((_, index) => index !== removal.index) });
      setEditingModel(null);
    }
    setRemoval(null);
    requestAnimationFrame(() => (removal.kind === 'provider' ? addProviderButton.current : fetchModelsButton.current)?.focus({ preventScroll: true }));
  };

  return <div className="flex min-h-0 flex-1 flex-col">
    <div role="tablist" aria-label="设置分类" className="tabs tabs-border mx-4 shrink-0 flex-nowrap overflow-x-auto overscroll-contain sm:mx-6">
      {tabs.map((item) => <input key={item.id} id={`settings-tab-${item.id}`} type="radio" name="settings-tabs" role="tab" className="tab min-h-11 min-w-14 shrink-0 px-4 text-base-content/70 aria-selected:text-base-content" onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })} aria-label={item.label} aria-controls={`settings-panel-${item.id}`} aria-selected={tab === item.id} checked={tab === item.id} onChange={() => { setTab(item.id); setShowKey(false); }} />)}
    </div>
    <div data-testid="settings-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6" onBlur={(event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) void store.flush().catch(() => {});
    }}>
      <section id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general" hidden={tab !== 'general'} className="space-y-8">
        <div>{themeControl}</div>
        <button type="button" className="btn gap-2" onClick={() => { void store.flush().catch(() => {}).then(onLogout); }}><LogOut size={15} />退出并清除本地记录</button>
      </section>
      <section id="settings-panel-providers" role="tabpanel" aria-labelledby="settings-tab-providers" hidden={tab !== 'providers'}>
        <fieldset className="fieldset gap-4" disabled={Boolean(fetchingId)}>
          <legend className="fieldset-legend sr-only">AI 供应商</legend>
          <div className="grid gap-5 md:grid-cols-[minmax(11rem,0.3fr)_minmax(0,0.7fr)]">
            <div ref={providerList} className={`${mobileDetail ? 'hidden md:flex' : 'flex'} min-w-0 flex-col gap-2`}>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-box border border-base-content/30 p-2 md:max-h-96">
                {settings.providers.map((profile) => <button type="button" key={profile.id} onClick={() => { setSelectedId(profile.id); setMobileDetail(true); setEditingModel(null); setModelFilter(''); setNewModel(''); setNewName(''); setNotice(''); setShowKey(false); focusDetails(); }} aria-current={selectedId === profile.id ? 'true' : undefined} className={`flex min-h-11 w-full items-center gap-2 rounded-field px-3 text-left text-sm ${selectedId === profile.id ? 'bg-primary/10 text-base-content' : 'hover:bg-base-200'}`}>
                  <span className="min-w-0 flex-1 truncate">{profile.name || '新供应商'}</span>
                  {settings.activeProviderId === profile.id && <span className="badge badge-xs badge-outline">默认</span>}
                  <span aria-label={profile.hasApiKey || profile.apiKey?.trim() ? '密钥已配置' : '密钥未配置'} className={`h-2 w-2 shrink-0 rounded-full ${profile.hasApiKey || profile.apiKey?.trim() ? 'bg-success' : 'bg-base-300'}`} />
                </button>)}
                {!settings.providers.length && <p className="px-2 py-5 text-center text-sm text-base-content/70">尚无供应商</p>}
              </div>
              <button ref={addProviderButton} type="button" className="btn btn-outline btn-sm" onClick={addProvider}><Plus size={15} />添加供应商</button>
            </div>
            {selected ? <div className={`${mobileDetail ? '' : 'hidden md:block'} min-w-0 space-y-4`} onFocusCapture={() => setMobileDetail(true)}>
              <button ref={detailBack} type="button" className="btn btn-ghost h-11 gap-2 md:hidden" onClick={() => { setMobileDetail(false); setShowKey(false); requestAnimationFrame(() => providerList.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus({ preventScroll: true })); }}><ArrowLeft size={16} />供应商列表</button>
              <div className="flex items-center gap-2"><h3 className="min-w-0 flex-1 truncate text-lg font-semibold">{selected.name || '新供应商'}</h3><button type="button" className="btn btn-ghost btn-sm btn-square text-error" aria-label={`删除供应商 ${selected.name}`} onClick={() => setRemoval({ kind: 'provider', providerId: selected.id, name: selected.name })}><Trash2 size={16} /></button></div>
              <div className="space-y-2"><label htmlFor="provider-name" className="block text-sm font-medium">名称</label><input id="provider-name" required maxLength={100} className="input w-full border-base-content/50" value={selected.name} onChange={(event) => changeProvider(selected.id, { name: event.target.value })} /></div>
              <div className="space-y-2"><label htmlFor="provider-protocol" className="block text-sm font-medium">API 类型</label><select id="provider-protocol" className="select w-full border-base-content/50" value={selected.provider} onChange={(event) => {
                const option = providerOptions.find((item) => item.value === event.target.value as ProviderApiKind)!;
                changeProvider(selected.id, { provider: option.value, baseUrl: option.baseUrl, models: [] });
              }}>{providerOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
              <div className="space-y-2"><label htmlFor="provider-url" className="block text-sm font-medium">API 端点</label><input id="provider-url" type="url" required maxLength={2048} className="input w-full border-base-content/50" value={selected.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => changeProvider(selected.id, { baseUrl: event.target.value })} /></div>
              <div className="space-y-2"><label htmlFor="provider-key" className="block text-sm font-medium">API 密钥</label><div className="input flex w-full items-center gap-2 border-base-content/50 pr-1">
                <input id="provider-key" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={4096} className="min-w-0 flex-1" value={selected.apiKey ?? ''} placeholder={selected.hasApiKey ? '已配置 · 留空保留' : '输入 API 密钥'} onChange={(event) => changeProvider(selected.id, { apiKey: event.target.value })} />
                <button type="button" className="btn btn-ghost btn-sm btn-square" aria-label={showKey ? '隐藏 API 密钥' : '显示 API 密钥'} aria-pressed={showKey} onClick={() => setShowKey((current) => !current)}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button>
              </div></div>
              <div className="space-y-3 border-t border-base-content/30 pt-4">
                <div className="flex items-center gap-2"><h4 className="flex-1 text-sm font-semibold">模型</h4><button ref={fetchModelsButton} type="button" className="btn btn-ghost btn-sm" disabled={!(selected.hasApiKey || selected.apiKey?.trim()) || Boolean(fetchingId)} onClick={() => void fetchModels()}>{fetchingId === selected.id ? <span className="loading loading-spinner loading-xs" /> : <RefreshCw size={14} />}获取</button></div>
                {selected.models.length > 1 && <label className="input input-sm h-11 w-full gap-2 border-base-content/50"><Search size={15} /><input aria-label="筛选模型" placeholder="筛选模型" value={modelFilter} onChange={(event) => { setModelFilter(event.target.value); setEditingModel(null); }} /></label>}
                {selected.models.length > 0 && <div className="divide-y divide-base-300 rounded-box border border-base-300 px-3">
                  {selected.models.map((model, index) => {
                    if (editingModel !== index && !`${model.name} ${model.id}`.toLowerCase().includes(modelFilter.toLowerCase())) return null;
                    const expanded = editingModel === index;
                    return <div key={`${selected.id}-${index}`} data-testid="provider-model-row" className="min-w-0 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <label className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-3">
                          <input type="checkbox" className="checkbox checkbox-sm shrink-0" aria-label={`启用模型 ${model.name || model.id}`} checked={model.enabled} onChange={(event) => changeModel(index, { enabled: event.target.checked })} />
                          <span className="min-w-0"><span className="block truncate text-sm font-medium">{model.name || model.id}</span><span className="block truncate text-xs text-base-content/70">{model.id}</span></span>
                        </label>
                        <button type="button" className="btn btn-ghost btn-square h-11 w-11 shrink-0" aria-label={`模型设置 ${index + 1}`} aria-expanded={expanded} aria-controls={`model-editor-${selected.id}-${index}`} onClick={() => setEditingModel(expanded ? null : index)}><Pencil size={15} /></button>
                      </div>
                      {expanded && <div id={`model-editor-${selected.id}-${index}`} className="space-y-4 pb-2">
                        <ModelOptions model={model} index={index} provider={selected.provider} globalPrompt={settings.systemPrompt} onChange={(patch) => changeModel(index, patch)} />
                        <button type="button" className="btn btn-ghost btn-sm" aria-label={`删除模型 ${model.name || model.id || index + 1}`} onClick={() => setRemoval({ kind: 'model', providerId: selected.id, index, name: model.name || model.id })}><Trash2 size={15} />删除模型</button>
                      </div>}
                    </div>;
                  })}
                  {editingModel === null && modelFilter && !selected.models.some((model) => `${model.name} ${model.id}`.toLowerCase().includes(modelFilter.toLowerCase())) && <p className="py-4 text-sm text-base-content/70">没有匹配的模型</p>}
                </div>}
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <input aria-label="新模型 ID" maxLength={200} className="input input-sm w-full border-base-content/50" placeholder="模型 ID" value={newModel} onChange={(event) => setNewModel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addModel(); } }} />
                  <input aria-label="新模型显示名" maxLength={200} className="input input-sm w-full border-base-content/50" placeholder="显示名" value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addModel(); } }} />
                  <button type="button" className="btn btn-outline btn-sm" onClick={addModel} disabled={!newModel.trim()}><Plus size={14} />添加</button>
                </div>
              </div>
            </div> : <div className="flex min-h-48 items-center justify-center rounded-box border border-dashed border-base-content/30 text-sm text-base-content/70">添加一个供应商开始配置</div>}
          </div>
        </fieldset>
        {notice && <p role="status" className="mt-4 text-sm">{notice}</p>}
      </section>
      <section id="settings-panel-chat" role="tabpanel" aria-labelledby="settings-tab-chat" hidden={tab !== 'chat'} className="space-y-6">
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="checkbox" aria-label="显示思考内容" checked={settings.showReasoning} onChange={(event) => update({ ...settings, showReasoning: event.target.checked })} />显示供应商返回的思考内容</label>
        <div className="space-y-2"><label htmlFor="default-model" className="block text-sm font-medium">默认模型</label><select id="default-model" className="select w-full border-base-content/50" value={settings.activeProviderId ? JSON.stringify([settings.activeProviderId, settings.activeModel]) : ''} onChange={(event) => {
          const [activeProviderId, activeModel] = event.target.value ? JSON.parse(event.target.value) as [string, string] : [null, ''];
          update({ ...settings, activeProviderId, activeModel });
        }}><option value="">未选择模型</option>{settings.providers.map((profile) => <optgroup key={profile.id} label={profile.name}>{enabled.filter((item) => item.profile.id === profile.id).map(({ model }) => <option key={model.id} value={JSON.stringify([profile.id, model.id])}>{model.name || model.id}</option>)}</optgroup>)}</select></div>
        <div className="space-y-2"><label htmlFor="provider-prompt" className="block text-sm font-medium">系统提示词</label><textarea id="provider-prompt" rows={6} maxLength={20000} className="textarea w-full border-base-content/50" value={settings.systemPrompt} onChange={(event) => update({ ...settings, systemPrompt: event.target.value })} /></div>
        <div className="space-y-2"><label htmlFor="provider-tokens" className="block text-sm font-medium">输出上限（Tokens）</label><input id="provider-tokens" type="number" min={1} max={100000} step={1} placeholder="不设置" className="input w-full border-base-content/50 sm:max-w-48" value={settings.maxOutputTokens ?? ''} onChange={(event) => update({ ...settings, maxOutputTokens: event.target.value === '' ? null : Number(event.target.value) })} /></div>
      </section>
      <section id="settings-panel-presets" role="tabpanel" aria-labelledby="settings-tab-presets" hidden={tab !== 'presets'}>
        <PromptPresetsPanel open={open && tab === 'presets'} />
      </section>
      <section id="settings-panel-web-tools" role="tabpanel" aria-labelledby="settings-tab-web-tools" hidden={tab !== 'web-tools'}>
        <WebToolSettingsPanel active={open && tab === 'web-tools'} />
      </section>
    </div>
    {tab !== 'presets' && tab !== 'web-tools' && <div className="flex shrink-0 items-center justify-between gap-3 border-t border-base-content/30 px-4 py-3 text-xs sm:px-6 text-base-content/70">
      <p data-testid="settings-save-status" role={status === 'error' ? 'alert' : 'status'}>{status === 'error' ? `未保存 · ${error}` : status === 'saving' ? '保存中…' : status === 'waiting' ? '保存中…' : '已保存'}</p>
      {status === 'error' && <button type="button" className="btn btn-ghost btn-xs" onClick={() => { void store.flush().catch(() => {}); }}>重试</button>}
    </div>}
    <dialog ref={deletionDialog} className="modal" aria-labelledby="provider-removal-title" onClose={() => setRemoval(null)}>
      <div className="modal-box max-w-sm">
        <h3 id="provider-removal-title" className="text-lg font-semibold">{removal?.kind === 'provider' ? '删除供应商' : '删除模型'}</h3>
        <p className="mt-4 break-words text-sm">删除“{removal?.name}”？此操作会自动保存，无法撤销。</p>
        <div className="modal-action"><form method="dialog"><button ref={cancelDeletion} className="btn">取消</button></form><button type="button" className="btn btn-error" onClick={confirmRemoval}>确认删除</button></div>
      </div>
    </dialog>
  </div>;
}
