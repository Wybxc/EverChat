import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { X } from 'lucide-react';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { branchPath } from '../../../shared/conversation/branch-path';
import { messageText } from '../../../shared/conversation/content';
import { summaryGeneration } from '../../../shared/conversation/summaries';
import { type Message, type SubmitInput } from '../../../shared/conversation/types';
import { modelSelectionKey } from '../../../shared/models/selection';
import { type ChatModel, type ModelSelection } from '../../../shared/models/types';
import { Modal, ModalTitle } from '../../components/Modal';
import { formatNumber } from '../../platform/i18n/format';
import {
  errorMessage,
  renderUiMessage,
  uiMessage,
  type UiMessage,
} from '../../platform/i18n/messages';
import './locales';

export function SummaryDialog({
  messages,
  headId,
  models,
  preferred,
  target,
  busy,
  submit,
  close,
  focusComposer,
}: {
  messages: Message[];
  headId: string | null;
  models: ChatModel[];
  preferred?: ChatModel;
  target?: { throughId: string; selection?: ModelSelection };
  busy: boolean;
  submit: (input: SubmitInput) => Promise<void>;
  close: () => void;
  focusComposer: () => void;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });

  const titleId = useId(),
    first = useRef<HTMLSelectElement>(null),
    lock = useRef(false),
    submitted = useRef(false);
  let path: Message[] = [];
  try {
    if (headId) path = branchPath(messages, headId);
  } catch {
    /* The server checks broken paths too. */
  }
  const boundaries = path.filter(
    (message) =>
      message.role === 'assistant' &&
      message.status === 'completed' &&
      !message.deletedAt &&
      !message.summary,
  );
  const [throughId, setThroughId] = useState(
    target?.throughId ?? boundaries.at(-2)?.id ?? boundaries.at(-1)?.id ?? '',
  );
  const [modelKey, setModelKey] = useState(
    target?.selection
      ? modelSelectionKey(target.selection)
      : preferred
        ? modelSelectionKey(preferred)
        : '',
  );
  const [sending, setSending] = useState(false),
    [error, setError] = useState<UiMessage>('');
  const model =
    models.find((model) => modelSelectionKey(model) === modelKey) ?? preferred ?? models[0];
  let estimate;
  let preparationError: UiMessage = '';
  try {
    if (model && throughId)
      estimate = summaryGeneration(messages, throughId, {
        ...model,
        systemPrompt: '',
        maxOutputTokens: null,
        modelMetadata: model.metadata,
      }).estimate;
  } catch (error) {
    preparationError = errorMessage(error, uiMessage('chat', 'summaryInputFailed'));
  }
  const create = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (lock.current || busy || !model || !throughId || preparationError) return;
    lock.current = true;
    setSending(true);
    setError('');
    try {
      await submit({
        requestId: crypto.randomUUID(),
        summaryThrough: throughId,
        selection: { providerId: model.providerId, model: model.model },
      });
      submitted.current = true;
      close();
    } catch (error) {
      setError(errorMessage(error, uiMessage('chat', 'summarySubmitFailed')));
    } finally {
      lock.current = false;
      setSending(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      busy={sending}
      initialFocus={first}
      aria-labelledby={titleId}
      onCloseAutoFocus={(event) => {
        if (submitted.current) {
          event.preventDefault();
          focusComposer();
        }
      }}
    >
      <div className="w-full flex max-h-[85dvh] max-w-xl flex-col overflow-hidden p-0">
        <div className="flex shrink-0 items-center justify-between gap-3 p-5">
          <ModalTitle id={titleId} className="text-lg font-semibold">
            {target ? t(($) => $.regenerateSummary) : t(($) => $.compactHistory)}
          </ModalTitle>
          <div>
            <Button
              variant="ghost"
              size="icon"
              onClick={close}
              aria-label={t(($) => $.closeSummarySettings)}
              disabled={sending}
            >
              <X className="h-[1.125rem] w-[1.125rem]" />
            </Button>
          </div>
        </div>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void create(event)}>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5">
            <label className="block space-y-2 text-sm">
              <span>{t(($) => $.summaryModel)}</span>
              <NativeSelect
                ref={first}
                aria-label={t(($) => $.summaryModel)}
                className="w-full"
                value={model ? modelSelectionKey(model) : ''}
                disabled={sending || busy}
                onChange={(event) => setModelKey(event.currentTarget.value)}
              >
                {models.map((model) => (
                  <option key={modelSelectionKey(model)} value={modelSelectionKey(model)}>
                    {model.providerName} · {model.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="block space-y-2 text-sm">
              <span>{t(($) => $.summarizeThrough)}</span>
              <NativeSelect
                aria-label={t(($) => $.summaryBoundary)}
                className="w-full"
                value={throughId}
                disabled={sending || busy}
                onChange={(event) => setThroughId(event.currentTarget.value)}
              >
                {boundaries.map((message) => (
                  <option key={message.id} value={message.id}>
                    {t(($) => $.summaryBoundaryOption, {
                      position: path.findIndex(({ id }) => id === message.id) + 1,
                      text: messageText(message).replace(/\s+/g, ' ').slice(0, 45),
                    })}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <p className="text-sm">{t(($) => $.summaryCostHint)}</p>
            {estimate && (
              <p className="text-xs text-muted-foreground">
                {t(($) => $.summaryBudget, {
                  input: formatNumber(estimate.totalTokens),
                  output: formatNumber(estimate.outputReserve),
                })}
              </p>
            )}
            {(error || preparationError) && (
              <p role="alert" className="text-sm">
                {renderUiMessage(error || preparationError)}
              </p>
            )}
            {!boundaries.length && <p className="text-sm">{t(($) => $.noSummarizableAnswers)}</p>}
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-border p-5">
            <Button variant="secondary" type="button" disabled={sending} onClick={() => close()}>
              {t(($) => $.cancel)}
            </Button>
            <Button
              variant="secondary"
              type="submit"
              disabled={
                sending ||
                busy ||
                !navigator.onLine ||
                !model ||
                !throughId ||
                Boolean(preparationError)
              }
            >
              {sending && <Spinner />}
              {t(($) => $.generateSummary)}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
