import { Modal, ModalTitle } from './Modal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
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
import { Disclosure } from './Disclosure';
import { canAttemptCapability } from '../shared/model-metadata';

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
  const invalid = value !== null && (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)));
  return <label className="block space-y-1 text-sm"><span>{label}</span>
    <Input ref={input} type="number" aria-label={label} aria-invalid={invalid || undefined} className="w-full border-input" placeholder="未设置" min={min} max={max} step={integer ? 1 : 'any'} value={text} onChange={(event) => {
      setText(event.currentTarget.value);
      change(event.currentTarget.validity.badInput ? Number.NaN : event.currentTarget.value === '' ? null : event.currentTarget.valueAsNumber);
    }} />
  </label>;
}

export function ConversationSettingsDialog({ id, initial, model, models, effort, showReasoning, open, close, onDraft, managePresets, manageWebTools, focusTools = false }: {
  id: string | null; initial: ConversationSettings; model?: ChatModel; models: ChatModel[]; effort: ReasoningEffort | ''; showReasoning: boolean;
  open: boolean; close: () => void; onDraft: (settings: ConversationSettings) => void;
  managePresets: () => void;
  manageWebTools: () => void;
  focusTools?: boolean;
}) {
  const titleId = useId();
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
  const defaults = () => ({ prompt: true, generation: false, tools: focusTools || store.getSnapshot().settings.tools.length > 0, context: false });
  const [sections, setSections] = useState(defaults);
  useEffect(() => { if (cached?.dirty) store.update(withContextDefaults(cached.settings)); }, [cached, store]);
  useEffect(() => { store.receive(withContextDefaults(initial)); }, [initial, store]);
  useEffect(() => { onDraft(settings); }, [settings, onDraft]);
  useEffect(() => {
    if (open) { setSections(defaults()); }
    else { void store.flush().catch(() => {}); }
  }, [open, store, focusTools]);
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
  const validation = v.safeParse(conversationSettingsSchema, settings);
  const invalidGroups = new Set<keyof typeof sections>(!validation.success ? validation.issues.map((issue) => ['temperature', 'topP', 'maxOutputTokens', 'useGlobalMaxOutputTokens'].includes(String(issue.path?.[0]?.key)) ? 'generation' : issue.path?.[0]?.key === 'systemPrompt' ? 'prompt' : 'context') : []);
  const sectionProps = (name: keyof typeof sections) => ({ open: sections[name], forceOpen: invalidGroups.has(name), onOpenChange: (value: boolean) => setSections((current) => ({ ...current, [name]: value })) });
  const overrides = Number(settings.temperature !== null) + Number(settings.topP !== null) + Number(limitMode !== 'inherit');
  return <Modal open={open} onOpenChange={(next) => { if (!next) close(); }} aria-labelledby={titleId}>
    <div className="settings-dialog settings-fields w-full flex max-h-[85dvh] max-w-xl flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-1.5 sm:px-4">
        <ModalTitle id={titleId} className="text-lg font-semibold">{id ? '会话参数' : '新对话参数'}</ModalTitle>
        <div><Button variant="ghost" size="icon" onClick={close} aria-label="关闭会话参数"><X className="h-[1.125rem] w-[1.125rem]" /></Button></div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-3 pb-3 sm:px-4 sm:pb-4" onBlur={() => void store.flush().catch(() => {})}>
        <Disclosure title={<>系统提示词 <span className="ml-2 text-xs font-normal text-muted-foreground">{settings.systemPrompt === null ? '继承' : '会话自定义'}</span></>} {...sectionProps('prompt')}>
          <div className="space-y-3">
            <PromptPresetPicker open={open} apply={(systemPrompt) => update({ systemPrompt })} manage={() => { close(); managePresets(); }} />
            <label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={settings.systemPrompt !== null} onCheckedChange={(checked) => update({ systemPrompt: (checked === true) ? '' : null })} />自定义会话系统提示词</label>
            {settings.systemPrompt !== null && <label className="block space-y-1 text-sm"><span>会话系统提示词</span><Textarea className="min-h-32 w-full border-input" aria-label="会话系统提示词" maxLength={20000} value={settings.systemPrompt} onChange={(event) => update({ systemPrompt: event.currentTarget.value })} /></label>}
          </div>
        </Disclosure>
        <Disclosure title={<>生成参数 <span className="ml-2 text-xs font-normal text-muted-foreground">{overrides ? `${overrides} 项覆盖` : '默认'} · 输出{limitMode === 'inherit' ? '继承' : limitMode === 'unset' ? '未设置' : settings.maxOutputTokens}</span></>} {...sectionProps('generation')}>
          <div className="space-y-3">
            {support && (support.temperatureMax !== null || support.topPMin !== null) && <div className="grid gap-3 sm:grid-cols-2">
              {support.temperatureMax !== null && <NumberSetting label="Temperature" value={settings.temperature} min={0} max={support.temperatureMax} change={(temperature) => update({ temperature, ...(support.exclusive && temperature !== null ? { topP: null } : {}) })} />}
              {support.topPMin !== null && <NumberSetting label="Top P" value={settings.topP} min={support.topPMin} max={1} change={(topP) => update({ topP, ...(support.exclusive && topP !== null ? { temperature: null } : {}) })} />}
            </div>}
            <label className="block space-y-1 text-sm"><span>输出上限</span><NativeSelect className="w-full border-input" aria-label="输出上限方式" value={limitMode} onChange={(event) => update({ useGlobalMaxOutputTokens: event.currentTarget.value === 'inherit', maxOutputTokens: event.currentTarget.value === 'custom' ? settings.maxOutputTokens ?? 4096 : null })}>
              <option value="inherit">继承全局设置</option><option value="unset">未设置</option><option value="custom">自定义</option>
            </NativeSelect></label>
            {limitMode === 'custom' && <NumberSetting label="输出 Token 上限" value={settings.maxOutputTokens} min={1} max={100000} integer change={(maxOutputTokens) => update({ maxOutputTokens })} />}
          </div>
        </Disclosure>
        <div>
          <Disclosure title={<>联网工具 <span className="ml-2 text-xs font-normal text-muted-foreground">{settings.tools.length ? settings.tools.map((name) => name === 'web_search' ? '搜索' : '网页读取').join('、') : '关闭'}</span></>} {...sectionProps('tools')}>
            <div className="space-y-2">
              {WEB_TOOL_NAMES.map((name) => <label key={name} className="flex min-h-11 items-center justify-between gap-3 text-sm"><span>{name === 'web_search' ? '联网搜索' : '网页读取'}</span><Switch checked={settings.tools.includes(name)} disabled={!settings.tools.includes(name) && (!canAttemptCapability(model?.metadata, 'toolCalls') || !service.data?.hasApiKey)} onCheckedChange={(checked) => update({ tools: (checked === true) ? [...settings.tools, name] : settings.tools.filter((tool) => tool !== name) })} /></label>)}
              {!canAttemptCapability(model?.metadata, 'toolCalls') && <p className="text-xs text-muted-foreground">当前模型不支持工具调用。</p>}
              {model?.metadata.sources.toolCalls === 'fallback' && <p className="text-xs text-muted-foreground">工具能力未识别，可尝试。</p>}
              <Button variant="secondary" type="button" className="w-fit" onClick={() => { close(); manageWebTools(); }}>{service.data?.hasApiKey ? '联网服务设置' : '配置联网服务'}</Button>
            </div>
          </Disclosure>
          {service.isError && !service.data && <div className="flex items-center gap-2 text-xs"><span role="alert">无法读取联网服务配置。</span><Button variant="secondary" type="button" onClick={() => void service.refetch()}>重新读取</Button></div>}
          {(settings.tools.length > 0 || sections.tools) && <p className="text-xs text-muted-foreground">开启后可能增加搜索服务与模型费用。每个新对话默认关闭。</p>}
        </div>
        <div>
          <Disclosure title={<>上下文 <span className="ml-2 text-xs font-normal text-muted-foreground">摘要{settings.useSummaries ? '开' : '关'} · 自动压缩{compression.enabled ? '开' : '关'}</span></>} {...sectionProps('context')}>
            <div className="space-y-3">
              <label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={settings.useSummaries} onCheckedChange={(checked) => update({ useSummaries: (checked === true), ...(!(checked === true) ? { autoCompression: { ...compression, enabled: false } } : {}) })} />使用历史摘要</label>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberSetting label="上下文 Token 预算" value={settings.contextBudget} min={1} max={10000000} integer change={(contextBudget) => update({ contextBudget })} />
                <NumberSetting label="最近历史消息条数" value={settings.recentMessages} min={1} max={1000} integer change={(recentMessages) => update({ recentMessages })} />
              </div>
              <p className="text-xs text-muted-foreground">留空按模型窗口；预算包含系统提示词和本次输入，历史按完整轮次选取。</p>
              <label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={compression.enabled} onCheckedChange={(checked) => update({ useSummaries: (checked === true) || settings.useSummaries, autoCompression: { ...compression, enabled: (checked === true) } })} />自动压缩历史</label>
              {compression.enabled && <div className="space-y-3">
                <NumberSetting label="自动压缩阈值（%）" value={compression.threshold} min={50} max={95} integer change={(threshold) => update({ autoCompression: { ...compression, threshold: threshold ?? Number.NaN } })} />
                <label className="block space-y-1 text-sm"><span>自动摘要模型</span><NativeSelect className="w-full border-input" aria-label="自动摘要模型" value={compressionModel} onChange={(event) => {
                  const selected = models.find((item) => modelSelectionKey(item) === event.currentTarget.value);
                  update({ autoCompression: { ...compression, model: selected ? { providerId: selected.providerId, model: selected.model } : null } });
                }}>
                  <option value="">当前聊天模型</option>
                  {!compressionModelAvailable && <option value={compressionModel}>所选模型不可用</option>}
                  {models.map((item) => <option key={modelSelectionKey(item)} value={modelSelectionKey(item)}>{item.providerName} · {item.name}</option>)}
                </NativeSelect></label>
                <p className="text-xs text-muted-foreground">按摘要及未覆盖的完整历史估算触发；条数限制只用于压缩后的原文。失败后须主动重试。</p>
              </div>}
            </div>
          </Disclosure>
          {(compression.enabled || sections.context) && <p className="text-xs text-muted-foreground">开启后会额外调用摘要模型，产生供应商费用。原始消息保留。</p>}
        </div>
        {error && <p role="alert" className="text-sm">{error}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 sm:px-4">
        <span role="status" className="text-xs text-muted-foreground">{status === 'saved' ? id ? '已保存' : '已保存到本机' : status === 'saving' ? '保存中…' : status === 'waiting' ? '保存中…' : '未保存'}</span>
        <div className="flex flex-wrap gap-2"><Button variant="secondary" type="button" onClick={() => update({ ...DEFAULT_CONVERSATION_SETTINGS })}>恢复继承</Button>{status === 'error' && <Button variant="secondary" type="button" onClick={() => void store.flush().catch(() => {})}>重试保存</Button>}</div>
      </div>
    </div>
  </Modal>;
}
