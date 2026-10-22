import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import * as v from 'valibot';
import { MAX_SYSTEM_PROMPT_LENGTH } from '../../../shared/conversation/limits';
import { promptPresetInputSchema } from '../../../shared/presets/schema';
import { DEFAULT_PROMPT_PRESET_ID, type PromptPreset } from '../../../shared/presets/types';
import { Modal, ModalTitle } from '../../components/Modal';
import { AutosaveToast } from '../../components/AutosaveToast';
import { api } from '../../platform/api';
import { Autosave } from '../../platform/autosave';
import {
  errorMessage,
  renderUiMessage,
  UiError,
  uiMessage,
  type UiMessage,
} from '../../platform/i18n/messages';
import { read, storageEpoch, write } from '../../platform/storage';
import './locales';

import {
  discardPresetDraft,
  PRESET_QUERY,
  presetDrafts,
  publishPresets,
  savePresetDraft,
  usePromptPresets,
} from './prompt-presets';

export function PromptPresetPicker({
  open,
  apply,
  manage,
  prompt,
  compact = false,
}: {
  open: boolean;
  apply: (prompt: string | null) => void;
  prompt: string | null;
  compact?: boolean;
  manage: () => void;
}) {
  const { t } = useTranslation('presets', { useSuspense: false });

  const query = usePromptPresets(open);
  const value =
    prompt === null
      ? DEFAULT_PROMPT_PRESET_ID
      : (query.data?.find(
          (preset) => preset.id !== DEFAULT_PROMPT_PRESET_ID && preset.systemPrompt === prompt,
        )?.id ?? 'custom');
  return (
    <div className={compact ? 'min-w-0 max-w-40' : 'space-y-2'}>
      {!compact && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">{t(($) => $.presets)}</span>
          <Button variant="ghost" type="button" onClick={manage}>
            {t(($) => $.manage)}
          </Button>
        </div>
      )}
      <NativeSelect
        className="w-full"
        selectClassName={
          compact
            ? 'h-11 sm:h-9 truncate border-transparent bg-transparent dark:bg-transparent dark:hover:bg-accent/50'
            : undefined
        }
        aria-label={compact ? t(($) => $.newChatPreset) : t(($) => $.presets)}
        value={value}
        disabled={!query.data?.length}
        onChange={(event) => {
          const id = event.currentTarget.value;
          if (id === 'manage') {
            manage();
            return;
          }
          if (id === DEFAULT_PROMPT_PRESET_ID) {
            apply(null);
            return;
          }
          if (id === 'custom') {
            if (!compact) apply(prompt ?? '');
            return;
          }
          const preset = query.data?.find((preset) => preset.id === id);
          if (preset) apply(preset.systemPrompt);
        }}
      >
        {!query.data?.length && (
          <option value={DEFAULT_PROMPT_PRESET_ID}>{t(($) => $.defaultPreset)}</option>
        )}
        {query.data?.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.id === DEFAULT_PROMPT_PRESET_ID ? t(($) => $.defaultPreset) : preset.name}
          </option>
        ))}
        {(!compact || value === 'custom') && <option value="custom">{t(($) => $.custom)}</option>}
        {compact && <option value="manage">{t(($) => $.manageMenu)}</option>}
      </NativeSelect>
      {query.isError && (
        <div className="flex items-center gap-2 text-xs">
          <span role="alert">{t(($) => $.updateFailed)}</span>
          <Button variant="ghost" type="button" onClick={() => void query.refetch()}>
            {t(($) => $.reload)}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PromptPresetsPanel({
  open,
  beforeDefaultSave,
  onDefaultSaved,
}: {
  open: boolean;
  beforeDefaultSave?: () => Promise<unknown>;
  onDefaultSaved?: () => Promise<void>;
}) {
  const { t } = useTranslation('presets', { useSuspense: false });

  const query = usePromptPresets(open);
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<string | null>(() =>
    read('prompt-preset-selection', null),
  );
  const selectPreset = useCallback((id: string | null) => {
    setSelection(id);
    write('prompt-preset-selection', id);
  }, []);
  const select = useRef<HTMLSelectElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((value) => value + 1), []);
  const removed = useCallback(() => {
    const items = queryClient.getQueryData<PromptPreset[]>(PRESET_QUERY) ?? [];
    selectPreset(
      items.find((item) => item.id !== DEFAULT_PROMPT_PRESET_ID)?.id ?? DEFAULT_PROMPT_PRESET_ID,
    );
    setRevision((value) => value + 1);
    requestAnimationFrame(() =>
      (select.current?.disabled ? addButton.current : select.current)?.focus(),
    );
  }, [queryClient, selectPreset]);
  const drafts = presetDrafts(),
    saved = query.data ?? [];
  const items = [
    ...saved.map((preset) => drafts[preset.id] ?? preset),
    ...Object.values(drafts).filter((preset) => !saved.some((item) => item.id === preset.id)),
  ];
  const selected = items.find((preset) => preset.id === selection) ?? items[0];
  const add = () => {
    const preset = {
      id: crypto.randomUUID(),
      name: t(($) => $.newPreset),
      systemPrompt: '',
      updatedAt: Date.now(),
    };
    savePresetDraft(preset);
    selectPreset(preset.id);
    changed();
  };
  const copy = (source: PromptPreset) => {
    const preset = {
      ...source,
      id: crypto.randomUUID(),
      name:
        source.id === DEFAULT_PROMPT_PRESET_ID
          ? t(($) => $.defaultPreset)
          : source.name.trim() || t(($) => $.newPreset),
      updatedAt: Date.now(),
    };
    savePresetDraft(preset);
    selectPreset(preset.id);
    changed();
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <NativeSelect
          ref={select}
          className="min-w-0 flex-1"
          aria-label={t(($) => $.edit)}
          value={selected?.id ?? ''}
          disabled={!items.length}
          onChange={(event) => selectPreset(event.currentTarget.value)}
        >
          {!items.length && (
            <option value="">
              {query.isPending
                ? t(($) => $.loading)
                : query.isError
                  ? t(($) => $.loadFailed)
                  : t(($) => $.empty)}
            </option>
          )}
          {items.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.id === DEFAULT_PROMPT_PRESET_ID ? t(($) => $.defaultPreset) : preset.name}
            </option>
          ))}
        </NativeSelect>
        <Button
          variant="secondary"
          ref={addButton}
          type="button"
          disabled={!query.data}
          onClick={add}
        >
          <Plus className="h-[0.9375rem] w-[0.9375rem]" />
          {t(($) => $.add)}
        </Button>
      </div>
      {query.isError && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span role="alert">{renderUiMessage(errorMessage(query.error))}</span>
          <Button variant="secondary" type="button" onClick={() => void query.refetch()}>
            {t(($) => $.reload)}
          </Button>
        </div>
      )}
      {selected && (
        <PresetEditor
          key={selected.id}
          preset={selected}
          open={open}
          changed={changed}
          removed={removed}
          copy={copy}
          beforeDefaultSave={beforeDefaultSave}
          onDefaultSaved={onDefaultSaved}
        />
      )}
    </div>
  );
}

function PresetEditor({
  preset,
  open,
  changed,
  removed,
  copy,
  beforeDefaultSave,
  onDefaultSaved,
}: {
  preset: PromptPreset;
  open: boolean;
  changed: () => void;
  removed: () => void;
  copy: (preset: PromptPreset) => void;
  beforeDefaultSave?: () => Promise<unknown>;
  onDefaultSaved?: () => Promise<void>;
}) {
  const { t } = useTranslation('presets', { useSuspense: false });

  const isDefault = preset.id === DEFAULT_PROMPT_PRESET_ID;
  const callbacks = useRef({ beforeDefaultSave, onDefaultSaved });
  callbacks.current = { beforeDefaultSave, onDefaultSaved };
  const queryClient = useQueryClient(),
    deleting = useRef(false),
    epoch = useRef(storageEpoch()).current;
  const name = useRef<HTMLInputElement>(null),
    cancel = useRef<HTMLButtonElement>(null),
    deleteButton = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false),
    [removeError, setRemoveError] = useState<UiMessage>(''),
    [removing, setRemoving] = useState(false);
  const [cached] = useState(() => presetDrafts()[preset.id]);
  const [store] = useState(
    () =>
      new Autosave(
        preset,
        async (draft: PromptPreset) => {
          if (epoch !== storageEpoch() || deleting.current)
            throw new UiError(uiMessage('presets', 'closed'));
          const parsed = v.safeParse(promptPresetInputSchema, {
            name: draft.name,
            systemPrompt: draft.systemPrompt,
          });
          if (!parsed.success) throw new UiError(uiMessage('presets', 'invalid'));
          if (isDefault) await callbacks.current.beforeDefaultSave?.();
          const saved = await api<PromptPreset>(
            `/settings/presets/${preset.id}`,
            'PUT',
            parsed.output,
          );
          if (isDefault) await callbacks.current.onDefaultSaved?.();
          if (epoch === storageEpoch()) await queryClient.cancelQueries({ queryKey: PRESET_QUERY });
          return saved;
        },
        (saved) => {
          if (epoch !== storageEpoch() || deleting.current) return;
          const items = queryClient.getQueryData<PromptPreset[]>(PRESET_QUERY) ?? [];
          publishPresets(
            queryClient,
            items.some((item) => item.id === saved.id)
              ? items.map((item) => (item.id === saved.id ? saved : item))
              : [...items, saved],
            epoch,
          );
          if (store.getSnapshot().status === 'saved') discardPresetDraft(saved.id);
          changed();
        },
        (_saved, draft) => draft,
      ),
  );
  const { settings, status } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    if (cached) store.update(cached);
  }, [cached, store]);
  useEffect(() => {
    store.receive(preset);
  }, [preset, store]);
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
  useEffect(() => {
    if (!open) void store.flush().catch(() => {});
  }, [open, store]);
  useEffect(() => {
    if (cached && open) name.current?.focus();
  }, [cached, open]);
  const update = (patch: Partial<PromptPreset>) => {
    const draft = { ...store.getSnapshot().settings, ...patch };
    if (
      v.safeParse(promptPresetInputSchema, { name: draft.name, systemPrompt: draft.systemPrompt })
        .success
    )
      savePresetDraft(draft);
    store.update(draft);
    changed();
  };
  const remove = async () => {
    deleting.current = true;
    store.dispose();
    setRemoving(true);
    setRemoveError('');
    try {
      await api(`/settings/presets/${preset.id}`, 'DELETE');
      if (epoch !== storageEpoch()) return;
      await queryClient.cancelQueries({ queryKey: PRESET_QUERY });
      publishPresets(
        queryClient,
        (queryClient.getQueryData<PromptPreset[]>(PRESET_QUERY) ?? []).filter(
          (item) => item.id !== preset.id,
        ),
        epoch,
      );
      discardPresetDraft(preset.id);
      removed();
    } catch (error) {
      deleting.current = false;
      setRemoveError(errorMessage(error, uiMessage('presets', 'deleteFailed')));
    } finally {
      setRemoving(false);
    }
  };
  return (
    <div
      className="space-y-4"
      onBlur={(event) => {
        if (
          !deleting.current &&
          !(event.relatedTarget instanceof Element && event.relatedTarget.closest('button'))
        )
          void store.flush().catch(() => {});
      }}
    >
      <label className="block space-y-1 text-sm">
        <span>{t(($) => $.name)}</span>
        <Input
          ref={name}
          aria-label={t(($) => $.name)}
          className="w-full"
          maxLength={100}
          value={isDefault ? t(($) => $.defaultPreset) : settings.name}
          disabled={removing || isDefault}
          onChange={(event) => update({ name: event.currentTarget.value })}
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>{t(($) => $.systemPrompt)}</span>
        <Textarea
          aria-label={t(($) => $.systemPrompt)}
          className="min-h-48 w-full"
          maxLength={MAX_SYSTEM_PROMPT_LENGTH}
          rows={8}
          value={settings.systemPrompt}
          disabled={removing}
          onChange={(event) => update({ systemPrompt: event.currentTarget.value })}
        />
      </label>
      <AutosaveToast store={store} testId="preset-save-status" />
      {removeError && !confirming && (
        <p role="alert" className="text-sm">
          {renderUiMessage(removeError)}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex flex-wrap gap-2">
          {status === 'error' && (
            <>
              <Button variant="secondary" type="button" onClick={() => copy(settings)}>
                {t(($) => $.saveAsNew)}
              </Button>
            </>
          )}
          {!isDefault && (
            <Button
              variant="ghost"
              ref={deleteButton}
              type="button"
              disabled={removing}
              onClick={() => {
                store.dispose();
                setConfirming(true);
              }}
            >
              <Trash2 className="h-[0.875rem] w-[0.875rem]" />
              {t(($) => $.delete)}
            </Button>
          )}
        </div>
      </div>
      <Modal
        alert
        open={confirming}
        onOpenChange={setConfirming}
        initialFocus={cancel}
        busy={removing}
      >
        <div className="w-full max-w-sm space-y-3 p-5">
          <ModalTitle>{t(($) => $.delete)}</ModalTitle>
          <p className="text-sm">{t(($) => $.deleteConfirmation, { name: settings.name })}</p>
          {removeError && (
            <p role="alert" className="text-sm">
              {renderUiMessage(removeError)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              ref={cancel}
              type="button"
              disabled={removing}
              onClick={() => {
                setConfirming(false);
                requestAnimationFrame(() => deleteButton.current?.focus());
                void store.flush().catch(() => {});
              }}
            >
              {t(($) => $.cancelDelete)}
            </Button>
            <Button
              variant="destructive"
              type="button"
              disabled={removing}
              onClick={() => void remove()}
            >
              {t(($) => $.confirmDelete)}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
