import { MAX_MODEL_TOKENS } from '../../shared/models/metadata';
import { MAX_SYSTEM_PROMPT_LENGTH } from '../../shared/conversation/limits';
import { storageEpoch } from '../platform/storage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { LoadingContent } from './AppFrame';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ProviderSettings } from '../../shared/providers/types';
import { Switch } from '@/components/ui/switch';
import { DEFAULT_TITLE_SETTINGS } from '../../shared/conversation/titles';
import { Disclosure, DisclosureScope } from '../components/Disclosure';
import { PromptPresetsPanel } from '../features/presets/PromptPresets';
import { ProviderEditor } from '../features/providers/ProviderEditor';
import { availableModels, reconcile } from '../features/providers/selection';
import { SettingsAutosave } from '../features/providers/settings-autosave';
import { WebToolSettingsPanel } from '../features/web-tools/WebToolSettings';
import { api } from '../platform/api';
import { useMediaQuery } from '../platform/useMediaQuery';
import { PwaSettings } from '../platform/pwa/PwaControls';

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
};
const tabs = [
  { id: 'general', label: '通用' },
  { id: 'providers', label: '供应商' },
  { id: 'chat', label: '对话' },
  { id: 'presets', label: '预设' },
  { id: 'web-tools', label: '联网' },
] as const;
export type SettingsTab = (typeof tabs)[number]['id'];

export function SettingsPanel(props: PanelProps) {
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
          if (epoch !== storageEpoch()) throw new Error('登录状态已改变。');
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
          <TabsList aria-label="设置分类" className="settings-tab-list">
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
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div
            data-testid="settings-scroll"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4"
          >
            <section
              id="settings-panel-general"
              role="tabpanel"
              aria-labelledby="settings-tab-general"
              hidden={tab !== 'general'}
              className="space-y-4"
            >
              {props.themeControl}
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
                    退出并清除本地记录
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    同时退出此账号的其他 Cloudflare Access 应用。
                  </p>
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
                    身份确认后可用
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
                            {query.error.message}
                          </p>
                          <Button variant="secondary" onClick={() => void query.refetch()}>
                            重新读取
                          </Button>
                        </div>
                      ) : (
                        <LoadingContent label="正在读取设置" />
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
                  <PromptPresetsPanel open={open && tab === 'presets'} />
                </section>
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
    </DisclosureScope>,
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
  const { settings, status, error } = useSyncExternalStore(store.subscribe, store.getSnapshot);
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
            默认模型
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
            <option value="">未选择模型</option>
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
        <Disclosure title="自动标题" stateKey="title-settings">
          <div className="space-y-3">
            <label className="block space-y-1 text-sm">
              <span>标题模型</span>
              <NativeSelect
                aria-label="标题模型"
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
                <option value="">未选择模型</option>
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
                      所选模型不可用，请重新选择
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
              首条回答完成后自动命名
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
            <p className="text-xs text-muted-foreground">
              每次命名会单独调用所选模型。未配置时保留首条消息标题。
            </p>
          </div>
        </Disclosure>
        <div className="space-y-1">
          <label htmlFor="provider-prompt" className="block text-sm font-medium">
            系统提示词
          </label>
          <Textarea
            id="provider-prompt"
            rows={6}
            maxLength={MAX_SYSTEM_PROMPT_LENGTH}
            className="w-full border-input"
            value={settings.systemPrompt}
            onChange={(event) => update({ ...settings, systemPrompt: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="provider-tokens" className="block text-sm font-medium">
            输出上限（Tokens）
          </label>
          <Input
            id="provider-tokens"
            type="number"
            min={1}
            max={MAX_MODEL_TOKENS}
            step={1}
            placeholder="不设置"
            className="w-full border-input sm:max-w-48"
            value={settings.maxOutputTokens ?? ''}
            onChange={(event) =>
              update({
                ...settings,
                maxOutputTokens: event.target.value === '' ? null : Number(event.target.value),
              })
            }
          />
        </div>
      </section>

      <div className="sticky bottom-0 z-10 flex shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-3 py-2 text-xs sm:px-4 text-muted-foreground">
        <p data-testid="settings-save-status" role={status === 'error' ? 'alert' : 'status'}>
          {status === 'error'
            ? `未保存 · ${error}`
            : status === 'saving'
              ? '保存中…'
              : status === 'waiting'
                ? '保存中…'
                : '已保存'}
        </p>
        {status === 'error' && (
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              void store.flush().catch(() => {});
            }}
          >
            重试
          </Button>
        )}
      </div>
    </div>
  );
}
