import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ToastRegion } from '@/components/ui/toast';
import { X } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import * as v from 'valibot';
import { MAX_SYSTEM_PROMPT_LENGTH } from '../../../shared/conversation/limits';
import {
  conversationSettingsSchema,
  DEFAULT_CONVERSATION_SETTINGS,
  conversationSettingsDefaults,
  samplingSupport,
} from '../../../shared/conversation/settings';
import type { ConversationSettings } from '../../../shared/conversation/types';
import { canAttemptCapability, MAX_MODEL_TOKENS } from '../../../shared/models/metadata';
import { modelSelectionKey } from '../../../shared/models/selection';
import type { ChatModel, ReasoningEffort } from '../../../shared/models/types';
import { WEB_TOOL_NAMES } from '../../../shared/web-tools/tasks';
import { Modal, ModalTitle } from '../../components/Modal';
import { AutosaveToast } from '../../components/AutosaveToast';
import { api } from '../../platform/api';
import { Autosave } from '../../platform/autosave';
import { formatNumber } from '../../platform/i18n/format';
import { UiError, uiMessage } from '../../platform/i18n/messages';
import { read, storageEpoch } from '../../platform/storage';
import { PromptPresetPicker } from '../presets/PromptPresets';
import { useWebToolSettings } from '../web-tools/web-tool-settings';
import { writeChatCache as write } from './cache';
import './locales';

const withContextDefaults = conversationSettingsDefaults;

const parameterTabs = [
  { id: 'general', label: 'general' },
  { id: 'context', label: 'context' },
  { id: 'tools', label: 'webTools' },
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
  const { t } = useTranslation('chat', { useSuspense: false });

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
        placeholder={t(($) => $.notSet)}
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
  const { t } = useTranslation('chat', { useSuspense: false });

  const titleId = useId();
  const scroll = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<ParameterTab>(focusTools ? 'tools' : 'general');
  const service = useWebToolSettings(open);
  // Reuse one read-only projection in both the store initializer and receive effect.
  // Two copies can otherwise bounce through onDraft and the parent's initial prop.
  const initialSettings = useMemo(() => withContextDefaults(initial), [initial]);
  const draftKey = `conversation-settings-draft:${id ?? 'new'}`;
  const [cached] = useState(() => {
    const value = read<{ settings: ConversationSettings; dirty: boolean } | null>(draftKey, null);
    return value && v.safeParse(conversationSettingsSchema, value.settings).success ? value : null;
  });
  const [store] = useState(() => {
    const epoch = storageEpoch();
    const autosave = new Autosave(
      cached?.dirty ? withContextDefaults(cached.settings) : initialSettings,
      async (settings: ConversationSettings) => {
        if (epoch !== storageEpoch()) throw new UiError(uiMessage('chat', 'sessionChanged'));
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
        if (!result.success) throw new UiError(uiMessage('chat', 'invalidParameters'));
        return result.output;
      },
    );
    return autosave;
  });
  const { settings } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    if (cached?.dirty) store.update(withContextDefaults(cached.settings));
  }, [cached, store]);
  useEffect(() => {
    store.receive(initialSettings);
  }, [initialSettings, store]);
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
        <ToastRegion>
          <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-1.5 sm:px-4">
            <ModalTitle id={titleId} className="text-lg font-semibold">
              {id ? t(($) => $.chatParameters) : t(($) => $.newChatParameters)}
            </ModalTitle>
            <Button
              variant="ghost"
              size="icon"
              onClick={close}
              aria-label={t(($) => $.closeParameters)}
            >
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
              aria-label={t(($) => $.parameterCategories)}
              className="mx-3 w-auto shrink-0 self-stretch justify-start px-0 aria-[orientation=horizontal]:h-auto sm:mx-4"
            >
              {parameterTabs.map((item) => (
                <TabsTrigger
                  key={item.id}
                  id={`${titleId}-tab-${item.id}`}
                  value={item.id}
                  aria-controls={`${titleId}-panel-${item.id}`}
                >
                  {t(($) => $[item.label])}
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
                      <span>{t(($) => $.systemPrompt)}</span>
                      <Textarea
                        className="min-h-32 w-full border-input"
                        aria-label={t(($) => $.systemPrompt)}
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
                      ? t(($) => $.chooseModel)
                      : t(($) => $.unsupportedSampling, {
                          parameters: [
                            support.temperatureMax === null ? 'Temperature' : '',
                            support.topPMin === null ? 'Top P' : '',
                          ]
                            .filter(Boolean)
                            .join(', '),
                        })}
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
                  <span>{t(($) => $.outputBudget)}</span>
                  <NativeSelect
                    className="w-full border-input"
                    aria-label={t(($) => $.outputBudgetMode)}
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
                      {defaultOutputBudget
                        ? t(($) => $.defaultOutputBudget, {
                            tokens: formatNumber(defaultOutputBudget),
                          })
                        : t(($) => $.default)}
                    </option>
                    <option value="unset">{t(($) => $.unset)}</option>
                    <option value="custom">{t(($) => $.custom)}</option>
                  </NativeSelect>
                </label>
                {limitMode === 'custom' && (
                  <NumberSetting
                    label={t(($) => $.outputTokenBudget)}
                    value={settings.maxOutputTokens}
                    min={1}
                    max={MAX_MODEL_TOKENS}
                    integer
                    change={(maxOutputTokens) => update({ maxOutputTokens })}
                  />
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <NumberSetting
                    label={t(($) => $.contextTokenBudget)}
                    value={settings.contextBudget}
                    min={1}
                    max={10000000}
                    integer
                    change={(contextBudget) => update({ contextBudget })}
                  />
                  <NumberSetting
                    label={t(($) => $.recentMessages)}
                    value={settings.recentMessages}
                    min={1}
                    max={1000}
                    integer
                    change={(recentMessages) => update({ recentMessages })}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t(($) => $.contextBudgetHint)}</p>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <Checkbox
                    checked={compression.enabled}
                    onCheckedChange={(checked) =>
                      update({
                        autoCompression: { ...compression, enabled: checked === true },
                      })
                    }
                  />
                  {t(($) => $.autoCompaction)}
                </label>
                {compression.enabled && (
                  <div className="space-y-3">
                    <NumberSetting
                      label={t(($) => $.compactionThreshold)}
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
                      <span>{t(($) => $.autoSummaryModel)}</span>
                      <NativeSelect
                        className="w-full border-input"
                        aria-label={t(($) => $.autoSummaryModel)}
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
                        <option value="">{t(($) => $.currentModel)}</option>
                        {!compressionModelAvailable && (
                          <option value={compressionModel}>{t(($) => $.modelUnavailable)}</option>
                        )}
                        {models.map((item) => (
                          <option key={modelSelectionKey(item)} value={modelSelectionKey(item)}>
                            {item.providerName} · {item.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {t(($) => $.compactionThresholdHint)}
                    </p>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{t(($) => $.compactionCostHint)}</p>
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
                    <span>{t(($) => $.webSearch)}</span>
                    <Switch
                      checked={settings.tools.length > 0}
                      disabled={
                        !settings.tools.length &&
                        !canAttemptCapability(model?.metadata, 'toolCalls')
                      }
                      onCheckedChange={(checked) =>
                        update({ tools: checked ? [...WEB_TOOL_NAMES] : [] })
                      }
                    />
                  </label>
                  {!canAttemptCapability(model?.metadata, 'toolCalls') && (
                    <p className="text-xs text-muted-foreground">{t(($) => $.toolsUnsupported)}</p>
                  )}
                  {model?.metadata.sources.toolCalls === 'fallback' && (
                    <p className="text-xs text-muted-foreground">{t(($) => $.toolsUnknown)}</p>
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
                    {service.data?.hasApiKey
                      ? t(($) => $.webServiceSettings)
                      : t(($) => $.configureWebService)}
                  </Button>
                </div>{' '}
                {service.isError && !service.data && (
                  <div className="flex items-center gap-2 text-xs">
                    <span role="alert">{t(($) => $.webSettingsFailed)}</span>
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() => void service.refetch()}
                    >
                      {t(($) => $.reload)}
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{t(($) => $.webCostHint)}</p>
              </section>
            </div>
          </Tabs>
          <div className="shrink-0 border-t border-border px-3 py-2 sm:px-4">
            <Button
              variant="secondary"
              type="button"
              onClick={() => update({ ...DEFAULT_CONVERSATION_SETTINGS })}
            >
              {t(($) => $.restoreInherited)}
            </Button>
          </div>
          <AutosaveToast
            store={store}
            local={!id}
            testId="conversation-save-status"
            errorAction={
              invalidTab &&
              invalidTab !== tab && (
                <Button
                  variant="ghost"
                  type="button"
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
                  {t(($) => $.viewError)}
                </Button>
              )
            }
          />
        </ToastRegion>
      </div>
    </Modal>
  );
}
