import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import * as v from 'valibot';
import {
  webToolServiceInputSchema,
  type WebToolServiceInput,
  type WebToolServiceSettings,
} from '../../../shared/web-tools/service';
import { ApiKeyInput } from '../../components/ApiKeyInput';
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
import { storageEpoch, write } from '../../platform/storage';
import './locales';

import {
  loadWebToolSettings,
  useWebToolSettings,
  WEB_TOOL_SETTINGS_KEY,
} from './web-tool-settings';

type Draft = WebToolServiceSettings & { apiKey?: string };
export function WebToolSettingsPanel({ active }: { active: boolean }) {
  const { t } = useTranslation('web-tools', { useSuspense: false });

  const query = useWebToolSettings(active);
  if (!query.data)
    return query.isError ? (
      <div className="space-y-3">
        <p role="alert">{renderUiMessage(errorMessage(query.error))}</p>
        <Button variant="secondary" type="button" onClick={() => void query.refetch()}>
          {t(($) => $.reload)}
        </Button>
      </div>
    ) : (
      <Spinner role="status" aria-label={t(($) => $.loading)} />
    );
  return <ServiceEditor initial={query.data} active={active} />;
}

function ServiceEditor({ initial, active }: { initial: WebToolServiceSettings; active: boolean }) {
  const { t } = useTranslation('web-tools', { useSuspense: false });

  const queryClient = useQueryClient();
  const [epoch] = useState(storageEpoch);
  const [store] = useState(
    () =>
      new Autosave<Draft, WebToolServiceInput>(
        initial,
        async (input) => {
          if (storageEpoch() !== epoch) throw new UiError(uiMessage('web-tools', 'sessionChanged'));
          return api<WebToolServiceSettings>('/settings/web-tools', 'PUT', input);
        },
        (result) => {
          if (storageEpoch() !== epoch) return;
          queryClient.setQueryData(WEB_TOOL_SETTINGS_KEY, result);
          write('web-tool-settings', result);
        },
        (_saved, draft) => {
          const parsed = v.safeParse(webToolServiceInputSchema, {
            provider: draft.provider,
            dailyLimit: draft.dailyLimit,
            ...(draft.apiKey === undefined ? {} : { apiKey: draft.apiKey }),
          });
          if (!parsed.success) throw new UiError(uiMessage('web-tools', 'invalid'));
          return parsed.output;
        },
      ),
  );
  const { settings } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [switching, setSwitching] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null),
    [reading, setReading] = useState(false),
    [readError, setReadError] = useState<UiMessage>('');
  const revealRequest = useRef<AbortController | null>(null),
    activeRef = useRef(active);
  activeRef.current = active;
  const hide = () => {
    revealRequest.current?.abort();
    revealRequest.current = null;
    setRevealed(null);
    setReading(false);
    setReadError('');
  };
  useEffect(() => {
    store.receive(initial);
  }, [initial, store]);
  useEffect(() => {
    if (!active) {
      hide();
      void store.flush().catch(() => {});
    } else void store.refresh(() => loadWebToolSettings()).catch(() => {});
  }, [active, store]);
  useEffect(() => {
    const retry = () => {
      void store.flush().catch(() => {});
    };
    window.addEventListener('everchat:network-ready', retry);
    return () => {
      window.removeEventListener('everchat:network-ready', retry);
      revealRequest.current?.abort();
      store.dispose();
    };
  }, [store]);
  const update = (patch: Partial<Draft>) => {
    hide();
    store.update({ ...store.getSnapshot().settings, ...patch });
  };
  const switchProvider = async (provider: WebToolServiceSettings['provider']) => {
    if (provider === settings.provider || switching) return;
    hide();
    setSwitching(true);
    try {
      await store.flush();
      await store.refresh(async () => {
        const result = await api<WebToolServiceSettings>('/settings/web-tools', 'PUT', {
          provider,
          dailyLimit: store.getSnapshot().settings.dailyLimit,
        });
        if (storageEpoch() !== epoch) throw new UiError(uiMessage('web-tools', 'sessionChanged'));
        queryClient.setQueryData(WEB_TOOL_SETTINGS_KEY, result);
        write('web-tool-settings', result);
        return result;
      });
    } catch (error) {
      setReadError(errorMessage(error, uiMessage('web-tools', 'switchFailed')));
    } finally {
      setSwitching(false);
    }
  };
  const reveal = async () => {
    if (revealed !== null || reading) {
      hide();
      return;
    }
    const controller = new AbortController();
    revealRequest.current = controller;
    setReading(true);
    setReadError('');
    try {
      await store.flush();
      controller.signal.throwIfAborted();
      const result = await api<{ apiKey: string }>(
        '/settings/web-tools/key',
        'GET',
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted && activeRef.current && storageEpoch() === epoch)
        setRevealed(result.apiKey);
    } catch (error) {
      if (!controller.signal.aborted && activeRef.current && storageEpoch() === epoch)
        setReadError(errorMessage(error, uiMessage('web-tools', 'keyFailed')));
    } finally {
      if (revealRequest.current === controller) {
        revealRequest.current = null;
        setReading(false);
      }
    }
  };
  return (
    <div className="space-y-4" onBlur={() => void store.flush().catch(() => {})}>
      <label className="block space-y-1 text-sm">
        <span>{t(($) => $.service)}</span>
        <NativeSelect
          aria-label={t(($) => $.service)}
          value={settings.provider}
          disabled={switching}
          onChange={(event) =>
            void switchProvider(event.currentTarget.value as WebToolServiceSettings['provider'])
          }
        >
          <option value="tavily">Tavily</option>
          <option value="deepseek">DeepSeek Search / Fetch</option>
        </NativeSelect>
      </label>
      <div className="space-y-1">
        <label htmlFor="web-tool-key" className="block text-sm font-medium">
          {t(($) => $.apiKey)}
        </label>
        <div className="flex items-center gap-2">
          <ApiKeyInput
            disabled={switching}
            id="web-tool-key"
            aria-label={t(($) => $.serviceKey)}
            visible={revealed !== null}
            loading={reading}
            onToggle={() => void reveal()}
            showLabel={t(($) => $.showKey)}
            hideLabel={t(($) => $.hideKey)}
            placeholder={settings.hasApiKey ? t(($) => $.keepKey) : t(($) => $.enterKey)}
            value={settings.apiKey ?? revealed ?? ''}
            onChange={(event) => update({ apiKey: event.currentTarget.value })}
          />
          <Button
            variant="secondary"
            type="button"
            disabled={switching || (!settings.hasApiKey && !settings.apiKey)}
            onClick={() => update({ apiKey: '' })}
          >
            {t(($) => $.clearKey)}
          </Button>
        </div>
      </div>
      <label className="block space-y-1 text-sm">
        <span>{t(($) => $.dailyLimit)}</span>
        <Input
          aria-label={t(($) => $.dailyLimitLabel)}
          type="number"
          min={1}
          step={1}
          className="block w-full border-input sm:max-w-56"
          value={Number.isFinite(settings.dailyLimit) ? settings.dailyLimit : ''}
          onChange={(event) => update({ dailyLimit: event.currentTarget.valueAsNumber })}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          {t(($) => $.todayUsage, {
            used: settings.usedToday,
            limit: Number.isFinite(settings.dailyLimit) ? settings.dailyLimit : '—',
          })}
        </span>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          aria-label={t(($) => $.refreshUsage)}
          onClick={() => void store.refresh(() => loadWebToolSettings()).catch(() => {})}
        >
          <RefreshCw className="h-[0.875rem] w-[0.875rem]" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t(($) => $.usageHint)}</p>
      <AutosaveToast store={store} testId="web-tool-save-status" />
      {readError && (
        <p role="alert" className="text-sm">
          {renderUiMessage(readError)}
        </p>
      )}
    </div>
  );
}
