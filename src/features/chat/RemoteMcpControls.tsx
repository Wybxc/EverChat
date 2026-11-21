import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import {
  type hostedMcpVendor,
  remoteMcpEndpoint,
  type RemoteMcpCatalog,
  type RemoteMcpConnection,
  type RemoteMcpSelection,
} from '../../../shared/tools/remote-mcp';
import { api } from '../../platform/api';
import './locales';

const key = ['remote-mcp-connections'];
type HostedVendor = ReturnType<typeof hostedMcpVendor>;
function ToolRoster({
  connection,
  selection,
  disabled,
  hostedVendor,
  onChange,
}: {
  connection: RemoteMcpConnection;
  selection?: RemoteMcpSelection;
  disabled: boolean;
  hostedVendor?: HostedVendor;
  onChange: (tools: string[], executor?: RemoteMcpSelection['executor']) => void;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });
  const catalog = useQuery({
    queryKey: ['remote-mcp-catalog', connection.id, connection.revision],
    queryFn: ({ signal }) =>
      api<RemoteMcpCatalog>(
        `/settings/remote-mcp/${connection.id}/tools`,
        'GET',
        undefined,
        signal,
      ),
    enabled: false,
    retry: false,
  });
  const tools = selection?.revision === connection.revision ? selection.tools : [];
  const stale = selection && selection.revision !== connection.revision;
  const executor = selection?.executor ?? 'everchat';
  const canUseProvider =
    hostedVendor === 'openai' ||
    (hostedVendor === 'anthropic' &&
      tools.every((name) =>
        catalog.data?.tools.some((entry) => entry.name === name && entry.readOnly),
      ));
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={catalog.isFetching}
        onClick={() => void catalog.refetch()}
      >
        {t(($) => $.remoteMcpLoadTools)}
      </Button>
      {catalog.isError && (
        <p role="alert" className="text-xs text-destructive">
          {t(($) => $.remoteMcpListFailed)}
        </p>
      )}
      {stale && <p className="text-xs text-muted-foreground">{t(($) => $.remoteMcpChanged)}</p>}
      {!!tools.length && (hostedVendor || executor === 'provider') && (
        <label className="block space-y-1 text-xs">
          <span>{t(($) => $.remoteMcpExecutor)}</span>
          <NativeSelect
            className="w-full"
            value={executor}
            onChange={(event) =>
              onChange(tools, event.currentTarget.value === 'provider' ? 'provider' : 'everchat')
            }
          >
            <option value="everchat">EverChat</option>
            <option value="provider" disabled={!canUseProvider}>
              {t(($) => $.remoteMcpViaProvider)}
            </option>
          </NativeSelect>
          {executor === 'provider' && (
            <span className="block text-muted-foreground">{t(($) => $.remoteMcpHostedHint)}</span>
          )}
        </label>
      )}
      {catalog.data?.tools.length === 0 && (
        <p className="text-xs text-muted-foreground">{t(($) => $.remoteMcpNoTools)}</p>
      )}
      {!catalog.data && !!tools.length && (
        <p className="break-all text-xs text-muted-foreground">{tools.join(', ')}</p>
      )}
      {catalog.data && (
        <ul className="mt-2 max-h-64 space-y-2 overflow-auto">
          {catalog.data.tools.map((tool) => {
            const selected = tools.includes(tool.name);
            return (
              <li key={tool.name}>
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <Checkbox
                    checked={selected}
                    disabled={
                      !selected &&
                      (disabled ||
                        tools.length >= 8 ||
                        (executor === 'provider' && hostedVendor === 'anthropic' && !tool.readOnly))
                    }
                    onCheckedChange={(checked) =>
                      onChange(
                        checked
                          ? [...tools, tool.name]
                          : tools.filter((name) => name !== tool.name),
                      )
                    }
                  />
                  <span className="min-w-0 break-words">
                    {tool.title}{' '}
                    <span className="text-xs text-muted-foreground">
                      {tool.readOnly
                        ? t(($) => $.remoteMcpReadOnly)
                        : t(($) => $.remoteMcpNeedsApproval)}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function ConnectionEditor({
  connection,
  close,
  onRemoved,
}: {
  connection?: RemoteMcpConnection;
  close: () => void;
  onRemoved: (id: string) => void;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });
  const cache = useQueryClient();
  const [name, setName] = useState(connection?.name ?? '');
  const [endpoint, setEndpoint] = useState(connection?.endpoint ?? '');
  const [token, setToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  const save = async (remove = false) => {
    if (busy || (!remove && (!name.trim() || !remoteMcpEndpoint(endpoint.trim())))) return;
    setBusy(true);
    setFailed(false);
    const id = connection?.id ?? crypto.randomUUID();
    try {
      if (remove) {
        await api(`/settings/remote-mcp/${id}`, 'DELETE');
        onRemoved(id);
      } else {
        await api(`/settings/remote-mcp/${id}`, 'PUT', {
          name: name.trim(),
          endpoint: endpoint.trim(),
          ...(token.trim() ? { token: token.trim() } : removeToken ? { token: null } : {}),
        });
      }
      await cache.invalidateQueries({ queryKey: key });
      close();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded border p-3">
      <label className="block space-y-1 text-xs">
        <span>{t(($) => $.remoteMcpName)}</span>
        <Input
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label className="block space-y-1 text-xs">
        <span>{t(($) => $.remoteMcpEndpoint)}</span>
        <Input
          type="url"
          value={endpoint}
          maxLength={1200}
          onChange={(event) => setEndpoint(event.currentTarget.value)}
        />
      </label>
      <label className="block space-y-1 text-xs">
        <span>{t(($) => $.remoteMcpToken)}</span>
        <Input
          type="password"
          autoComplete="off"
          value={token}
          maxLength={4096}
          onChange={(event) => setToken(event.currentTarget.value)}
        />
      </label>
      {connection?.hasToken && !token && (
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={removeToken}
            onCheckedChange={(checked) => setRemoveToken(checked === true)}
          />
          {t(($) => $.remoteMcpClearToken)}
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !name.trim() || !remoteMcpEndpoint(endpoint.trim())}
          onClick={() => void save()}
        >
          {t(($) => $.remoteMcpSave)}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={close} disabled={busy}>
          {t(($) => $.remoteMcpCancel)}
        </Button>
        {connection && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => (confirmRemove ? void save(true) : setConfirmRemove(true))}
          >
            {confirmRemove ? t(($) => $.remoteMcpConfirmRemove) : t(($) => $.remoteMcpRemove)}
          </Button>
        )}
      </div>
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          {t(($) => $.remoteMcpSaveFailed)}
        </p>
      )}
    </div>
  );
}

export function RemoteMcpControls({
  open,
  enabled,
  hostedVendor,
  selected = [],
  onChange,
}: {
  open: boolean;
  enabled: boolean;
  hostedVendor?: HostedVendor;
  selected?: RemoteMcpSelection[];
  onChange: (selection: RemoteMcpSelection[]) => void;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });
  const [editing, setEditing] = useState<string>();
  const connections = useQuery({
    queryKey: key,
    enabled: open,
    queryFn: ({ signal }) =>
      api<RemoteMcpConnection[]>('/settings/remote-mcp', 'GET', undefined, signal),
  });
  const remove = (id: string) => onChange(selected.filter((item) => item.id !== id));
  return (
    <section className="space-y-2 border-t pt-3" aria-label={t(($) => $.remoteMcp)}>
      <h3 className="text-sm font-medium">{t(($) => $.remoteMcp)}</h3>
      <p className="text-xs text-muted-foreground">{t(($) => $.remoteMcpHint)}</p>
      {!enabled && <p className="text-xs text-muted-foreground">{t(($) => $.toolsUnsupported)}</p>}
      {connections.isError && (
        <p role="alert" className="text-xs text-destructive">
          {t(($) => $.remoteMcpListFailed)}
        </p>
      )}
      {connections.data?.map((connection) => {
        const selection = selected.find(({ id }) => id === connection.id);
        return (
          <div key={connection.id} className="space-y-2 rounded-md border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 break-words text-sm font-medium">{connection.name}</p>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setEditing(connection.id)}
              >
                {t(($) => $.remoteMcpEdit)}
              </Button>
            </div>
            <p className="break-all text-xs text-muted-foreground">{connection.endpoint}</p>
            {editing === connection.id ? (
              <ConnectionEditor
                connection={connection}
                close={() => setEditing(undefined)}
                onRemoved={remove}
              />
            ) : (
              <>
                <ToolRoster
                  connection={connection}
                  selection={selection}
                  hostedVendor={hostedVendor}
                  disabled={!enabled || (!selection && selected.length >= 2)}
                  onChange={(tools, executor = selection?.executor) =>
                    onChange([
                      ...selected.filter(({ id }) => id !== connection.id),
                      ...(tools.length
                        ? [
                            {
                              id: connection.id,
                              revision: connection.revision,
                              tools,
                              ...(executor ? { executor } : {}),
                            },
                          ]
                        : []),
                    ])
                  }
                />
                {selection && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(connection.id)}
                  >
                    {t(($) => $.remoteMcpDisable)}
                  </Button>
                )}
              </>
            )}
          </div>
        );
      })}
      {connections.data &&
        selected
          .filter(({ id }) => !connections.data.some((item) => item.id === id))
          .map(({ id }) => (
            <Button key={id} type="button" size="sm" variant="outline" onClick={() => remove(id)}>
              {t(($) => $.remoteMcpForgetMissing)}
            </Button>
          ))}
      {editing === 'new' ? (
        <ConnectionEditor close={() => setEditing(undefined)} onRemoved={remove} />
      ) : (
        <Button type="button" size="sm" variant="secondary" onClick={() => setEditing('new')}>
          {t(($) => $.remoteMcpAdd)}
        </Button>
      )}
    </section>
  );
}
