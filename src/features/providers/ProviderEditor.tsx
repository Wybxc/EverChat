import { useTranslation } from 'react-i18next';
import './locales';
import { ApiKeyInput } from '../../components/ApiKeyInput';
import { ModelPriceButton } from '../usage/PriceEditor';
import { MAX_PROVIDER_MODELS, MODEL_LIST_LIMIT_MESSAGE } from '../../../shared/providers/limits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useReloadBlocker } from '../../platform/pwa/useReloadBlocker';
import * as v from 'valibot';
import { enrichModelCatalog } from '../../../shared/models/catalog';
import {
  modelProbeResultSchema,
  probeCapabilities,
  type ModelProbeResult,
} from '../../../shared/models/probe';
import type { DiscoveredModel, ProviderModel } from '../../../shared/models/types';
import { providerOptions } from '../../../shared/providers/endpoints';
import type {
  ProviderApiKind,
  ProviderProfile,
  ProviderSettings,
} from '../../../shared/providers/types';
import { Disclosure, DisclosureScope } from '../../components/Disclosure';
import { Modal, ModalTitle } from '../../components/Modal';
import { api, ApiError } from '../../platform/api';
import type { ProviderFailure } from '../../../shared/providers/failure';
import { ProviderFailureView } from './ProviderFailureView';
import { loadModelCatalog } from './model-catalog';
import { SettingsAutosave } from './settings-autosave';

import { ModelOptions } from './ModelOptions';
import { reconcile } from './selection';

function probeIdentity(
  profile: ProviderProfile | null,
  model: ProviderModel | undefined,
  saved?: ProviderSettings,
) {
  const key =
    profile?.apiKey?.trim() ||
    saved?.providers.find((item) => item.id === profile?.id)?.apiKey ||
    '';
  return profile && model
    ? JSON.stringify([
        profile.id,
        profile.provider,
        profile.baseUrl.trim().replace(/\/+$/, ''),
        key,
        model.id.trim(),
      ])
    : '';
}

export function ProviderEditor({
  store,
  settings,
  open,
  active,
  requestedProviderId,
}: {
  store: SettingsAutosave;
  settings: ProviderSettings;
  open: boolean;
  active: boolean;
  requestedProviderId?: string;
}) {
  const { t } = useTranslation('providers', { useSuspense: false });

  const queryClient = useQueryClient();
  const catalogIdentity = JSON.stringify(
    settings.providers.map((profile) => [
      profile.id,
      profile.provider,
      profile.baseUrl,
      profile.models.map((model) => [model.id, model.directoryMetadata?.updatedAt ?? 0]),
    ]),
  );
  useEffect(() => {
    if (!open || !active) return;
    let cancelled = false;
    void loadModelCatalog().then((catalog) => {
      if (cancelled || !catalog) return;
      const current = store.getSnapshot().settings;
      let changed = false;
      const providers = current.providers.map((profile) => ({
        ...profile,
        models: profile.models.map((model) => {
          const enriched = enrichModelCatalog(
            profile.provider,
            model,
            catalog.data,
            catalog.updatedAt,
          );
          changed ||= enriched !== model;
          return enriched;
        }),
      }));
      if (changed) store.update({ ...current, providers });
    });
    return () => {
      cancelled = true;
    };
  }, [open, active, catalogIdentity, store]);
  const [selectedId, setSelectedId] = useState(
    settings.activeProviderId ?? settings.providers[0]?.id ?? null,
  );
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [newName, setNewName] = useState('');
  const [addingModel, setAddingModel] = useState(false);
  useReloadBlocker(addingModel && (newModel || newName) ? 'finishAddingModel' : null);
  const newModelInput = useRef<HTMLInputElement>(null),
    providerNameInput = useRef<HTMLInputElement>(null);
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [noticeFailure, setNoticeFailure] = useState<{
    providerId: string;
    summary: string;
    failure: ProviderFailure;
  } | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  useEffect(() => {
    if (
      open &&
      active &&
      requestedProviderId &&
      settings.providers.some((profile) => profile.id === requestedProviderId)
    ) {
      setSelectedId(requestedProviderId);
      setMobileDetail(true);
    }
  }, [open, active, requestedProviderId]);
  const [editingModel, setEditingModel] = useState<number | null>(null);
  const [testing, setTesting] = useState(false),
    [testResults, setTestResults] = useState<ModelProbeResult[]>([]),
    [testError, setTestError] = useState('');
  const probeController = useRef<AbortController | null>(null);
  const [modelListRevision, setModelListRevision] = useState(0);
  const [modelFilter, setModelFilter] = useState('');
  const [removal, setRemoval] = useState<{
    kind: 'provider' | 'model';
    providerId: string;
    index?: number;
    name: string;
  } | null>(null);
  const cancelDeletion = useRef<HTMLButtonElement>(null);
  const addProviderButton = useRef<HTMLButtonElement>(null),
    fetchModelsButton = useRef<HTMLButtonElement>(null);
  const providerList = useRef<HTMLDivElement>(null),
    detailBack = useRef<HTMLButtonElement>(null);
  const focusDetails = () =>
    requestAnimationFrame(() => {
      if (detailBack.current?.checkVisibility()) detailBack.current.focus({ preventScroll: true });
    });
  useEffect(() => {
    if (!open) {
      setShowKey(false);
      setEditingModel(null);
      setAddingModel(false);
    }
  }, [open]);
  useEffect(() => {
    setShowKey(false);
  }, [active]);
  useEffect(() => {
    if (selectedId && !settings.providers.some((profile) => profile.id === selectedId)) {
      setSelectedId(settings.activeProviderId ?? settings.providers[0]?.id ?? null);
      setShowKey(false);
    }
  }, [selectedId, settings]);
  const selected = settings.providers.find((profile) => profile.id === selectedId) ?? null;
  const savedSettings = () => queryClient.getQueryData<ProviderSettings>(['provider-settings']);
  const testingIdentity = probeIdentity(
    selected,
    editingModel === null ? undefined : selected?.models[editingModel],
    savedSettings(),
  );
  useEffect(() => {
    probeController.current?.abort();
    probeController.current = null;
    setTesting(false);
    setTestResults([]);
    setTestError('');
    return () => {
      probeController.current?.abort();
      probeController.current = null;
    };
  }, [open, selectedId, editingModel, testingIdentity]);
  useEffect(() => {
    setAddingModel(false);
    setEditingModel(null);
  }, [selectedId]);
  const update = (next: ProviderSettings, chooseIfEmpty = false) => {
    setNotice('');
    store.update(reconcile(next, chooseIfEmpty));
  };
  const changeProvider = (id: string, patch: Partial<ProviderProfile>) => {
    const current = store.getSnapshot().settings;
    const profile = current.providers.find((profile) => profile.id === id)!;
    const endpointChanged =
      patch.baseUrl !== undefined &&
      patch.baseUrl.trim().replace(/\/+$/, '') !== profile.baseUrl.trim().replace(/\/+$/, '');
    const connectionChanged =
      endpointChanged || Boolean(patch.provider && patch.provider !== profile.provider);
    const keyChanged = Boolean(
      patch.apiKey?.trim() && patch.apiKey.trim() !== profile.apiKey?.trim(),
    );
    if (patch.models && patch.models.length < profile.models.length)
      setModelListRevision((value) => value + 1);
    update({
      ...current,
      providers: current.providers.map((profile) =>
        profile.id === id
          ? {
              ...profile,
              ...patch,
              models: (patch.models ?? profile.models).map((model) =>
                connectionChanged
                  ? {
                      ...model,
                      reportedMetadata: undefined,
                      directoryMetadata: undefined,
                      testedCapabilities: undefined,
                    }
                  : keyChanged
                    ? { ...model, testedCapabilities: undefined }
                    : model,
              ),
            }
          : profile,
      ),
    });
  };
  const changeModel = (index: number, patch: Partial<ProviderModel>) => {
    if (!selected) return;
    const current = store.getSnapshot().settings;
    const profile = current.providers.find((profile) => profile.id === selected.id)!;
    const previous = profile.models[index];
    update(
      {
        ...current,
        providers: current.providers.map((item) =>
          item.id === profile.id
            ? {
                ...item,
                models: item.models.map((model, i) =>
                  i === index
                    ? {
                        ...model,
                        ...patch,
                        ...(patch.id !== undefined && patch.id.trim() !== model.id
                          ? {
                              reportedMetadata: undefined,
                              directoryMetadata: undefined,
                              testedCapabilities: undefined,
                            }
                          : {}),
                      }
                    : model,
                ),
              }
            : item,
        ),
        ...(current.activeProviderId === profile.id &&
        current.activeModel === previous.id &&
        patch.id !== undefined
          ? { activeModel: patch.id }
          : {}),
      },
      patch.enabled === true,
    );
  };
  const addProvider = () => {
    const option = providerOptions[0];
    const profile: ProviderProfile = {
      id: crypto.randomUUID(),
      name: '',
      provider: option.value,
      baseUrl: option.baseUrl,
      models: [],
      hasApiKey: false,
    };
    update({ ...settings, providers: [...settings.providers, profile] });
    setSelectedId(profile.id);
    setMobileDetail(true);
    setEditingModel(null);
    setModelFilter('');
    setNewModel('');
    setNewName('');
    setShowKey(false);
    requestAnimationFrame(() => providerNameInput.current?.focus());
  };
  const removeProvider = (id: string) => {
    const providers = settings.providers.filter((profile) => profile.id !== id);
    update({ ...settings, providers });
    if (selectedId === id) {
      setSelectedId(providers[0]?.id ?? null);
      setMobileDetail(false);
      setEditingModel(null);
      setNewModel('');
      setNewName('');
      setShowKey(false);
    }
  };
  const fetchModels = async () => {
    if (!selected) return;
    const target = selected;
    setNotice('');
    setNoticeFailure(null);
    setFetchingId(target.id);
    try {
      await store.flush();
      const result = await api<{ models: DiscoveredModel[] }>(
        `/settings/providers/${target.id}/models`,
        'GET',
        undefined,
        undefined,
        60_000,
      );
      const current = store.getSnapshot().settings;
      const profile = current.providers.find((profile) => profile.id === target.id);
      if (!profile || profile.provider !== target.provider || profile.baseUrl !== target.baseUrl)
        return;
      const existing = new Set(profile.models.map((model) => model.id));
      const discovered = new Map(result.models.map((model) => [model.id, model]));
      const models = [
        ...profile.models.map((model) =>
          discovered.has(model.id)
            ? { ...model, reportedMetadata: discovered.get(model.id)!.reportedMetadata }
            : model,
        ),
        ...result.models
          .filter((model) => !existing.has(model.id))
          .map((model) => ({ ...model, enabled: false })),
      ];
      if (models.length > MAX_PROVIDER_MODELS) throw new Error(MODEL_LIST_LIMIT_MESSAGE);
      update({
        ...current,
        providers: current.providers.map((profile) =>
          profile.id === target.id ? { ...profile, models } : profile,
        ),
      });
      await store.flush();
      setNotice(t(($) => $.fetchedModels, { count: result.models.length }));
    } catch (error) {
      if (error instanceof ApiError && error.failure)
        setNoticeFailure({ providerId: target.id, summary: error.message, failure: error.failure });
      else setNotice(error instanceof Error ? error.message : t(($) => $.fetchFailed));
    } finally {
      setFetchingId(null);
    }
  };
  const addModel = () => {
    if (!selected || !newModel.trim()) return;
    const id = newModel.trim();
    if (selected.models.some((model) => model.id === id)) {
      setNotice(t(($) => $.modelIdExists));
      return;
    }
    if (selected.models.length >= MAX_PROVIDER_MODELS) {
      setNotice(MODEL_LIST_LIMIT_MESSAGE);
      return;
    }
    update(
      {
        ...settings,
        providers: settings.providers.map((profile) =>
          profile.id === selected.id
            ? {
                ...profile,
                models: [...profile.models, { id, name: newName.trim() || id, enabled: true }],
              }
            : profile,
        ),
      },
      true,
    );
    setNewModel('');
    setNewName('');
  };
  const testModel = async (index: number) => {
    if (!selected || probeController.current) return;
    const target = selected,
      modelId = target.models[index].id.trim();
    const identity = probeIdentity(target, target.models[index], savedSettings()),
      controller = new AbortController();
    probeController.current = controller;
    setTesting(true);
    setTestResults([]);
    setTestError('');
    const currentTarget = () => {
      if (controller.signal.aborted) return;
      const current = store.getSnapshot().settings,
        profile = current.providers.find((item) => item.id === target.id);
      const model = profile?.models.find((item) => item.id === modelId);
      return profile && model && probeIdentity(profile, model, savedSettings()) === identity
        ? { current, profile, model }
        : undefined;
    };
    try {
      await store.flush();
      if (!currentTarget()) return;
      for (const capability of probeCapabilities) {
        const result = v.parse(
          modelProbeResultSchema,
          await api(
            `/settings/providers/${target.id}/models/test`,
            'POST',
            { model: modelId, capability },
            controller.signal,
          ),
        );
        const latest = currentTarget();
        if (!latest) return;
        if (result.capability !== capability) throw new Error(t(($) => $.invalidProbeResult));
        setTestResults((results) => [...results, result]);
        if (result.status === 'confirmed' && capability !== 'text') {
          const testedCapabilities = {
            ...latest.model.testedCapabilities,
            [capability]: true as const,
            testedAt: result.testedAt,
          };
          store.update({
            ...latest.current,
            providers: latest.current.providers.map((profile) =>
              profile.id === target.id
                ? {
                    ...profile,
                    models: profile.models.map((model) =>
                      model.id === modelId ? { ...model, testedCapabilities } : model,
                    ),
                  }
                : profile,
            ),
          });
        }
        if (capability === 'text' && result.status !== 'confirmed') break;
      }
      await store.flush();
    } catch (error) {
      if (!controller.signal.aborted && currentTarget())
        setTestError(error instanceof Error ? error.message : t(($) => $.probeFailed));
    } finally {
      if (probeController.current === controller) {
        probeController.current = null;
        setTesting(false);
      }
    }
  };
  const confirmRemoval = () => {
    if (!removal) return;
    if (removal.kind === 'provider') removeProvider(removal.providerId);
    else {
      const current = store
        .getSnapshot()
        .settings.providers.find((item) => item.id === removal.providerId);
      if (current)
        changeProvider(removal.providerId, {
          models: current.models.filter((_, index) => index !== removal.index),
        });
      setEditingModel(null);
    }
    setRemoval(null);
    requestAnimationFrame(() =>
      (removal.kind === 'provider' ? addProviderButton.current : fetchModelsButton.current)?.focus({
        preventScroll: true,
      }),
    );
  };

  return (
    <DisclosureScope key={`${open}:${selectedId}:${modelListRevision}`}>
      <div>
        <fieldset className="gap-3" disabled={Boolean(fetchingId)}>
          <legend className="sr-only">{t(($) => $.aiProviders)}</legend>
          <div className="grid gap-3 md:grid-cols-[minmax(11rem,0.3fr)_minmax(0,0.7fr)]">
            <div
              ref={providerList}
              className={`${mobileDetail ? 'hidden md:flex' : 'flex'} min-w-0 flex-col gap-2`}
            >
              <div className="max-h-48 overflow-y-auto md:max-h-96">
                {settings.providers.map((profile) => (
                  <Button
                    variant="ghost"
                    type="button"
                    key={profile.id}
                    onClick={() => {
                      setSelectedId(profile.id);
                      setMobileDetail(true);
                      setEditingModel(null);
                      setModelFilter('');
                      setNewModel('');
                      setNewName('');
                      setNotice('');
                      setShowKey(false);
                      focusDetails();
                    }}
                    aria-current={selectedId === profile.id ? 'true' : undefined}
                    className={`provider-list-row flex w-full items-center gap-2 rounded-lg px-3 py-1 text-left text-sm ${selectedId === profile.id ? 'bg-primary/10 text-foreground' : 'hover:bg-muted'}`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {profile.name || t(($) => $.newProvider)}
                    </span>
                    {settings.activeProviderId === profile.id && (
                      <Badge>{t(($) => $.default)}</Badge>
                    )}
                    <span
                      aria-label={
                        profile.hasApiKey || profile.apiKey?.trim()
                          ? t(($) => $.keyConfigured)
                          : t(($) => $.keyMissing)
                      }
                      className={`h-2 w-2 shrink-0 rounded-full ${profile.hasApiKey || profile.apiKey?.trim() ? 'bg-success' : 'bg-border'}`}
                    />
                  </Button>
                ))}
                {!settings.providers.length && (
                  <p className="px-2 py-5 text-center text-sm text-muted-foreground">
                    {t(($) => $.noProviders)}
                  </p>
                )}
              </div>
              <Button variant="outline" ref={addProviderButton} type="button" onClick={addProvider}>
                <Plus className="h-[0.9375rem] w-[0.9375rem]" />
                {t(($) => $.addProvider)}
              </Button>
            </div>
            {selected ? (
              <div
                className={`${mobileDetail ? '' : 'hidden md:block'} provider-details min-w-0 space-y-3`}
                onFocusCapture={() => setMobileDetail(true)}
              >
                <Button
                  variant="ghost"
                  ref={detailBack}
                  type="button"
                  className="h-11 gap-2 md:hidden"
                  onClick={() => {
                    setMobileDetail(false);
                    setShowKey(false);
                    requestAnimationFrame(() =>
                      providerList.current
                        ?.querySelector<HTMLButtonElement>('[aria-current="true"]')
                        ?.focus({ preventScroll: true }),
                    );
                  }}
                >
                  <ArrowLeft className="h-[1rem] w-[1rem]" />
                  {t(($) => $.providerList)}
                </Button>
                <div className="flex items-center gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-lg font-semibold">
                    {selected.name || t(($) => $.newProvider)}
                  </h3>
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    className="text-destructive"
                    aria-label={t(($) => $.deleteProviderLabel, { name: selected.name })}
                    onClick={() =>
                      setRemoval({ kind: 'provider', providerId: selected.id, name: selected.name })
                    }
                  >
                    <Trash2 className="h-[1rem] w-[1rem]" />
                  </Button>
                </div>
                <div className="provider-connection">
                  <div className="space-y-1">
                    <label htmlFor="provider-name" className="block text-sm font-medium">
                      {t(($) => $.name)}
                    </label>
                    <Input
                      ref={providerNameInput}
                      id="provider-name"
                      required
                      maxLength={100}
                      aria-invalid={!selected.name.trim() || undefined}
                      aria-describedby={!selected.name.trim() ? 'provider-name-error' : undefined}
                      className="w-full border-input"
                      value={selected.name}
                      onChange={(event) =>
                        changeProvider(selected.id, { name: event.target.value })
                      }
                    />
                    {!selected.name.trim() && (
                      <p id="provider-name-error" className="text-xs">
                        {t(($) => $.nameRequired)}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="provider-protocol" className="block text-sm font-medium">
                      {t(($) => $.apiType)}
                    </label>
                    <NativeSelect
                      id="provider-protocol"
                      className="w-full border-input"
                      value={selected.provider}
                      onChange={(event) => {
                        changeProvider(selected.id, {
                          provider: event.target.value as ProviderApiKind,
                        });
                      }}
                    >
                      {providerOptions.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="provider-url" className="block text-sm font-medium">
                      {t(($) => $.apiEndpoint)}
                    </label>
                    <Input
                      id="provider-url"
                      type="url"
                      required
                      maxLength={2048}
                      className="w-full border-input"
                      value={selected.baseUrl}
                      placeholder="https://api.example.com/v1"
                      onChange={(event) =>
                        changeProvider(selected.id, { baseUrl: event.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="provider-key" className="block text-sm font-medium">
                      {t(($) => $.apiKey)}
                    </label>
                    <ApiKeyInput
                      id="provider-key"
                      visible={showKey}
                      onToggle={() => setShowKey((current) => !current)}
                      value={selected.apiKey ?? ''}
                      placeholder={
                        selected.hasApiKey
                          ? t(($) => $.keepKeyPlaceholder)
                          : t(($) => $.enterKeyPlaceholder)
                      }
                      onChange={(event) =>
                        changeProvider(selected.id, { apiKey: event.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold">{t(($) => $.models)}</h4>
                    <span className="flex-1 text-xs text-muted-foreground">
                      {t(($) => $.enabledModels, {
                        enabled: selected.models.filter((model) => model.enabled).length,
                        total: selected.models.length,
                      })}
                    </span>
                    <Button
                      variant="ghost"
                      ref={fetchModelsButton}
                      type="button"
                      disabled={
                        !(selected.hasApiKey || selected.apiKey?.trim()) || Boolean(fetchingId)
                      }
                      onClick={() => void fetchModels()}
                    >
                      {fetchingId === selected.id ? (
                        <Spinner />
                      ) : (
                        <RefreshCw className="h-[0.875rem] w-[0.875rem]" />
                      )}
                      {t(($) => $.fetchModels)}
                    </Button>
                  </div>
                  {selected.models.length > 1 && (
                    <label className="field-control h-11 w-full gap-2 border-input">
                      <Search className="h-[0.9375rem] w-[0.9375rem]" />
                      <input
                        aria-label={t(($) => $.filterModels)}
                        placeholder={t(($) => $.filterModels)}
                        value={modelFilter}
                        onChange={(event) => {
                          setModelFilter(event.target.value);
                          setEditingModel(null);
                        }}
                      />
                    </label>
                  )}
                  {selected.models.length > 0 && (
                    <div className="divide-y divide-border">
                      {selected.models.map((model, index) => {
                        if (
                          editingModel !== index &&
                          !`${model.name} ${model.id}`
                            .toLowerCase()
                            .includes(modelFilter.toLowerCase())
                        )
                          return null;
                        const expanded = editingModel === index;
                        return (
                          <div
                            key={`${selected.id}-${index}`}
                            data-testid="provider-model-row"
                            className={`min-w-0 px-2 py-0.5 ${expanded ? 'bg-muted' : ''}`}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <label className="provider-model-toggle flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                                <Checkbox
                                  className="shrink-0"
                                  aria-label={t(($) => $.enableModelLabel, {
                                    name: model.name || model.id,
                                  })}
                                  checked={model.enabled}
                                  onCheckedChange={(checked) =>
                                    changeModel(index, { enabled: checked === true })
                                  }
                                />
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium">
                                    {model.name || model.id}
                                  </span>
                                  {model.name && model.name !== model.id && (
                                    <span className="block truncate text-xs text-muted-foreground">
                                      {model.id}
                                    </span>
                                  )}
                                </span>
                              </label>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                type="button"
                                className="shrink-0"
                                aria-label={t(($) => $.modelSettingsLabel, { index: index + 1 })}
                                aria-expanded={expanded}
                                aria-controls={`model-editor-${selected.id}-${index}`}
                                onClick={() => setEditingModel(expanded ? null : index)}
                              >
                                <Pencil className="h-[0.9375rem] w-[0.9375rem]" />
                              </Button>
                            </div>
                            {expanded && (
                              <div
                                id={`model-editor-${selected.id}-${index}`}
                                className="space-y-2 pb-2"
                              >
                                <ModelOptions
                                  model={model}
                                  index={index}
                                  provider={selected.provider}
                                  globalPrompt={settings.systemPrompt}
                                  onChange={(patch) => changeModel(index, patch)}
                                  stateKey={`model:${index}`}
                                  onTest={() => void testModel(index)}
                                  testing={testing}
                                  results={testResults}
                                  testError={testError}
                                />
                                <ModelPriceButton providerId={selected.id} model={model.id} />
                                <Button
                                  variant="ghost"
                                  type="button"
                                  aria-label={t(($) => $.deleteModelLabel, {
                                    name: model.name || model.id || index + 1,
                                  })}
                                  onClick={() =>
                                    setRemoval({
                                      kind: 'model',
                                      providerId: selected.id,
                                      index,
                                      name: model.name || model.id,
                                    })
                                  }
                                >
                                  <Trash2 className="h-[0.9375rem] w-[0.9375rem]" />
                                  {t(($) => $.deleteModel)}
                                </Button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {editingModel === null &&
                        modelFilter &&
                        !selected.models.some((model) =>
                          `${model.name} ${model.id}`
                            .toLowerCase()
                            .includes(modelFilter.toLowerCase()),
                        ) && (
                          <p className="py-4 text-sm text-muted-foreground">
                            {t(($) => $.noModelMatches)}
                          </p>
                        )}
                    </div>
                  )}
                  <Disclosure
                    title={t(($) => $.addModel)}
                    open={addingModel}
                    onOpenChange={(next) => {
                      setAddingModel(next);
                      if (next)
                        requestAnimationFrame(() =>
                          newModelInput.current?.focus({ preventScroll: true }),
                        );
                    }}
                  >
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        ref={newModelInput}
                        aria-label={t(($) => $.newModelId)}
                        maxLength={200}
                        className="w-full border-input"
                        placeholder={t(($) => $.modelId)}
                        value={newModel}
                        onChange={(event) => setNewModel(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            addModel();
                          }
                        }}
                      />
                      <Input
                        aria-label={t(($) => $.newModelDisplayName)}
                        maxLength={200}
                        className="w-full border-input"
                        placeholder={t(($) => $.displayName)}
                        value={newName}
                        onChange={(event) => setNewName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            addModel();
                          }
                        }}
                      />
                      <div className="flex gap-2 sm:col-span-2">
                        <Button
                          variant="secondary"
                          type="button"
                          onClick={addModel}
                          disabled={!newModel.trim()}
                        >
                          <Plus className="h-[0.875rem] w-[0.875rem]" />
                          {t(($) => $.add)}
                        </Button>
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() => {
                            setNewModel('');
                            setNewName('');
                            setAddingModel(false);
                          }}
                        >
                          {t(($) => $.cancelAdding)}
                        </Button>
                      </div>
                    </div>
                  </Disclosure>
                </div>
              </div>
            ) : (
              <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                {t(($) => $.addProviderHint)}
              </div>
            )}
          </div>
        </fieldset>
        {notice && (
          <p role="status" className="mt-4 text-sm">
            {notice}
          </p>
        )}
        {noticeFailure?.providerId === selectedId && (
          <ProviderFailureView
            summary={noticeFailure.summary}
            failure={noticeFailure.failure}
            stateKey={`discovery:${selectedId}`}
          />
        )}
        <Modal
          alert
          open={Boolean(removal)}
          onOpenChange={(next) => {
            if (!next) setRemoval(null);
          }}
          initialFocus={cancelDeletion}
          aria-labelledby="provider-removal-title"
        >
          <div className="p-5 max-w-sm">
            <ModalTitle id="provider-removal-title" className="text-lg font-semibold">
              {removal?.kind === 'provider' ? t(($) => $.deleteProvider) : t(($) => $.deleteModel)}
            </ModalTitle>
            <p className="mt-4 break-words text-sm">
              {t(($) => $.deleteProviderConfirmation, { name: removal?.name ?? '' })}
            </p>
            <div className="dialog-actions">
              <Button
                variant="secondary"
                ref={cancelDeletion}
                type="button"
                onClick={() => setRemoval(null)}
              >
                {t(($) => $.cancel)}
              </Button>
              <Button variant="destructive" type="button" onClick={confirmRemoval}>
                {t(($) => $.confirmDelete)}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </DisclosureScope>
  );
}
