import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Plus } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupInput, InputGroupAddon } from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import { useToastManager } from '@/components/ui/toast';
import { Modal, ModalTitle } from '../../components/Modal';
import { api } from '../../platform/api';
import { errorMessage, renderUiMessage } from '../../platform/i18n/messages';
import type { McpKeyInfo } from '../../../shared/mcp/types';
import { McpKeyList } from './McpKeyList';
import './locales';

const queryKey = ['mcp-keys'];
type KeyList = { keys: McpKeyInfo[]; endpoint: string };
type Editor = { kind: 'create' } | { kind: 'rename'; key: McpKeyInfo };
export default function McpSettings() {
  const { t } = useTranslation('mcp');
  const client = useQueryClient(),
    toast = useToastManager();
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api<KeyList>('/settings/mcp/keys', 'GET', undefined, signal),
  });
  const [editor, setEditor] = useState<Editor | null>(null),
    [name, setName] = useState(''),
    [readSystemPrompts, setReadSystemPrompts] = useState(false),
    [created, setCreated] = useState<(McpKeyInfo & { key: string }) | null>(null),
    [deleting, setDeleting] = useState<McpKeyInfo | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const copyCreated = useRef<HTMLButtonElement>(null),
    nameInput = useRef<HTMLInputElement>(null),
    cancelDelete = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (created) copyCreated.current?.focus({ preventScroll: true });
  }, [created]);
  const edit = (value: Editor) => {
    setName(value.kind === 'rename' ? value.key.name : '');
    setReadSystemPrompts(value.kind === 'rename' ? value.key.readSystemPrompts : false);
    setError(null);
    setEditor(value);
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.add({
        description: t(($) => $.copied),
        timeout: 2000,
        data: { icon: <Check />, testId: 'mcp-copy-status' },
      });
    } catch (failure) {
      setError(failure);
    }
  };
  const save = async () => {
    if (!editor || pending || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      if (editor.kind === 'create') {
        const result = await api<McpKeyInfo & { key: string }>('/settings/mcp/keys', 'POST', {
          name: name.trim(),
          readSystemPrompts,
        });
        setCreated(result);
        // Only public metadata enters React Query. The one-time secret stays in this dialog.
        const { key: _secret, ...metadata } = result;
        client.setQueryData<KeyList>(
          queryKey,
          (old) => old && { ...old, keys: [metadata, ...old.keys] },
        );
      } else {
        const updated = await api<McpKeyInfo>(`/settings/mcp/keys/${editor.key.id}`, 'PATCH', {
          name: name.trim(),
          readSystemPrompts,
        });
        client.setQueryData<KeyList>(
          queryKey,
          (old) =>
            old && { ...old, keys: old.keys.map((key) => (key.id === updated.id ? updated : key)) },
        );
        toast.add({ description: t(($) => $.renamed), timeout: 2000 });
      }
      setEditor(null);
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  };
  const remove = async () => {
    if (!deleting || pending) return;
    setPending(true);
    setError(null);
    try {
      await api(`/settings/mcp/keys/${deleting.id}`, 'DELETE');
      client.setQueryData<KeyList>(
        queryKey,
        (old) => old && { ...old, keys: old.keys.filter((key) => key.id !== deleting.id) },
      );
      setDeleting(null);
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  };
  const failure = error !== null && (
    <Alert variant="destructive">{renderUiMessage(errorMessage(error))}</Alert>
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-medium">{t(($) => $.keys)}</h2>
        <Button disabled={!query.data || pending} onClick={() => edit({ kind: 'create' })}>
          <Plus data-icon="inline-start" />
          {t(($) => $.create)}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t(($) => $.access)}</p>
      <Field>
        <FieldLabel htmlFor="mcp-endpoint">{t(($) => $.endpoint)}</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id="mcp-endpoint"
            readOnly
            value={query.data?.endpoint ?? `${location.origin}/mcp`}
          />
          <InputGroupAddon align="inline-end" className="has-[>button]:mr-0">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t(($) => $.copy)}
              onClick={() => void copy(query.data?.endpoint ?? `${location.origin}/mcp`)}
            >
              <Copy />
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </Field>
      {query.data ? (
        <McpKeyList
          keys={query.data.keys}
          disabled={pending}
          onRename={(key) => edit({ kind: 'rename', key })}
          onDelete={(key) => {
            setError(null);
            setDeleting(key);
          }}
        />
      ) : query.isError ? (
        <Alert>
          <p>{renderUiMessage(errorMessage(query.error))}</p>
          <Button variant="secondary" onClick={() => void query.refetch()}>
            {t(($) => $.reload)}
          </Button>
        </Alert>
      ) : (
        <Spinner role="status" aria-label={t(($) => $.loading)} />
      )}
      {!editor && !created && !deleting && failure}
      <Modal
        open={Boolean(editor || created)}
        busy={pending}
        initialFocus={created ? false : nameInput}
        onOpenChange={(open) => {
          if (!open) {
            setEditor(null);
            setCreated(null);
            setError(null);
          }
        }}
        className="max-w-md w-[calc(100%-2rem)]"
      >
        <div className="flex flex-col gap-4">
          <ModalTitle>
            {created
              ? t(($) => $.created)
              : editor?.kind === 'rename'
                ? t(($) => $.rename)
                : t(($) => $.create)}
          </ModalTitle>
          {created ? (
            <>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="mcp-created-key">{t(($) => $.key)}</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id="mcp-created-key"
                      value={created.key}
                      readOnly
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <InputGroupAddon align="inline-end" className="has-[>button]:mr-0">
                      <Button
                        ref={copyCreated}
                        variant="ghost"
                        size="icon"
                        aria-label={t(($) => $.copy)}
                        onClick={() => void copy(created.key)}
                      >
                        <Copy />
                      </Button>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
                <p className="text-sm text-muted-foreground">{t(($) => $.once)}</p>
              </FieldGroup>
              {failure}
              <div className="flex justify-end">
                <Button
                  onClick={() => {
                    setCreated(null);
                    setError(null);
                  }}
                >
                  {t(($) => $.saved)}
                </Button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
              className="flex flex-col gap-4"
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="mcp-key-name">{t(($) => $.name)}</FieldLabel>
                  <Input
                    ref={nameInput}
                    id="mcp-key-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={100}
                    required
                    disabled={pending}
                    autoComplete="off"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="mcp-read-system-prompts" className="flex items-center gap-2">
                    <Checkbox
                      id="mcp-read-system-prompts"
                      aria-describedby="mcp-system-prompt-access"
                      checked={readSystemPrompts}
                      onCheckedChange={(value) => setReadSystemPrompts(value === true)}
                      disabled={pending}
                    />
                    {t(($) => $.readSystemPrompts)}
                  </FieldLabel>
                  <p id="mcp-system-prompt-access" className="text-sm text-muted-foreground">
                    {t(($) => $.systemPromptAccess)}
                  </p>
                </Field>
              </FieldGroup>
              {failure}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setEditor(null);
                    setError(null);
                  }}
                >
                  {t(($) => $.cancel)}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    pending ||
                    !name.trim() ||
                    (editor?.kind === 'rename' &&
                      name.trim() === editor.key.name &&
                      readSystemPrompts === editor.key.readSystemPrompts)
                  }
                >
                  {pending && <Spinner data-icon="inline-start" />}
                  {editor?.kind === 'rename' ? t(($) => $.save) : t(($) => $.create)}
                </Button>
              </div>
            </form>
          )}
        </div>
      </Modal>
      <Modal
        open={Boolean(deleting)}
        alert
        busy={pending}
        initialFocus={cancelDelete}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            setError(null);
          }
        }}
        className="max-w-sm w-[calc(100%-2rem)]"
      >
        <div className="flex flex-col gap-4">
          <ModalTitle>{t(($) => $.deleteTitle)}</ModalTitle>
          <p className="break-words text-sm">
            {t(($) => $.deleteConfirm, { name: deleting?.name ?? '' })}
          </p>
          {failure}
          <div className="flex justify-end gap-2">
            <Button
              ref={cancelDelete}
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setDeleting(null);
                setError(null);
              }}
            >
              {t(($) => $.cancel)}
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => void remove()}>
              {pending && <Spinner data-icon="inline-start" />}
              {t(($) => $.delete)}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
