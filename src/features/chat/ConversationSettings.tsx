import { MAX_MODEL_TOKENS } from '../../../shared/models/metadata';
import { MAX_SYSTEM_PROMPT_LENGTH } from '../../../shared/conversation/limits';
import { Modal, ModalTitle } from '../../components/Modal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { X } from 'lucide-react';
import * as v from 'valibot';
import type { ChatModel, ReasoningEffort } from '../../../shared/models/types';
import type { ConversationSettings } from '../../../shared/conversation/types';
import {
  conversationSettingsSchema,
  DEFAULT_CONVERSATION_SETTINGS,
  samplingSupport,
} from '../../../shared/conversation/settings';
import { Autosave } from '../../platform/autosave';
import { api } from '../../platform/api';
import { read, storageEpoch } from '../../platform/storage';
import { writeChatCache as write } from './cache';
import { PromptPresetPicker } from '../presets/PromptPresets';
import { modelSelectionKey } from '../../../shared/models/selection';
import { WEB_TOOL_NAMES } from '../../../shared/web-tools/tasks';
import { useWebToolSettings } from '../web-tools/web-tool-settings';
import { canAttemptCapability } from '../../../shared/models/metadata';

const withContextDefaults = (settings: ConversationSettings) =>
  settings.recentMessages === undefined ||
  settings.contextBudget === undefined ||
  settings.useSummaries === undefined ||
  settings.autoCompression === undefined ||
  settings.tools === undefined
    ? { ...DEFAULT_CONVERSATION_SETTINGS, ...settings }
    : settings;

const parameterTabs = [
  { id: 'general', label: '常规' },
  { id: 'context', label: '上下文' },
  { id: 'tools', label: '联网' },
] as const;
type ParameterTab = (typeof parameterTabs)[number]['id'];

function NumberSetting({
  label,
  value,
  min,
  max,
  integer = false,
  disabled = false,
  change,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  integer?: boolean;
  disabled?: boolean;
  change: (value: number | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    if (document.activeElement !== input.current) setText(value === null ? '' : String(value));
  }, [value]);
  const invalid =
    value !== null &&
    (!Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value)));
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      <Input
        ref={input}
        type="number"
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid || undefined}
        className="w-full border-input"
        placeholder="未设置"
        min={min}
        max={max}
        step={integer ? 1 : 'any'}
        value={text}
        onChange={(event) => {
          setText(event.currentTarget.value);
          change(
            event.currentTarget.validity.badInput
              ? Number.NaN
              : event.currentTarget.value === ''
                ? null
                : event.currentTarget.valueAsNumber,
          );
        }}
      />
    </label>
  );
}

export function ConversationSettingsDialog({
  id,
  initial,
  model,
  models,
  effort,
  open,
  close,
  onDraft,
  managePresets,
  manageWebTools,
  focusTools = false,
  toolsToggleRef,
  presetChangeRef,
  defaultOutputBudget,
}: {
  id: string | null;
  initial: ConversationSettings;
  model?: ChatModel;
  models: ChatModel[];
  effort: ReasoningEffort | '';
  open: boolean;
  close: () => void;
  onDraft: (settings: ConversationSettings) => void;
  managePresets: () => void;
  manageWebTools: () => void;
  focusTools?: boolean;
  toolsToggleRef?: RefObject<(() => void) | null>;
  presetChangeRef?: RefObject<((prompt: string | null) => void) | null>;
  defaultOutputBudget?: number | null;
}) {
  const titleId = useId();
  const scroll = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<ParameterTab>(focusTools ? 'tools' : 'general');
  const service = useWebToolSettings(open);
  const draftKey = `conversation-settings-draft:${id ?? 'new'}`;
  const [cached] = useState(() => {
    const value = read<{ settings: ConversationSettings; dirty: boolean } | null>(draftKey, null);
    return value && v.safeParse(conversationSettingsSchema, value.settings).success ? value : null;
  });
  const [store] = useState(() => {
    const epoch = storageEpoch();
    const autosave = new Autosave(
      withContextDefaults(cached?.dirty ? cached.settings : initial),
      async (settings: ConversationSettings) => {
        if (epoch !== storageEpoch()) throw new Error('登录状态已改变。');
        if (id) return api<ConversationSettings>(`/conversations/${id}/settings`, 'PUT', settings);
        write('conversation-settings:new', settings);
        return settings;
      },
      (settings) => {
        if (epoch === storageEpoch() && autosave.getSnapshot().status === 'saved')
          write(draftKey, { settings, dirty: false });
      },
      (_saved, draft) => {
        const result = v.safeParse(conversationSettingsSchema, draft);
        if (!result.success)
          throw new Error(
            '请检查参数：Temperature 为 0–2，Top P 为 0–1；预算和条数须为正整数，自动压缩阈值为 50–95%。',
          );
        return result.output;
      },
    );
    return autosave;
  });
  const { settings, status, error } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    if (cached?.dirty) store.update(withContextDefaults(cached.settings));
  }, [cached, store]);
  useEffect(() => {
    store.receive(withContextDefaults(initial));
  }, [initial, store]);
  useEffect(() => {
    onDraft(settings);
  }, [settings, onDraft]);
  useEffect(() => {
    if (open) {
      setTab(focusTools ? 'tools' : 'general');
    } else {
      void store.flush().catch(() => {});
    }
  }, [open, store, focusTools]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [tab, open]);
  useEffect(() => {
    const retry = () => {
      void store.flush().catch(() => {});
    };
    window.addEventListener('everchat:network-ready', retry);
    return () => {
      window.removeEventListener('everchat:network-ready', retry);
      void store.flush().catch(() => {});
      store.dispose();
    };
  }, [store]);
  const update = (patch: Partial<ConversationSettings>) => {
    const settings = { ...store.getSnapshot().settings, ...patch };
    if (v.safeParse(conversationSettingsSchema, settings).success)
      write(draftKey, { settings, dirty: true });
    store.update(settings);
  };
  useEffect(() => {
    if (!presetChangeRef) return;
    presetChangeRef.current = (systemPrompt) => update({ systemPrompt });
    return () => {
      presetChangeRef.current = null;
    };
  }, [store, presetChangeRef]);
  useEffect(() => {
    if (!toolsToggleRef) return;
    toolsToggleRef.current = () =>
      update({ tools: store.getSnapshot().settings.tools.length ? [] : [...WEB_TOOL_NAMES] });
    return () => {
      toolsToggleRef.current = null;
    };
  }, [store, toolsToggleRef]);
  const support = model
    ? samplingSupport({
        ...model,
        reasoningEnabled: model.reasoningSupported,
        reasoningEffort: effort || undefined,
      })
    : null;
  const limitMode = settings.useGlobalMaxOutputTokens
    ? 'inherit'
    : settings.maxOutputTokens === null
      ? 'unset'
      : 'custom';
  const compression = settings.autoCompression;
  const compressionModel = compression.model ? modelSelectionKey(compression.model) : '';
  const compressionModelAvailable =
    !compression.model || models.some((item) => modelSelectionKey(item) === compressionModel);
  const validation = v.safeParse(conversationSettingsSchema, settings);
  const invalidField = validation.success ? null : String(validation.issues[0]?.path?.[0]?.key);
  const invalidTab: ParameterTab | null =
    invalidField === null
      ? null
      : ['systemPrompt', 'temperature', 'topP'].includes(invalidField)
        ? 'general'
        : invalidField === 'tools'
          ? 'tools'
          : 'context';
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      aria-labelledby={titleId}
    >
      <div className="settings-dialog settings-fields flex h-[38rem] max-h-[85dvh] w-full max-w-xl flex-col overflow-hidden p-0">
        <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-1.5 sm:px-4">
          <ModalTitle id={titleId} className="text-lg font-semibold">
            {id ? '会话参数' : '新对话参数'}
          </ModalTitle>
          <Button variant="ghost" size="icon" onClick={close} aria-label="关闭会话参数">
            <X className="h-[1.125rem] w-[1.125rem]" />
          </Button>
        </div>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as ParameterTab)}
          className="min-h-0 flex-1 flex-col gap-0"
        >
          <TabsList
            variant="line"
            aria-label="会话参数分类"
            className="mx-3 w-auto shrink-0 self-stretch justify-start px-0 aria-[orientation=horizontal]:h-auto sm:mx-4"
          >
            {parameterTabs.map((item) => (
              <TabsTrigger
                key={item.id}
                id={`${titleId}-tab-${item.id}`}
                value={item.id}
                aria-controls={`${titleId}-panel-${item.id}`}
              >
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div
            ref={scroll}
            data-testid="conversation-settings-scroll"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4"
            onBlur={() => void store.flush().catch(() => {})}
          >
            <section
              role="tabpanel"
              id={`${titleId}-panel-general`}
              aria-labelledby={`${titleId}-tab-general`}
              hidden={tab !== 'general'}
              className="space-y-4"
            >
              <div className="space-y-3">
                <PromptPresetPicker
                  open={open}
                  prompt={settings.systemPrompt}
                  apply={(systemPrompt) => update({ systemPrompt })}
                  manage={() => {
                    close();
                    managePresets();
                  }}
                />
                {settings.systemPrompt !== null && (
                  <label className="block space-y-1 text-sm">
                    <span>会话系统提示词</span>
                    <Textarea
                      className="min-h-32 w-full border-input"
                      aria-label="会话系统提示词"
                      maxLength={MAX_SYSTEM_PROMPT_LENGTH}
                      value={settings.systemPrompt}
                      onChange={(event) => update({ systemPrompt: event.currentTarget.value })}
                    />
                  </label>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberSetting
                  label="Temperature"
                  value={settings.temperature}
                  min={0}
                  max={support?.temperatureMax ?? 2}
                  disabled={!support || support.temperatureMax === null}
                  change={(temperature) =>
                    update({
                      temperature,
                      ...(support?.exclusive && temperature !== null ? { topP: null } : {}),
                    })
                  }
                />
                <NumberSetting
                  label="Top P"
                  value={settings.topP}
                  min={support?.topPMin ?? 0}
                  max={1}
                  disabled={!support || support.topPMin === null}
                  change={(topP) =>
                    update({
                      topP,
                      ...(support?.exclusive && topP !== null ? { temperature: null } : {}),
                    })
                  }
                />
              </div>
              {(!support || support.temperatureMax === null || support.topPMin === null) && (
                <p className="text-xs text-muted-foreground">
                  {!support
                    ? '请先选择模型。'
                    : `当前模型不支持调整 ${[support.temperatureMax === null ? 'Temperature' : '', support.topPMin === null ? 'Top P' : ''].filter(Boolean).join('、')}。`}
                </p>
              )}
            </section>
            <section
              role="tabpanel"
              id={`${titleId}-panel-context`}
              aria-labelledby={`${titleId}-tab-context`}
              hidden={tab !== 'context'}
              className="space-y-3"
            >
              <label className="block space-y-1 text-sm">
                <span>输出预算</span>
                <NativeSelect
                  className="w-full border-input"
                  aria-label="输出预算方式"
                  value={limitMode}
                  onChange={(event) =>
                    update({
                      useGlobalMaxOutputTokens: event.currentTarget.value === 'inherit',
                      maxOutputTokens:
                        event.currentTarget.value === 'custom'
                          ? (settings.maxOutputTokens ?? 4096)
                          : null,
                    })
                  }
                >
                  <option value="inherit">
                    默认
                    {defaultOutputBudget
                      ? `（${defaultOutputBudget.toLocaleString()} Tokens）`
                      : '（不设置）'}
                  </option>
                  <option value="unset">不设置</option>
                  <option value="custom">自定义</option>
                </NativeSelect>
              </label>
              {limitMode === 'custom' && (
                <NumberSetting
                  label="输出 Token 预算"
                  value={settings.maxOutputTokens}
                  min={1}
                  max={MAX_MODEL_TOKENS}
                  integer
                  change={(maxOutputTokens) => update({ maxOutputTokens })}
                />
              )}
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <Checkbox
                  checked={settings.useSummaries}
                  onCheckedChange={(checked) =>
                    update({
                      useSummaries: checked === true,
                      ...(!(checked === true)
                        ? { autoCompression: { ...compression, enabled: false } }
                        : {}),
                    })
                  }
                />
                使用历史摘要
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberSetting
                  label="上下文 Token 预算"
                  value={settings.contextBudget}
                  min={1}
                  max={10000000}
                  integer
                  change={(contextBudget) => update({ contextBudget })}
                />
                <NumberSetting
                  label="最近历史消息条数"
                  value={settings.recentMessages}
                  min={1}
                  max={1000}
                  integer
                  change={(recentMessages) => update({ recentMessages })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                留空按模型窗口；预算包含系统提示词和本次输入，历史按完整轮次选取。
              </p>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <Checkbox
                  checked={compression.enabled}
                  onCheckedChange={(checked) =>
                    update({
                      useSummaries: checked === true || settings.useSummaries,
                      autoCompression: { ...compression, enabled: checked === true },
                    })
                  }
                />
                自动压缩历史
              </label>
              {compression.enabled && (
                <div className="space-y-3">
                  <NumberSetting
                    label="自动压缩阈值（%）"
                    value={compression.threshold}
                    min={50}
                    max={95}
                    integer
                    change={(threshold) =>
                      update({
                        autoCompression: { ...compression, threshold: threshold ?? Number.NaN },
                      })
                    }
                  />
                  <label className="block space-y-1 text-sm">
                    <span>自动摘要模型</span>
                    <NativeSelect
                      className="w-full border-input"
                      aria-label="自动摘要模型"
                      value={compressionModel}
                      onChange={(event) => {
                        const selected = models.find(
                          (item) => modelSelectionKey(item) === event.currentTarget.value,
                        );
                        update({
                          autoCompression: {
                            ...compression,
                            model: selected
                              ? { providerId: selected.providerId, model: selected.model }
                              : null,
                          },
                        });
                      }}
                    >
                      <option value="">当前聊天模型</option>
                      {!compressionModelAvailable && (
                        <option value={compressionModel}>所选模型不可用</option>
                      )}
                      {models.map((item) => (
                        <option key={modelSelectionKey(item)} value={modelSelectionKey(item)}>
                          {item.providerName} · {item.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <p className="text-xs text-muted-foreground">
                    按摘要及未覆盖的完整历史估算触发；条数限制只用于压缩后的原文。失败后须主动重试。
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                开启后会额外调用摘要模型，产生供应商费用。原始消息保留。
              </p>
            </section>
            <section
              role="tabpanel"
              id={`${titleId}-panel-tools`}
              aria-labelledby={`${titleId}-tab-tools`}
              hidden={tab !== 'tools'}
              className="space-y-3"
            >
              <div className="space-y-2">
                <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
                  <span>联网搜索</span>
                  <Switch
                    checked={settings.tools.length > 0}
                    disabled={
                      !settings.tools.length && !canAttemptCapability(model?.metadata, 'toolCalls')
                    }
                    onCheckedChange={(checked) =>
                      update({ tools: checked ? [...WEB_TOOL_NAMES] : [] })
                    }
                  />
                </label>
                {!canAttemptCapability(model?.metadata, 'toolCalls') && (
                  <p className="text-xs text-muted-foreground">当前模型不支持工具调用。</p>
                )}
                {model?.metadata.sources.toolCalls === 'fallback' && (
                  <p className="text-xs text-muted-foreground">工具能力未识别，可尝试。</p>
                )}
                <Button
                  variant="secondary"
                  type="button"
                  className="w-fit"
                  onClick={() => {
                    close();
                    manageWebTools();
                  }}
                >
                  {service.data?.hasApiKey ? '联网服务设置' : '配置联网服务'}
                </Button>
              </div>{' '}
              {service.isError && !service.data && (
                <div className="flex items-center gap-2 text-xs">
                  <span role="alert">无法读取联网服务配置。</span>
                  <Button variant="secondary" type="button" onClick={() => void service.refetch()}>
                    重新读取
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                开启后可能增加搜索服务与模型费用。每个新对话默认关闭。
              </p>
            </section>
          </div>
        </Tabs>
        <div className="shrink-0 space-y-2 border-t border-border px-3 py-2 sm:px-4">
          {error && (
            <div className="flex items-center justify-between gap-2">
              <p role="alert" className="text-sm">
                {error}
              </p>
              {invalidTab && invalidTab !== tab && (
                <Button
                  variant="ghost"
                  type="button"
                  className="shrink-0"
                  onClick={() => {
                    setTab(invalidTab);
                    requestAnimationFrame(() =>
                      scroll.current
                        ?.querySelector<HTMLElement>(
                          '[role="tabpanel"]:not([hidden]) [aria-invalid="true"]',
                        )
                        ?.focus(),
                    );
                  }}
                >
                  查看错误
                </Button>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span role="status" className="text-xs text-muted-foreground">
              {status === 'saved'
                ? id
                  ? '已保存'
                  : '已保存到本机'
                : status === 'saving'
                  ? '保存中…'
                  : status === 'waiting'
                    ? '保存中…'
                    : '未保存'}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                type="button"
                onClick={() => update({ ...DEFAULT_CONVERSATION_SETTINGS })}
              >
                恢复继承
              </Button>
              {status === 'error' && (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void store.flush().catch(() => {})}
                >
                  重试保存
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
