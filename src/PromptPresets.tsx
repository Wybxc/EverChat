import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import * as v from 'valibot';
import type { PromptPreset } from '../shared/types';
import { MAX_PROMPT_PRESETS, promptPresetInputSchema } from '../shared/prompt-presets';
import { Autosave } from './autosave';
import { api } from './api';
import { storageEpoch } from './storage';
import { discardPresetDraft, PRESET_QUERY, presetDrafts, publishPresets, savePresetDraft, usePromptPresets } from './prompt-presets';

export function PromptPresetPicker({ open, apply, manage }: { open: boolean; apply: (prompt: string) => void; manage: () => void }) {
  const query = usePromptPresets(open);
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2"><span className="text-sm">提示词预设</span><button type="button" className="btn btn-ghost btn-xs" onClick={manage}>管理预设</button></div>
    <select className="select w-full" aria-label="提示词预设" value="" disabled={!query.data?.length} onChange={(event) => {
      const preset = query.data?.find((preset) => preset.id === event.currentTarget.value);
      if (preset) apply(preset.systemPrompt);
    }}><option value="">{query.data?.length ? '选择并应用' : '暂无预设'}</option>{query.data?.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>
    {query.isError && <div className="flex items-center gap-2 text-xs"><span role="alert">无法更新预设</span><button type="button" className="btn btn-ghost btn-xs" onClick={() => void query.refetch()}>重新读取预设</button></div>}
  </div>;
}

export function PromptPresetsPanel({ open }: { open: boolean }) {
  const query = usePromptPresets(open);
  const [selection, setSelection] = useState<string | null>(null);
  const select = useRef<HTMLSelectElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((value) => value + 1), []);
  const removed = useCallback(() => { setSelection(null); setRevision((value) => value + 1); requestAnimationFrame(() => (select.current?.disabled ? addButton.current : select.current)?.focus()); }, []);
  const drafts = presetDrafts(), saved = query.data ?? [];
  const items = [...saved.map((preset) => drafts[preset.id] ?? preset), ...Object.values(drafts).filter((preset) => !saved.some((item) => item.id === preset.id))];
  const selected = items.find((preset) => preset.id === selection) ?? items[0];
  const add = () => {
    const preset = { id: crypto.randomUUID(), name: '新预设', systemPrompt: '', updatedAt: Date.now() };
    savePresetDraft(preset); setSelection(preset.id); changed();
  };
  const copy = (source: PromptPreset) => {
    const preset = { ...source, id: crypto.randomUUID(), name: source.name.trim() || '新预设', updatedAt: Date.now() };
    savePresetDraft(preset); setSelection(preset.id); changed();
  };
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-3">
      <select ref={select} className="select min-w-0 flex-1" aria-label="编辑预设" value={selected?.id ?? ''} disabled={!items.length} onChange={(event) => setSelection(event.currentTarget.value)}>
        {!items.length && <option value="">暂无预设</option>}{items.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
      </select>
      <button ref={addButton} type="button" className="btn btn-sm" disabled={items.length >= MAX_PROMPT_PRESETS} onClick={add}><Plus size={15} />添加预设</button>
    </div>
    {query.isError && <div className="flex flex-wrap items-center gap-2 text-sm"><span role="alert">{query.error.message}</span><button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>重新读取预设</button></div>}
    {selected && <PresetEditor key={selected.id} preset={selected} open={open} changed={changed} removed={removed} copy={copy} canCopy={items.length < MAX_PROMPT_PRESETS} />}
  </div>;
}

function PresetEditor({ preset, open, changed, removed, copy, canCopy }: { preset: PromptPreset; open: boolean; changed: () => void; removed: () => void; copy: (preset: PromptPreset) => void; canCopy: boolean }) {
  const queryClient = useQueryClient(), deleting = useRef(false), epoch = useRef(storageEpoch()).current;
  const name = useRef<HTMLInputElement>(null), cancel = useRef<HTMLButtonElement>(null), deleteButton = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false), [removeError, setRemoveError] = useState(''), [removing, setRemoving] = useState(false);
  const [cached] = useState(() => presetDrafts()[preset.id]);
  const [store] = useState(() => new Autosave(preset, async (draft: PromptPreset) => {
    if (epoch !== storageEpoch() || deleting.current) throw new Error('当前预设已关闭。');
    const parsed = v.safeParse(promptPresetInputSchema, { name: draft.name, systemPrompt: draft.systemPrompt });
    if (!parsed.success) throw new Error('预设名称为 1–100 字，系统提示词最多 20,000 字。');
    const saved = await api<PromptPreset>(`/settings/presets/${preset.id}`, 'PUT', parsed.output);
    if (epoch === storageEpoch()) await queryClient.cancelQueries({ queryKey: PRESET_QUERY });
    return saved;
  }, (saved) => {
    if (epoch !== storageEpoch() || deleting.current) return;
    const items = queryClient.getQueryData<PromptPreset[]>(PRESET_QUERY) ?? [];
    publishPresets(queryClient, items.some((item) => item.id === saved.id) ? items.map((item) => item.id === saved.id ? saved : item) : [...items, saved], epoch);
    if (store.getSnapshot().status === 'saved') discardPresetDraft(saved.id);
    changed();
  }, (_saved, draft) => draft));
  const { settings, status, error } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { if (cached) store.update(cached); }, [cached, store]);
  useEffect(() => { store.receive(preset); }, [preset, store]);
  useEffect(() => {
    const retry = () => { void store.flush().catch(() => {}); };
    window.addEventListener('online', retry);
    return () => { window.removeEventListener('online', retry); void store.flush().catch(() => {}); store.dispose(); };
  }, [store]);
  useEffect(() => { if (!open) void store.flush().catch(() => {}); }, [open, store]);
  useEffect(() => { if (cached && open) name.current?.focus(); }, [cached, open]);
  const update = (patch: Partial<PromptPreset>) => {
    const draft = { ...store.getSnapshot().settings, ...patch };
    if (v.safeParse(promptPresetInputSchema, { name: draft.name, systemPrompt: draft.systemPrompt }).success) savePresetDraft(draft);
    store.update(draft); changed();
  };
  const remove = async () => {
    deleting.current = true; store.dispose(); setRemoving(true); setRemoveError('');
    try {
      await api(`/settings/presets/${preset.id}`, 'DELETE');
      if (epoch !== storageEpoch()) return;
      await queryClient.cancelQueries({ queryKey: PRESET_QUERY });
      publishPresets(queryClient, (queryClient.getQueryData<PromptPreset[]>(PRESET_QUERY) ?? []).filter((item) => item.id !== preset.id), epoch);
      discardPresetDraft(preset.id); removed();
    } catch (error) { deleting.current = false; setRemoveError(error instanceof Error ? error.message : '删除失败，请重试。'); }
    finally { setRemoving(false); }
  };
  return <div className="space-y-5" onBlur={(event) => {
    if (!deleting.current && !(event.relatedTarget instanceof Element && event.relatedTarget.closest('button'))) void store.flush().catch(() => {});
  }}>
    <label className="block space-y-2 text-sm"><span>预设名称</span><input ref={name} aria-label="预设名称" className="input w-full" maxLength={100} value={settings.name} disabled={removing} onChange={(event) => update({ name: event.currentTarget.value })} /></label>
    <label className="block space-y-2 text-sm"><span>预设系统提示词</span><textarea aria-label="预设系统提示词" className="textarea min-h-48 w-full" maxLength={20000} rows={8} value={settings.systemPrompt} disabled={removing} onChange={(event) => update({ systemPrompt: event.currentTarget.value })} /></label>
    {error && <p role="alert" className="text-sm">{error}</p>}
    {removeError && <p role="alert" className="text-sm">{removeError}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span role="status" data-testid="preset-save-status" className="text-xs text-base-content/70">{status === 'saved' ? '已自动保存' : status === 'saving' ? '保存中…' : status === 'waiting' ? '待保存' : '未保存'}</span>
      <div className="flex flex-wrap gap-2">{status === 'error' && <><button type="button" className="btn btn-sm" onClick={() => void store.flush().catch(() => {})}>重试保存预设</button><button type="button" className="btn btn-sm" disabled={!canCopy} onClick={() => copy(settings)}>另存为新预设</button></>}
        <button ref={deleteButton} type="button" className="btn btn-ghost btn-sm" disabled={removing} onClick={() => { store.dispose(); setConfirming(true); requestAnimationFrame(() => cancel.current?.focus()); }}><Trash2 size={14} />删除预设</button>
      </div>
    </div>
    {confirming && <div role="group" aria-label="确认删除预设" className="space-y-3 rounded-box border border-base-content/30 p-4">
      <p className="text-sm">删除「{settings.name}」？</p><div className="flex flex-wrap gap-2">
        <button ref={cancel} type="button" className="btn btn-sm" disabled={removing} onClick={() => { setConfirming(false); requestAnimationFrame(() => deleteButton.current?.focus()); void store.flush().catch(() => {}); }}>取消删除预设</button>
        <button type="button" className="btn btn-sm" disabled={removing} onClick={() => void remove()}>确认删除预设</button>
      </div>
    </div>}
  </div>;
}
