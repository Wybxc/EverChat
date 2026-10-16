import { useMediaQuery } from '../../platform/useMediaQuery';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Modal, ModalTitle } from '../../components/Modal';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { NativeSelect } from '@/components/ui/native-select';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowLeft, Eye, EyeOff, LogOut, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { providerOptions } from '../../../shared/providers/endpoints';
import type { DiscoveredModel, ProviderModel } from '../../../shared/models/types';
import type { ProviderApiKind, ProviderProfile, ProviderSettings } from '../../../shared/providers/types';
import { api } from '../../platform/api';
import { SettingsAutosave } from './settings-autosave';
import { PromptPresetsPanel } from '../presets/PromptPresets';
import { ModelMetadataFields } from './ModelMetadataFields';
import { WebToolSettingsPanel } from '../web-tools/WebToolSettings';
import { Disclosure, DisclosureScope } from '../../components/Disclosure';
import { enrichModelCatalog } from '../../../shared/models/catalog';
import { loadModelCatalog } from './model-catalog';
import { modelProbeResultSchema, probeCapabilities, type ModelProbeResult } from '../../../shared/models/probe';
import * as v from 'valibot';

type PanelProps = { render: (content: ReactNode) => ReactNode; open: boolean; requestedTab?: SettingsTab; onSaved: (settings: ProviderSettings) => void; themeControl: ReactNode; onLogout: () => void };
const tabs = [{ id: 'general', label: '通用' }, { id: 'providers', label: '供应商' }, { id: 'chat', label: '对话' }, { id: 'presets', label: '预设' }, { id: 'web-tools', label: '联网' }] as const;
export type SettingsTab = (typeof tabs)[number]['id'];

type ProbeControls = { onTest: () => void; testing: boolean; results: ModelProbeResult[]; testError: string };
function probeIdentity(profile: ProviderProfile | null, model: ProviderModel | undefined, saved?: ProviderSettings) {
  const key = profile?.apiKey?.trim() || saved?.providers.find((item) => item.id === profile?.id)?.apiKey || '';
  return profile && model ? JSON.stringify([profile.id, profile.provider, profile.baseUrl.trim().replace(/\/+$/, ''), key, model.id.trim()]) : '';
}
function ModelOptions({ model, index, provider, globalPrompt, onChange, stateKey, ...probe }: {
  model: ProviderModel; index: number; provider: ProviderApiKind; globalPrompt: string; onChange: (patch: Partial<ProviderModel>) => void; stateKey: string;
} & ProbeControls) {
  return <div className="space-y-3 pt-2">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0 space-y-1"><span className="text-xs">ID</span><Input aria-label={`模型 ID ${index + 1}`} required maxLength={200} className="w-full border-input" value={model.id} onChange={(event) => onChange({ id: event.target.value })} /></label>
        <label className="min-w-0 space-y-1"><span className="text-xs">显示名</span><Input aria-label={`模型显示名 ${index + 1}`} maxLength={200} className="w-full border-input" value={model.name} placeholder={model.id} onChange={(event) => onChange({ name: event.target.value })} /></label>
      </div>
      <label className="flex items-center gap-2 text-sm"><Checkbox aria-label={`继承统一提示词 ${index + 1}`} checked={model.useGlobalSystemPrompt !== false} onCheckedChange={(checked) => onChange({ useGlobalSystemPrompt: (checked === true), systemPrompt: model.systemPrompt ?? globalPrompt })} />使用统一系统提示词</label>
      {model.useGlobalSystemPrompt === false && <label className="block space-y-2"><span className="text-sm">模型专属提示词</span><Textarea aria-label={`模型专属提示词 ${index + 1}`} rows={4} maxLength={20000} className="w-full border-input" value={model.systemPrompt ?? ''} onChange={(event) => onChange({ systemPrompt: event.target.value })} /></label>}
      <ModelMetadataFields provider={provider} model={model} index={index} onChange={onChange} stateKey={stateKey} {...probe} />
  </div>;
}

export function ProviderSettingsPanel(props: PanelProps) {
  const query = useQuery({
    queryKey: ['provider-settings'], queryFn: () => api<ProviderSettings>('/settings/providers'), enabled: props.open,
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  if (!query.data && query.isError) return props.render(<div className="space-y-3 p-6"><p role="alert" className="text-sm">{query.error.message}</p><Button variant="secondary" onClick={() => void query.refetch()}>重新读取</Button></div>);
  if (!query.data) return props.render(<div role="status" className="py-6 text-center"><Spinner aria-label="正在读取设置" /></div>);
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

function ProviderManager({ initial, open, render, requestedTab, onSaved, themeControl, onLogout }: PanelProps & { initial: ProviderSettings }) {
  const verticalTabs = useMediaQuery('(min-width: 40rem)');
  const queryClient = useQueryClient();
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const [store] = useState(() => new SettingsAutosave(initial,
    (input) => api<ProviderSettings>('/settings/providers', 'PUT', input),
    (result) => { queryClient.setQueryData(['provider-settings'], result); onSavedRef.current(result); },
  ));
  const { settings, status, error } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>('general');
  const catalogIdentity = JSON.stringify(settings.providers.map((profile) => [profile.id, profile.provider, profile.baseUrl, profile.models.map((model) => [model.id, model.directoryMetadata?.updatedAt ?? 0])]));
  useEffect(() => {
    if (!open || tab !== 'providers') return;
    let cancelled = false;
    void loadModelCatalog().then((catalog) => {
      if (cancelled || !catalog) return;
      const current = store.getSnapshot().settings;
      let changed = false;
      const providers = current.providers.map((profile) => ({ ...profile, models: profile.models.map((model) => {
        const enriched = enrichModelCatalog(profile.provider, model, catalog.data, catalog.updatedAt);
        changed ||= enriched !== model; return enriched;
      }) }));
      if (changed) store.update({ ...current, providers });
    });
    return () => { cancelled = true; };
  }, [open, tab, catalogIdentity, store]);
  const [selectedId, setSelectedId] = useState(initial.activeProviderId ?? initial.providers[0]?.id ?? null);
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [newName, setNewName] = useState('');
  const [addingModel, setAddingModel] = useState(false);
  const newModelInput = useRef<HTMLInputElement>(null), providerNameInput = useRef<HTMLInputElement>(null);
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [editingModel, setEditingModel] = useState<number | null>(null);
  const [testing, setTesting] = useState(false), [testResults, setTestResults] = useState<ModelProbeResult[]>([]), [testError, setTestError] = useState('');
  const probeController = useRef<AbortController | null>(null);
  const [modelListRevision, setModelListRevision] = useState(0);
  const [modelFilter, setModelFilter] = useState('');
  const [removal, setRemoval] = useState<{ kind: 'provider' | 'model'; providerId: string; index?: number; name: string } | null>(null);
  const cancelDeletion = useRef<HTMLButtonElement>(null);
  const addProviderButton = useRef<HTMLButtonElement>(null), fetchModelsButton = useRef<HTMLButtonElement>(null);
  const providerList = useRef<HTMLDivElement>(null), detailBack = useRef<HTMLButtonElement>(null);
  const focusDetails = () => requestAnimationFrame(() => {
    if (detailBack.current?.checkVisibility()) detailBack.current.focus({ preventScroll: true });
  });
  const wasOpen = useRef(open);
  useEffect(() => { if (open && requestedTab) setTab(requestedTab); }, [open, requestedTab]);
  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => {
    if (!open) { setShowKey(false); setEditingModel(null); setAddingModel(false); void store.flush().catch(() => {}); }
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
  const savedSettings = () => queryClient.getQueryData<ProviderSettings>(['provider-settings']);
  const testingIdentity = probeIdentity(selected, editingModel === null ? undefined : selected?.models[editingModel], savedSettings());
  useEffect(() => {
    probeController.current?.abort(); probeController.current = null;
    setTesting(false); setTestResults([]); setTestError('');
    return () => { probeController.current?.abort(); probeController.current = null; };
  }, [open, selectedId, editingModel, testingIdentity]);
  useEffect(() => { setAddingModel(false); setEditingModel(null); }, [selectedId]);
  const update = (next: ProviderSettings, chooseIfEmpty = false) => { setNotice(''); store.update(reconcile(next, chooseIfEmpty)); };
  const changeProvider = (id: string, patch: Partial<ProviderProfile>) => {
    const current = store.getSnapshot().settings;
    const profile = current.providers.find((profile) => profile.id === id)!;
    const endpointChanged = patch.baseUrl !== undefined && patch.baseUrl.trim().replace(/\/+$/, '') !== profile.baseUrl.trim().replace(/\/+$/, '');
    const connectionChanged = endpointChanged || Boolean(patch.provider && patch.provider !== profile.provider);
    const keyChanged = Boolean(patch.apiKey?.trim() && patch.apiKey.trim() !== profile.apiKey?.trim());
    if (patch.models && patch.models.length < profile.models.length) setModelListRevision((value) => value + 1);
    update({ ...current, providers: current.providers.map((profile) => profile.id === id
      ? { ...profile, ...patch,
        models: (patch.models ?? profile.models).map((model) => connectionChanged ? { ...model, reportedMetadata: undefined, directoryMetadata: undefined, testedCapabilities: undefined }
          : keyChanged ? { ...model, testedCapabilities: undefined } : model) } : profile) });
  };
  const changeModel = (index: number, patch: Partial<ProviderModel>) => {
    if (!selected) return;
    const current = store.getSnapshot().settings;
    const profile = current.providers.find((profile) => profile.id === selected.id)!;
    const previous = profile.models[index];
    update({ ...current, providers: current.providers.map((item) => item.id === profile.id
      ? { ...item, models: item.models.map((model, i) => i === index ? { ...model, ...patch,
        ...(patch.id !== undefined && patch.id.trim() !== model.id ? { reportedMetadata: undefined, directoryMetadata: undefined, testedCapabilities: undefined } : {}) } : model) } : item),
      ...(current.activeProviderId === profile.id && current.activeModel === previous.id && patch.id !== undefined ? { activeModel: patch.id } : {}),
    }, patch.enabled === true);
  };
  const addProvider = () => {
    const option = providerOptions[0];
    const profile: ProviderProfile = { id: crypto.randomUUID(), name: '', provider: option.value,
      baseUrl: option.baseUrl, models: [], hasApiKey: false };
    update({ ...settings, providers: [...settings.providers, profile] });
    setSelectedId(profile.id); setMobileDetail(true); setEditingModel(null); setModelFilter(''); setNewModel(''); setNewName(''); setShowKey(false);
    requestAnimationFrame(() => providerNameInput.current?.focus());
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
  const testModel = async (index: number) => {
    if (!selected || probeController.current) return;
    const target = selected, modelId = target.models[index].id.trim();
    const identity = probeIdentity(target, target.models[index], savedSettings()), controller = new AbortController();
    probeController.current = controller; setTesting(true); setTestResults([]); setTestError('');
    const currentTarget = () => {
      if (controller.signal.aborted) return;
      const current = store.getSnapshot().settings, profile = current.providers.find((item) => item.id === target.id);
      const model = profile?.models.find((item) => item.id === modelId);
      return profile && model && probeIdentity(profile, model, savedSettings()) === identity ? { current, profile, model } : undefined;
    };
    try {
      await store.flush();
      if (!currentTarget()) return;
      for (const capability of probeCapabilities) {
        const result = v.parse(modelProbeResultSchema, await api(`/settings/providers/${target.id}/models/test`, 'POST', { model: modelId, capability }, controller.signal));
        const latest = currentTarget(); if (!latest) return;
        if (result.capability !== capability) throw new Error('测试结果无效。');
        setTestResults((results) => [...results, result]);
        if (result.status === 'confirmed' && capability !== 'text') {
          const testedCapabilities = { ...latest.model.testedCapabilities, [capability]: true as const, testedAt: result.testedAt };
          store.update({ ...latest.current, providers: latest.current.providers.map((profile) => profile.id === target.id
            ? { ...profile, models: profile.models.map((model) => model.id === modelId ? { ...model, testedCapabilities } : model) } : profile) });
        }
        if (capability === 'text' && result.status !== 'confirmed') break;
      }
      await store.flush();
    } catch (error) { if (!controller.signal.aborted && currentTarget()) setTestError(error instanceof Error ? error.message : '测试失败。'); }
    finally { if (probeController.current === controller) { probeController.current = null; setTesting(false); } }
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

  return render(<DisclosureScope key={`${open}:${selectedId}:${modelListRevision}`}><div className="settings-fields flex min-h-0 flex-1 flex-col">
    <Tabs orientation={verticalTabs ? 'vertical' : 'horizontal'} value={tab} onValueChange={(value) => { setTab(value as SettingsTab); setShowKey(false); }} className="settings-tabs">
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
        <fieldset className="gap-4" disabled={Boolean(fetchingId)}>
          <legend className="sr-only">AI 供应商</legend>
          <div className="grid gap-4 md:grid-cols-[minmax(11rem,0.3fr)_minmax(0,0.7fr)]">
            <div ref={providerList} className={`${mobileDetail ? 'hidden md:flex' : 'flex'} min-w-0 flex-col gap-2`}>
              <div className="max-h-48 overflow-y-auto md:max-h-96">
                {settings.providers.map((profile) => <Button variant="ghost" type="button" key={profile.id} onClick={() => { setSelectedId(profile.id); setMobileDetail(true); setEditingModel(null); setModelFilter(''); setNewModel(''); setNewName(''); setNotice(''); setShowKey(false); focusDetails(); }} aria-current={selectedId === profile.id ? 'true' : undefined} className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm ${selectedId === profile.id ? 'bg-primary/10 text-foreground' : 'hover:bg-muted'}`}>
                  <span className="min-w-0 flex-1 truncate">{profile.name || '新供应商'}</span>
                  {settings.activeProviderId === profile.id && <Badge>默认</Badge>}
                  <span aria-label={profile.hasApiKey || profile.apiKey?.trim() ? '密钥已配置' : '密钥未配置'} className={`h-2 w-2 shrink-0 rounded-full ${profile.hasApiKey || profile.apiKey?.trim() ? 'bg-success' : 'bg-border'}`} />
                </Button>)}
                {!settings.providers.length && <p className="px-2 py-5 text-center text-sm text-muted-foreground">尚无供应商</p>}
              </div>
              <Button variant="outline" ref={addProviderButton} type="button" onClick={addProvider}><Plus className="h-[0.9375rem] w-[0.9375rem]" />添加供应商</Button>
            </div>
            {selected ? <div className={`${mobileDetail ? '' : 'hidden md:block'} provider-details min-w-0 space-y-3`} onFocusCapture={() => setMobileDetail(true)}>
              <Button variant="ghost" ref={detailBack} type="button" className="h-11 gap-2 md:hidden" onClick={() => { setMobileDetail(false); setShowKey(false); requestAnimationFrame(() => providerList.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus({ preventScroll: true })); }}><ArrowLeft className="h-[1rem] w-[1rem]" />供应商列表</Button>
              <div className="flex items-center gap-2"><h3 className="min-w-0 flex-1 truncate text-lg font-semibold">{selected.name || '新供应商'}</h3><Button variant="ghost" size="icon" type="button" className="text-destructive" aria-label={`删除供应商 ${selected.name}`} onClick={() => setRemoval({ kind: 'provider', providerId: selected.id, name: selected.name })}><Trash2 className="h-[1rem] w-[1rem]" /></Button></div>
              <div className="provider-connection">
              <div className="space-y-1"><label htmlFor="provider-name" className="block text-sm font-medium">名称</label><Input ref={providerNameInput} id="provider-name" required maxLength={100} aria-invalid={!selected.name.trim() || undefined} aria-describedby={!selected.name.trim() ? 'provider-name-error' : undefined} className="w-full border-input" value={selected.name} onChange={(event) => changeProvider(selected.id, { name: event.target.value })} />{!selected.name.trim() && <p id="provider-name-error" className="text-xs">名称不能为空。</p>}</div>
              <div className="space-y-1"><label htmlFor="provider-protocol" className="block text-sm font-medium">API 类型</label><NativeSelect id="provider-protocol" className="w-full border-input" value={selected.provider} onChange={(event) => {
                changeProvider(selected.id, { provider: event.target.value as ProviderApiKind });
              }}>{providerOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</NativeSelect></div>
              <div className="space-y-1"><label htmlFor="provider-url" className="block text-sm font-medium">API 端点</label><Input id="provider-url" type="url" required maxLength={2048} className="w-full border-input" value={selected.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => changeProvider(selected.id, { baseUrl: event.target.value })} /></div>
              <div className="space-y-1"><label htmlFor="provider-key" className="block text-sm font-medium">API 密钥</label><div className="field-control flex w-full items-center gap-2 border-input pr-1">
                <input id="provider-key" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={4096} className="min-w-0 flex-1" value={selected.apiKey ?? ''} placeholder={selected.hasApiKey ? '已配置 · 留空保留' : '输入 API 密钥'} onChange={(event) => changeProvider(selected.id, { apiKey: event.target.value })} />
                <Button variant="ghost" size="icon" type="button" aria-label={showKey ? '隐藏 API 密钥' : '显示 API 密钥'} aria-pressed={showKey} onClick={() => setShowKey((current) => !current)}>{showKey ? <EyeOff className="h-[1.0625rem] w-[1.0625rem]" /> : <Eye className="h-[1.0625rem] w-[1.0625rem]" />}</Button>
              </div></div>
              </div>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">模型</h4><span className="flex-1 text-xs text-muted-foreground">已启用 {selected.models.filter((model) => model.enabled).length} / {selected.models.length}</span><Button variant="ghost" ref={fetchModelsButton} type="button" disabled={!(selected.hasApiKey || selected.apiKey?.trim()) || Boolean(fetchingId)} onClick={() => void fetchModels()}>{fetchingId === selected.id ? <Spinner /> : <RefreshCw className="h-[0.875rem] w-[0.875rem]" />}获取</Button></div>
                {selected.models.length > 1 && <label className="field-control h-11 w-full gap-2 border-input"><Search className="h-[0.9375rem] w-[0.9375rem]" /><input aria-label="筛选模型" placeholder="筛选模型" value={modelFilter} onChange={(event) => { setModelFilter(event.target.value); setEditingModel(null); }} /></label>}
                {selected.models.length > 0 && <div className="divide-y divide-border">
                  {selected.models.map((model, index) => {
                    if (editingModel !== index && !`${model.name} ${model.id}`.toLowerCase().includes(modelFilter.toLowerCase())) return null;
                    const expanded = editingModel === index;
                    return <div key={`${selected.id}-${index}`} data-testid="provider-model-row" className={`min-w-0 px-2 py-1 ${expanded ? 'bg-muted' : ''}`}>
                      <div className="flex min-w-0 items-center gap-2">
                        <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2">
                          <Checkbox className="shrink-0" aria-label={`启用模型 ${model.name || model.id}`} checked={model.enabled} onCheckedChange={(checked) => changeModel(index, { enabled: (checked === true) })} />
                          <span className="min-w-0"><span className="block truncate text-sm font-medium">{model.name || model.id}</span>{model.name && model.name !== model.id && <span className="block truncate text-xs text-muted-foreground">{model.id}</span>}</span>
                        </label>
                        <Button variant="ghost" size="icon" type="button" className="h-11 w-11 shrink-0" aria-label={`模型设置 ${index + 1}`} aria-expanded={expanded} aria-controls={`model-editor-${selected.id}-${index}`} onClick={() => setEditingModel(expanded ? null : index)}><Pencil className="h-[0.9375rem] w-[0.9375rem]" /></Button>
                      </div>
                      {expanded && <div id={`model-editor-${selected.id}-${index}`} className="space-y-2 pb-2">
                        <ModelOptions model={model} index={index} provider={selected.provider} globalPrompt={settings.systemPrompt} onChange={(patch) => changeModel(index, patch)} stateKey={`model:${index}`} onTest={() => void testModel(index)} testing={testing} results={testResults} testError={testError} />
                        <Button variant="ghost" type="button" aria-label={`删除模型 ${model.name || model.id || index + 1}`} onClick={() => setRemoval({ kind: 'model', providerId: selected.id, index, name: model.name || model.id })}><Trash2 className="h-[0.9375rem] w-[0.9375rem]" />删除模型</Button>
                      </div>}
                    </div>;
                  })}
                  {editingModel === null && modelFilter && !selected.models.some((model) => `${model.name} ${model.id}`.toLowerCase().includes(modelFilter.toLowerCase())) && <p className="py-4 text-sm text-muted-foreground">没有匹配的模型</p>}
                </div>}
                <Disclosure title="添加模型" open={addingModel} onOpenChange={(next) => { setAddingModel(next); if (next) requestAnimationFrame(() => newModelInput.current?.focus({ preventScroll: true })); }}>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input ref={newModelInput} aria-label="新模型 ID" maxLength={200} className="w-full border-input" placeholder="模型 ID" value={newModel} onChange={(event) => setNewModel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); addModel(); } }} />
                  <Input aria-label="新模型显示名" maxLength={200} className="w-full border-input" placeholder="显示名" value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); addModel(); } }} />
                  <div className="flex gap-2 sm:col-span-2"><Button variant="secondary" type="button" onClick={addModel} disabled={!newModel.trim()}><Plus className="h-[0.875rem] w-[0.875rem]" />添加</Button><Button variant="ghost" type="button" onClick={() => { setNewModel(''); setNewName(''); setAddingModel(false); }}>取消添加</Button></div>
                </div>
                </Disclosure>
              </div>
            </div> : <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">添加一个供应商开始配置</div>}
          </div>
        </fieldset>
        {notice && <p role="status" className="mt-4 text-sm">{notice}</p>}
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
    <Modal alert open={Boolean(removal)} onOpenChange={(next) => { if (!next) setRemoval(null); }} initialFocus={cancelDeletion} aria-labelledby="provider-removal-title">
      <div className="p-5 max-w-sm">
        <ModalTitle id="provider-removal-title" className="text-lg font-semibold">{removal?.kind === 'provider' ? '删除供应商' : '删除模型'}</ModalTitle>
        <p className="mt-4 break-words text-sm">删除“{removal?.name}”？此操作会自动保存，无法撤销。</p>
        <div className="dialog-actions"><Button variant="secondary" ref={cancelDeletion} type="button" onClick={() => setRemoval(null)}>取消</Button><Button variant="destructive" type="button" onClick={confirmRemoval}>确认删除</Button></div>
      </div>
    </Modal>
  </div></DisclosureScope>);
}
