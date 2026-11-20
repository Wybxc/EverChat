import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { McpOAuthConnection } from '../../../shared/mcp/types';
import { Modal, ModalTitle } from '../../components/Modal';
import { api } from '../../platform/api';
import { formatDateTime } from '../../platform/i18n/format';
import { errorMessage, renderUiMessage } from '../../platform/i18n/messages';

const path = '/settings/mcp/oauth-grants';
const queryKey = ['mcp-oauth-grants'];
type Connections = { enabled: boolean; connections: McpOAuthConnection[] };

export function McpOAuthConnections() {
  const { t } = useTranslation('mcp');
  const cache = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api<Connections>(path, 'GET', undefined, signal),
  });
  const [selected, setSelected] = useState<McpOAuthConnection | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const close = () => {
    setSelected(null);
    setFailure(null);
  };
  const disconnect = async () => {
    if (!selected || pending) return;
    setPending(true);
    setFailure(null);
    try {
      await api(`${path}/${selected.id}`, 'DELETE');
      cache.setQueryData<Connections>(
        queryKey,
        (previous) =>
          previous && {
            ...previous,
            connections: previous.connections.filter(({ id }) => id !== selected.id),
          },
      );
      void cache.invalidateQueries({ queryKey });
      close();
    } catch (error) {
      setFailure(error);
    } finally {
      setPending(false);
    }
  };

  if (query.isError)
    return (
      <Alert>
        <p>{renderUiMessage(errorMessage(query.error))}</p>
        <Button variant="secondary" onClick={() => void query.refetch()}>
          {t(($) => $.reload)}
        </Button>
      </Alert>
    );
  if (!query.data?.enabled) return null;
  const date = (at: number) => formatDateTime(at, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <section aria-labelledby="mcp-apps" className="flex flex-col gap-2">
      <h2 id="mcp-apps" className="text-base font-medium">
        {t(($) => $.authorizedApps)}
      </h2>
      <p className="text-sm text-muted-foreground">{t(($) => $.oauthAccess)}</p>
      {query.data.connections.length ? (
        <ul className="divide-y divide-border">
          {query.data.connections.map((app) => (
            <li key={app.id} className="flex items-start justify-between gap-3 py-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="break-words text-sm font-medium">{app.name}</span>
                <span className="break-all text-xs text-muted-foreground">
                  {app.redirectOrigin}
                </span>
                <dl className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <div className="flex gap-1">
                    <dt>{t(($) => $.authorizedAt)}</dt>
                    <dd>{date(app.createdAt)}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>{t(($) => $.lastUsedAt)}</dt>
                    <dd>
                      {app.lastUsedAt === null ? t(($) => $.neverUsed) : date(app.lastUsedAt)}
                    </dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>{t(($) => $.expiresAt)}</dt>
                    <dd>{date(app.expiresAt)}</dd>
                  </div>
                </dl>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                aria-label={t(($) => $.disconnectApp, { name: app.name })}
                onClick={() => setSelected(app)}
              >
                {t(($) => $.disconnect)}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">{t(($) => $.noAuthorizedApps)}</p>
      )}
      <Modal
        open={Boolean(selected)}
        alert
        busy={pending}
        initialFocus={cancel}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        className="max-w-sm w-[calc(100%-2rem)]"
      >
        <div className="flex flex-col gap-4">
          <ModalTitle>{t(($) => $.disconnectTitle)}</ModalTitle>
          <p className="break-words text-sm">
            {t(($) => $.disconnectConfirm, { name: selected?.name ?? '' })}
          </p>
          {failure !== null && (
            <Alert variant="destructive">{renderUiMessage(errorMessage(failure))}</Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button ref={cancel} variant="ghost" disabled={pending} onClick={close}>
              {t(($) => $.cancel)}
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => void disconnect()}>
              {pending && <Spinner data-icon="inline-start" />}
              {t(($) => $.disconnect)}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
