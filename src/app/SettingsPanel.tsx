import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToastRegion } from '@/components/ui/toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_TITLE_SETTINGS } from '../../shared/conversation/titles';
import type { ProviderSettings } from '../../shared/providers/types';
import { DisclosureScope } from '../components/Disclosure';
import { AutosaveToast } from '../components/AutosaveToast';
import { NotificationSettings } from '../features/notifications/NotificationSettings';
import { PromptPresetsPanel } from '../features/presets/PromptPresets';
import { ProviderEditor } from '../features/providers/ProviderEditor';
import { availableModels, reconcile } from '../features/providers/selection';
import { SettingsAutosave } from '../features/providers/settings-autosave';
import { WebToolSettingsPanel } from '../features/web-tools/WebToolSettings';
import { api } from '../platform/api';
import { LanguageControl } from '../platform/i18n/LanguageControl';
import { errorMessage, renderUiMessage, UiError, uiMessage } from '../platform/i18n/messages';
import { PwaSettings } from '../platform/pwa/PwaControls';
import { storageEpoch } from '../platform/storage';
import { useMediaQuery } from '../platform/useMediaQuery';
import { LoadingContent } from './AppFrame';
import './locales';

type PanelProps = {
  render: (content: ReactNode) => ReactNode;
  open: boolean;
  requestedTab?: SettingsTab;
  requestedProviderId?: string;
  onTabChange?: (tab: SettingsTab) => void;
  onSaved?: (settings: ProviderSettings) => void;
  authenticated?: boolean;
  themeControl: ReactNode;
  onLogout?: () => void;
  onLocate?: (conversationId: string, messageId: string) => void;
};
const tabs = [
  { id: 'general', label: 'general' },
  { id: 'providers', label: 'providers' },
  { id: 'chat', label: 'chat' },
  { id: 'presets', label: 'presets' },
  { id: 'web-tools', label: 'webTools' },
  { id: 'usage', label: 'usage' },
  { id: 'shares', label: 'sharing' },
  { id: 'mcp', label: 'mcp' },
] as const;
export type SettingsTab = (typeof tabs)[number]['id'];
const ShareManagement = lazy(() => import('../features/sharing/ShareManagement'));
const UsageSettings = lazy(() => import('../features/usage/UsageSettings'));
const McpSettings = lazy(() => import('../features/mcp/McpSettings'));

export function SettingsPanel(props: PanelProps) {
  const { t } = useTranslation('app', { useSuspense: false });

  const { open, requestedTab, authenticated = true } = props;
  const verticalTabs = useMediaQuery('(min-width: 40rem)');
  const [tab, setTab] = useState<SettingsTab>(requestedTab ?? 'general');
  useEffect(() => {
    if (open && requestedTab) setTab(requestedTab);
  }, [open, requestedTab]);
  const providerTab = tab === 'providers' || tab === 'chat';
  const query = useQuery({
    queryKey: ['provider-settings'],
    queryFn: ({ signal }) => api<ProviderSettings>('/settings/providers', 'GET', undefined, signal),
    enabled: open && authenticated && providerTab,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const queryClient = useQueryClient();
  const onSavedRef = useRef(props.onSaved);
  onSavedRef.current = props.onSaved;
  const [epoch] = useState(storageEpoch);
  const [store, setStore] = useState<SettingsAutosave | null>(null);
  useEffect(() => {
    if (!authenticated || !query.data || store) return;
    setStore(
      new SettingsAutosave(
        query.data,
        (input) => {
          if (epoch !== storageEpoch()) throw new UiError(uiMessage('app', 'sessionChanged'));
          return api<ProviderSettings>('/settings/providers', 'PUT', input);
        },
        (result) => {
          if (epoch !== storageEpoch()) return;
          queryClient.setQueryData(['provider-settings'], result);
          onSavedRef.current?.(result);
        },
      ),
    );
  }, [authenticated, query.data, store, epoch, queryClient]);
  useEffect(() => () => store?.dispose(), [store]);
  const wasActive = useRef<boolean | null>(null);
  useEffect(() => {
    if (!store) return;
    const active = open && providerTab;
    if (!active) void store.flush().catch(() => {});
    else if (wasActive.current === false)
      void store.refresh(() => api<ProviderSettings>('/settings/providers')).catch(() => {});
    wasActive.current = active;
  }, [open, providerTab, store]);
  useEffect(() => {
    const retry = () => {
      void store?.flush().catch(() => {});
    };
    window.addEventListener('everchat:network-ready', retry);
    return () => window.removeEventListener('everchat:network-ready', retry);
  }, [store]);
  return props.render(
    <ToastRegion>
      <DisclosureScope>
        <div className="settings-fields flex min-h-0 flex-1 flex-col">
          <Tabs
            orientation={verticalTabs ? 'vertical' : 'horizontal'}
            value={tab}
            onValueChange={(value) => {
              setTab(value as SettingsTab);
              props.onTabChange?.(value as SettingsTab);
            }}
            className="settings-tabs"
          >
            <TabsList aria-label={t(($) => $.settingsCategories)} className="settings-tab-list">
              {tabs.map((item) => (
                <TabsTrigger
                  key={item.id}
                  id={`settings-tab-${item.id}`}
                  value={item.id}
                  aria-controls={`settings-panel-${item.id}`}
                  onFocus={(event) =>
                    event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })
                  }
                >
                  {t(($) => $[item.label])}
                </TabsTrigger>
              ))}
            </TabsList>
            <div
              data-testid="settings-scroll"
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-0 sm:p-4 sm:pb-0"
            >
              <section
                id="settings-panel-general"
                role="tabpanel"
                aria-labelledby="settings-tab-general"
                hidden={tab !== 'general'}
                className="space-y-4"
              >
                <LanguageControl />
                {props.themeControl}
                <NotificationSettings />
                <PwaSettings />
                {props.onLogout && (
                  <>
                    <Button
                      variant="secondary"
                      type="button"
                      className="gap-2"
                      onClick={props.onLogout}
                    >
                      <LogOut className="size-4" />
                      {t(($) => $.signOut)}
                    </Button>
                    <p className="text-xs text-muted-foreground">{t(($) => $.accessSignOutHint)}</p>
                  </>
                )}
              </section>
              {!authenticated ? (
                tab !== 'general' && (
                  <section
                    id={`settings-panel-${tab}`}
                    role="tabpanel"
                    aria-labelledby={`settings-tab-${tab}`}
                  >
                    <p role="status" className="py-4 text-sm text-muted-foreground">
                      {t(($) => $.availableAfterSignIn)}
                    </p>
                  </section>
                )
              ) : (
                <>
                  <div hidden={!providerTab}>
                    {store ? (
                      <SettingsForm
                        store={store}
                        open={open}
                        tab={tab}
                        requestedProviderId={props.requestedProviderId}
                      />
                    ) : (
                      <section
                        role="tabpanel"
                        id={`settings-panel-${providerTab ? tab : 'providers'}`}
                        aria-labelledby={`settings-tab-${providerTab ? tab : 'providers'}`}
                      >
                        {query.isError ? (
                          <div className="space-y-3 py-4">
                            <p role="alert" className="text-sm">
                              {renderUiMessage(errorMessage(query.error))}
                            </p>
                            <Button variant="secondary" onClick={() => void query.refetch()}>
                              {t(($) => $.reload)}
                            </Button>
                          </div>
                        ) : (
                          <LoadingContent label={t(($) => $.loadingSettings)} />
                        )}
                      </section>
                    )}
                  </div>
                  <section
                    id="settings-panel-presets"
                    role="tabpanel"
                    aria-labelledby="settings-tab-presets"
                    hidden={tab !== 'presets'}
                  >
                    <PromptPresetsPanel
                      open={open && tab === 'presets'}
                      beforeDefaultSave={() => store?.flush() ?? Promise.resolve()}
                      onDefaultSaved={async () => {
                        const config = await api<ProviderSettings>('/settings/providers');
                        if (epoch !== storageEpoch()) return;
                        store?.receive(config);
                        queryClient.setQueryData(['provider-settings'], config);
                        onSavedRef.current?.(config);
                      }}
                    />
                  </section>
                  {open && tab === 'mcp' && (
                    <section
                      id="settings-panel-mcp"
                      role="tabpanel"
                      aria-labelledby="settings-tab-mcp"
                    >
                      <Suspense fallback={<LoadingContent label={t(($) => $.mcp)} />}>
                        <McpSettings />
                      </Suspense>
                    </section>
                  )}
                  {open && tab === 'shares' && (
                    <section
                      id="settings-panel-shares"
                      role="tabpanel"
                      aria-labelledby="settings-tab-shares"
                    >
                      <Suspense fallback={<LoadingContent label={t(($) => $.loadingShares)} />}>
                        <ShareManagement active />
                      </Suspense>
                    </section>
                  )}
                  {open && tab === 'usage' && (
                    <section
                      id="settings-panel-usage"
                      role="tabpanel"
                      aria-labelledby="settings-tab-usage"
                    >
                      <Suspense fallback={<LoadingContent label={t(($) => $.loadingUsage)} />}>
                        <UsageSettings onLocate={props.onLocate} />
                      </Suspense>
                    </section>
                  )}
                  <section
                    id="settings-panel-web-tools"
                    role="tabpanel"
                    aria-labelledby="settings-tab-web-tools"
                    hidden={tab !== 'web-tools'}
                  >
                    <WebToolSettingsPanel active={open && tab === 'web-tools'} />
                  </section>
                </>
              )}
            </div>
          </Tabs>
        </div>
      </DisclosureScope>
    </ToastRegion>,
  );
}

function SettingsForm({
  store,
  open,
  tab,
  requestedProviderId,
}: {
  store: SettingsAutosave;
  open: boolean;
  tab: SettingsTab;
  requestedProviderId?: string;
}) {
  const { t } = useTranslation('app', { useSuspense: false });

  const { settings } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const update = (next: ProviderSettings) => store.update(reconcile(next));
  const enabled = availableModels(settings);
  return (
    <div
      onBlur={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
          void store.flush().catch(() => {});
      }}
    >
      <section
        id="settings-panel-providers"
        role="tabpanel"
        aria-labelledby="settings-tab-providers"
        hidden={tab !== 'providers'}
      >
        <ProviderEditor
          store={store}
          settings={settings}
          open={open}
          active={tab === 'providers'}
          requestedProviderId={requestedProviderId}
        />
      </section>
      <section
        id="settings-panel-chat"
        role="tabpanel"
        aria-labelledby="settings-tab-chat"
        hidden={tab !== 'chat'}
        className="space-y-4"
      >
        <div className="space-y-1">
          <label htmlFor="default-model" className="block text-sm font-medium">
            {t(($) => $.defaultModel)}
          </label>
          <NativeSelect
            id="default-model"
            className="w-full border-input"
            value={
              settings.activeProviderId
                ? JSON.stringify([settings.activeProviderId, settings.activeModel])
                : ''
            }
            onChange={(event) => {
              const [activeProviderId, activeModel] = event.target.value
                ? (JSON.parse(event.target.value) as [string, string])
                : [null, ''];
              update({ ...settings, activeProviderId, activeModel });
            }}
          >
            <option value="">{t(($) => $.noModel)}</option>
            {settings.providers.map((profile) => (
              <optgroup key={profile.id} label={profile.name}>
                {enabled
                  .filter((item) => item.profile.id === profile.id)
                  .map(({ model }) => (
                    <option key={model.id} value={JSON.stringify([profile.id, model.id])}>
                      {model.name || model.id}
                    </option>
                  ))}
              </optgroup>
            ))}
          </NativeSelect>
        </div>
        <section
          aria-labelledby="title-settings-heading"
          className="space-y-3 border-t border-border pt-4"
        >
          <h3 id="title-settings-heading" className="text-sm font-semibold">
            {t(($) => $.automaticTitle)}
          </h3>
          <div className="space-y-3">
            <label className="block space-y-1 text-sm">
              <span>{t(($) => $.titleModel)}</span>
              <NativeSelect
                aria-label={t(($) => $.titleModel)}
                className="w-full"
                value={
                  settings.title?.model
                    ? JSON.stringify([settings.title.model.providerId, settings.title.model.model])
                    : ''
                }
                onChange={(event) => {
                  const model = event.target.value
                    ? (JSON.parse(event.target.value) as [string, string])
                    : null;
                  update({
                    ...settings,
                    title: {
                      ...(settings.title ?? DEFAULT_TITLE_SETTINGS),
                      model: model ? { providerId: model[0], model: model[1] } : null,
                    },
                  });
                }}
              >
                <option value="">{t(($) => $.noModel)}</option>
                {settings.title?.model &&
                  !enabled.some(
                    ({ profile, model }) =>
                      profile.id === settings.title!.model!.providerId &&
                      model.id === settings.title!.model!.model,
                  ) && (
                    <option
                      value={JSON.stringify([
                        settings.title.model.providerId,
                        settings.title.model.model,
                      ])}
                    >
                      {t(($) => $.modelUnavailable)}
                    </option>
                  )}
                {enabled.map(({ profile, model }) => (
                  <option
                    key={`${profile.id}:${model.id}`}
                    value={JSON.stringify([profile.id, model.id])}
                  >
                    {profile.name} · {model.name || model.id}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
              {t(($) => $.titleAfterFirstAnswer)}
              <Switch
                checked={settings.title?.automatic ?? false}
                disabled={!settings.title?.model}
                onCheckedChange={(automatic) =>
                  update({
                    ...settings,
                    title: { ...(settings.title ?? DEFAULT_TITLE_SETTINGS), automatic },
                  })
                }
              />
            </label>
            <p className="text-xs text-muted-foreground">{t(($) => $.titleModelHint)}</p>
          </div>
        </section>
      </section>

      <AutosaveToast store={store} testId="settings-save-status" />
    </div>
  );
}
