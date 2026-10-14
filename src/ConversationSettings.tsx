import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import * as v from 'valibot';
import type { ChatModel, ConversationSettings, ReasoningEffort } from '../shared/types';
import { conversationSettingsSchema, DEFAULT_CONVERSATION_SETTINGS, samplingSupport } from '../shared/conversation-settings';
import { Autosave } from './autosave';
import { api } from './api';
import { read, storageEpoch, write } from './storage';

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

export function ConversationSettingsDialog({ id, initial, model, effort, showReasoning, open, close, onDraft }: {
  id: string | null; initial: ConversationSettings; model?: ChatModel; effort: ReasoningEffort | ''; showReasoning: boolean;
  open: boolean; close: () => void; onDraft: (settings: ConversationSettings) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  const draftKey = `conversation-settings-draft:${id ?? 'new'}`;
  const [cached] = useState(() => read<{ settings: ConversationSettings; dirty: boolean } | null>(draftKey, null));
  const [store] = useState(() => {
    const epoch = storageEpoch();
    const autosave = new Autosave(cached?.dirty ? cached.settings : initial, async (settings: ConversationSettings) => {
      if (epoch !== storageEpoch()) throw new Error('登录状态已改变。');
      if (id) return api<ConversationSettings>(`/conversations/${id}/settings`, 'PUT', settings);
      write('conversation-settings:new', settings); return settings;
    }, (settings) => {
      if (epoch === storageEpoch() && autosave.getSnapshot().status === 'saved') write(draftKey, { settings, dirty: false });
    }, (_saved, draft) => {
      const result = v.safeParse(conversationSettingsSchema, draft);
      if (!result.success) throw new Error('请检查参数：Temperature 为 0–2，Top P 为 0–1，输出上限为 1–100,000。');
      return result.output;
    });
    return autosave;
  });
  const { settings, status, error } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { if (cached?.dirty) store.update(cached.settings); }, [cached, store]);
  useEffect(() => { store.receive(initial); }, [initial, store]);
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
  return <dialog ref={dialog} className="modal" aria-labelledby={titleId} onClose={close}>
    <div className="modal-box flex max-h-[85dvh] max-w-xl flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-3 p-5">
        <h2 id={titleId} className="text-lg font-semibold">{id ? '会话参数' : '新对话参数'}</h2>
        <form method="dialog"><button className="btn btn-ghost btn-sm btn-square" aria-label="关闭会话参数"><X size={18} /></button></form>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5" onBlur={() => void store.flush().catch(() => {})}>
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
        {error && <p role="alert" className="text-sm">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-base-content/20 p-5">
        <span role="status" className="text-xs text-base-content/70">{status === 'saved' ? id ? '已保存' : '已保存到本机' : status === 'saving' ? '保存中…' : status === 'waiting' ? '等待保存…' : '未保存'}</span>
        <div className="flex gap-2"><button type="button" className="btn btn-sm" onClick={() => update({ ...DEFAULT_CONVERSATION_SETTINGS })}>恢复继承</button>{status === 'error' && <button type="button" className="btn btn-sm" onClick={() => void store.flush().catch(() => {})}>重试保存</button>}</div>
      </div>
    </div>
  </dialog>;
}
