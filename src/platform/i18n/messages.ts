import { AppError, type ErrorIssue } from '../../../shared/errors/descriptor';
import type { Locale } from '../../../shared/i18n/locale';
import type { CustomTypeOptions } from 'i18next';
import { formatNumber } from './format';
import { pageI18n } from './react';

type Resources = CustomTypeOptions['resources'];
type Namespace = keyof Resources;
export type MessageValues = {
  readonly [key: string]: UiMessage | number | boolean | null | undefined;
};
export type UiMessage =
  | string
  | { readonly issue: ErrorIssue }
  | { readonly join: readonly UiMessage[]; readonly separator: string }
  | {
      readonly i18n: {
        readonly namespace: Namespace;
        readonly key: string;
        readonly values: MessageValues;
      };
    };
/** Store semantic UI state. Translate only when it is rendered, including after a language change. */
type MessageKey<K> = K extends `${infer Base}_one` | `${infer Base}_other` ? Base : K;
export function uiMessage<N extends Namespace>(
  namespace: N,
  key: MessageKey<Extract<keyof Resources[N], string>>,
  values: MessageValues = {},
): UiMessage {
  return { i18n: { namespace, key, values } };
}
export function renderUiMessage(message: UiMessage | null | undefined): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if ('issue' in message) return renderIssue(message.issue);
  if ('join' in message) return message.join.map(renderUiMessage).join(message.separator);
  const { namespace, key, values } = message.i18n;
  // The factory checks keys at construction; namespaces are selected at runtime here.
  const t = pageI18n.getFixedT(null, namespace);
  const resolved = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      typeof value === 'object' && value ? renderUiMessage(value) : value,
    ]),
  );
  return String(t(($) => ($ as unknown as Record<string, string>)[key], resolved));
}
export class UiError extends Error {
  constructor(readonly uiMessage: UiMessage) {
    super(renderUiMessage(uiMessage));
  }
}
export function renderIssue(issue: ErrorIssue, locale?: Locale): string {
  const t = pageI18n.getFixedT(locale ?? null, 'errors');
  const values = Object.fromEntries(
    Object.entries(issue.params ?? {}).map(([name, value]) => [
      name,
      formatNumber(value, { maximumFractionDigits: 20 }, locale),
    ]),
  );
  return String(t(($) => ($ as unknown as Record<string, string>)[issue.code], values));
}
export function issueMessage(issue: ErrorIssue): UiMessage {
  return { issue };
}
export function errorMessage(
  error: unknown,
  fallback: UiMessage = uiMessage('errors', 'REQUEST_FAILED'),
): UiMessage {
  return error instanceof UiError
    ? error.uiMessage
    : error instanceof AppError
      ? issueMessage(error.issue)
      : fallback;
}
