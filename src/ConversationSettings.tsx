import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import * as v from 'valibot';
import type { ChatModel, ConversationSettings, ReasoningEffort } from '../shared/types';
import { conversationSettingsSchema, DEFAULT_CONVERSATION_SETTINGS, samplingSupport } from '../shared/conversation-settings';
import { Autosave } from './autosave';
import { api } from './api';
import { read, storageEpoch, write } from './storage';
import { PromptPresetPicker } from './PromptPresets';
import { modelSelectionKey } from '../shared/models';
import { WEB_TOOL_NAMES } from '../shared/web-tools';
import { useWebToolSettings } from './web-tool-settings';

const withContextDefaults = (settings: ConversationSettings) => settings.recentMessages === undefined || settings.contextBudget === undefined || settings.useSummaries === undefined || settings.autoCompression === undefined || settings.tools === undefined
  ? { ...DEFAULT_CONVERSATION_SETTINGS, ...settings } : settings;

function NumberSetting({ label, value, min, max, integer = false, change }: {
  label: string; value: number | null; min: number; max: number; integer?: boolean; change: (value: number | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    if (document.activeElement !== input.current) setText(value === null ? '' : String(value));
  }, [value]);
  return <label className="block space-y-2 text-sm"><span>{label}</span>
    <input ref={input} type="number" aria-label={label} className="input w-full" placeholder="未设置" min={min} max={max} step={integer ? 1 : 'any'} value={text} onChange={(event) => {
      setText(event.currentTarget.value);
      change(event.currentTarget.validity.badInput ? Number.NaN : event.currentTarget.value === '' ? null : event.currentTarget.valueAsNumber);
    }} />
  </label>;
}

export function ConversationSettingsDialog({ id, initial, model, models, effort, showReasoning, open, close, onDraft, managePresets, manageWebTools }: {
  id: string | null; initial: ConversationSettings; model?: ChatModel; models: ChatModel[]; effort: ReasoningEffort | ''; showReasoning: boolean;
  open: boolean; close: () => void; onDraft: (settings: ConversationSettings) => void;
  managePresets: () => void;
  manageWebTools: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  const service = useWebToolSettings(open);
  const draftKey = `conversation-settings-draft:${id ?? 'new'}`;
  const [cached] = useState(() => {
    const value = read<{ settings: ConversationSettings; dirty: boolean } | null>(draftKey, null);
    return value && v.safeParse(conversationSettingsSchema, value.settings).success ? value : null;
  });
  const [store] = useState(() => {
    const epoch = storageEpoch();
    const autosave = new Autosave(withContextDefaults(cached?.dirty ? cached.settings : initial), async (settings: ConversationSettings) => {
      if (epoch !== storageEpoch()) throw new Error('登录状态已改变。');
      if (id) return api<ConversationSettings>(`/conversations/${id}/settings`, 'PUT', settings);
      write('conversation-settings:new', settings); return settings;
    }, (settings) => {
      if (epoch === storageEpoch() && autosave.getSnapshot().status === 'saved') write(draftKey, { settings, dirty: false });
    }, (_saved, draft) => {
      const result = v.safeParse(conversationSettingsSchema, draft);
      if (!result.success) throw new Error('请检查参数：Temperature 为 0–2，Top P 为 0–1；预算和条数须为正整数，自动压缩阈值为 50–95%。');
      return result.output;
    });
    return autosave;
  });
  const { settings, status, error } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { if (cached?.dirty) store.update(withContextDefaults(cached.settings)); }, [cached, store]);
  useEffect(() => { store.receive(withContextDefaults(initial)); }, [initial, store]);
  useEffect(() => { onDraft(settings); }, [settings, onDraft]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else { dialog.current?.close(); void store.flush().catch(() => {}); }
  }, [open, store]);
  useEffect(() => {
    const retry = () => { void store.flush().catch(() => {}); };
    window.addEventListener('online', retry);
    return () => { window.removeEventListener('online', retry); void store.flush().catch(() => {}); store.dispose(); };
  }, [store]);
  const update = (patch: Partial<ConversationSettings>) => {
    const settings = { ...store.getSnapshot().settings, ...patch };
    if (v.safeParse(conversationSettingsSchema, settings).success) write(draftKey, { settings, dirty: true });
    store.update(settings);
  };
  const support = model ? samplingSupport({ ...model, reasoningEnabled: model.reasoningSupported, reasoningEffort: effort || undefined, showReasoning }) : null;
  const limitMode = settings.useGlobalMaxOutputTokens ? 'inherit' : settings.maxOutputTokens === null ? 'unset' : 'custom';
  const compression = settings.autoCompression;
  const compressionModel = compression.model ? modelSelectionKey(compression.model) : '';
  const compressionModelAvailable = !compression.model || models.some((item) => modelSelectionKey(item) === compressionModel);
  return <dialog id={`conversation-settings-${titleId}`} ref={dialog} className="modal" aria-labelledby={titleId} onClose={close}>
    <div className="modal-box flex max-h-[85dvh] max-w-xl flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-3 p-5">
        <h2 id={titleId} className="text-lg font-semibold">{id ? '会话参数' : '新对话参数'}</h2>
        <form method="dialog"><button className="btn btn-ghost btn-sm btn-square" aria-label="关闭会话参数"><X size={18} /></button></form>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5" onBlur={() => void store.flush().catch(() => {})}>
        <PromptPresetPicker open={open} apply={(systemPrompt) => update({ systemPrompt })} manage={() => { dialog.current?.close(); close(); managePresets(); }} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="checkbox checkbox-sm" checked={settings.systemPrompt !== null} onChange={(event) => update({ systemPrompt: event.currentTarget.checked ? '' : null })} />自定义会话系统提示词</label>
        {settings.systemPrompt !== null && <label className="block space-y-2 text-sm"><span>会话系统提示词</span><textarea className="textarea min-h-32 w-full" aria-label="会话系统提示词" maxLength={20000} value={settings.systemPrompt} onChange={(event) => update({ systemPrompt: event.currentTarget.value })} /></label>}
        {support && (support.temperatureMax !== null || support.topPMin !== null) && <div className="grid gap-4 sm:grid-cols-2">
          {support.temperatureMax !== null && <NumberSetting label="Temperature" value={settings.temperature} min={0} max={support.temperatureMax} change={(temperature) => update({ temperature, ...(support.exclusive && temperature !== null ? { topP: null } : {}) })} />}
          {support.topPMin !== null && <NumberSetting label="Top P" value={settings.topP} min={support.topPMin} max={1} change={(topP) => update({ topP, ...(support.exclusive && topP !== null ? { temperature: null } : {}) })} />}
        </div>}
        <label className="block space-y-2 text-sm"><span>输出上限</span><select className="select w-full" aria-label="输出上限方式" value={limitMode} onChange={(event) => update({ useGlobalMaxOutputTokens: event.currentTarget.value === 'inherit', maxOutputTokens: event.currentTarget.value === 'custom' ? settings.maxOutputTokens ?? 4096 : null })}>
          <option value="inherit">继承全局设置</option><option value="unset">未设置</option><option value="custom">自定义</option>
        </select></label>
        {limitMode === 'custom' && <NumberSetting label="输出 Token 上限" value={settings.maxOutputTokens} min={1} max={100000} integer change={(maxOutputTokens) => update({ maxOutputTokens })} />}
        <fieldset className="fieldset border-t border-base-content/20 pt-3">
          <legend className="fieldset-legend">联网工具</legend>
          {WEB_TOOL_NAMES.map((name) => <label key={name} className="flex items-center justify-between gap-3 text-sm"><span>{name === 'web_search' ? '联网搜索' : '网页读取'}</span><input type="checkbox" className="toggle toggle-sm" checked={settings.tools.includes(name)} disabled={!settings.tools.includes(name) && (!model?.metadata.toolCalls || !service.data?.hasApiKey)} onChange={(event) => update({ tools: event.currentTarget.checked ? [...settings.tools, name] : settings.tools.filter((tool) => tool !== name) })} /></label>)}
          {!model?.metadata.toolCalls && <p className="text-xs text-base-content/70">当前模型未声明支持工具调用。</p>}
          {service.isError && !service.data && <div className="flex items-center gap-2 text-xs"><span role="alert">无法读取联网服务配置。</span><button type="button" className="btn btn-xs" onClick={() => void service.refetch()}>重新读取</button></div>}
          <button type="button" className="btn btn-sm w-fit" onClick={() => { dialog.current?.close(); close(); manageWebTools(); }}>{service.data?.hasApiKey ? '联网服务设置' : '配置联网服务'}</button>
          <p className="text-xs text-base-content/70">开启后可能增加搜索服务与模型费用。每个新对话默认关闭。</p>
        </fieldset>
        <fieldset className="fieldset border-t border-base-content/20 pt-3">
          <legend className="fieldset-legend">上下文</legend>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="checkbox checkbox-sm" checked={settings.useSummaries} onChange={(event) => update({ useSummaries: event.currentTarget.checked, ...(!event.currentTarget.checked ? { autoCompression: { ...compression, enabled: false } } : {}) })} />使用历史摘要</label>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberSetting label="上下文 Token 预算" value={settings.contextBudget} min={1} max={10000000} integer change={(contextBudget) => update({ contextBudget })} />
            <NumberSetting label="最近历史消息条数" value={settings.recentMessages} min={1} max={1000} integer change={(recentMessages) => update({ recentMessages })} />
          </div>
          <p className="text-xs text-base-content/70">留空按模型窗口；预算包含系统提示词和本次输入，历史按完整轮次选取。</p>
          <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" className="checkbox checkbox-sm" checked={compression.enabled} onChange={(event) => update({ useSummaries: event.currentTarget.checked || settings.useSummaries, autoCompression: { ...compression, enabled: event.currentTarget.checked } })} />自动压缩历史</label>
          <p className="text-xs text-base-content/70">开启后会额外调用摘要模型，产生供应商费用。原始消息保留。</p>
          {compression.enabled && <div className="space-y-3">
            <NumberSetting label="自动压缩阈值（%）" value={compression.threshold} min={50} max={95} integer change={(threshold) => update({ autoCompression: { ...compression, threshold: threshold ?? Number.NaN } })} />
            <label className="block space-y-2 text-sm"><span>自动摘要模型</span><select className="select w-full" aria-label="自动摘要模型" value={compressionModel} onChange={(event) => {
              const selected = models.find((item) => modelSelectionKey(item) === event.currentTarget.value);
              update({ autoCompression: { ...compression, model: selected ? { providerId: selected.providerId, model: selected.model } : null } });
            }}>
              <option value="">当前聊天模型</option>
              {!compressionModelAvailable && <option value={compressionModel}>所选模型不可用</option>}
              {models.map((item) => <option key={modelSelectionKey(item)} value={modelSelectionKey(item)}>{item.providerName} · {item.name}</option>)}
            </select></label>
            <p className="text-xs text-base-content/70">按摘要及未覆盖的完整历史估算触发；条数限制只用于压缩后的原文。失败后须主动重试。</p>
          </div>}
        </fieldset>
        {error && <p role="alert" className="text-sm">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-base-content/20 p-5">
        <span role="status" className="text-xs text-base-content/70">{status === 'saved' ? id ? '已保存' : '已保存到本机' : status === 'saving' ? '保存中…' : status === 'waiting' ? '等待保存…' : '未保存'}</span>
        <div className="flex gap-2"><button type="button" className="btn btn-sm" onClick={() => update({ ...DEFAULT_CONVERSATION_SETTINGS })}>恢复继承</button>{status === 'error' && <button type="button" className="btn btn-sm" onClick={() => void store.flush().catch(() => {})}>重试保存</button>}</div>
      </div>
    </div>
  </dialog>;
}
