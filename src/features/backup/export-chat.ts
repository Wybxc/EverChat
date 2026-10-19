import { messageFiles, messageImages, messageText } from '../../../shared/conversation/content';
import type { Message } from '../../../shared/conversation/types';
import type { Locale } from '../../../shared/i18n/locale';
import { getLocaleSnapshot } from '../../platform/i18n/preference';
import { pageI18n } from '../../platform/i18n/react';
import './locales';
import { downloadFile, escapeHtml } from './download';

export function exportChatFile(
  selected: string,
  title: string,
  messages: Message[],
  format: 'md' | 'txt' | 'html',
  locale: Locale = getLocaleSnapshot().locale,
) {
  // Pin the language for the complete artifact; message content is never translated.
  const t = pageI18n.getFixedT(locale, 'backup');
  const role = (message: Message) =>
    message.summary
      ? t(($) => $.historySummary)
      : message.role === 'user'
        ? t(($) => $.you)
        : 'EverChat';
  const model = (message: Message) =>
    message.role === 'assistant' && (message.modelName || message.model)
      ? t(($) => $.model, { name: message.modelName || message.model! })
      : '';
  const statuses = {
    pending: 'pending',
    queued: 'queued',
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelledStatus',
  } as const;
  const status = (message: Message) =>
    message.status === 'completed'
      ? ''
      : t(($) => $.status, { status: t(($) => $[statuses[message.status]]) }) +
        (message.error ? ` (${message.error})` : '');
  const attachments = (message: Message) =>
    [
      ...messageImages(message).map((image) => t(($) => $.image, { name: image.name })),
      ...messageFiles(message).map((file) => t(($) => $.file, { name: file.name })),
    ].join('\n');
  const markdown = `# ${title}\n\n${messages
    .map((message) =>
      [
        `## ${role(message)}${message.revisionOf ? t(($) => $.newVersion) : ''}`,
        model(message),
        messageText(message),
        attachments(message),
        messageText(message, 'reasoning')
          ? `### ${t(($) => $.reasoning)}\n\n${messageText(message, 'reasoning')}`
          : '',
        status(message),
      ]
        .filter(Boolean)
        .join('\n\n'),
    )
    .join('\n\n')}`;
  if (format === 'md')
    downloadFile(`EverChat-${selected}.md`, markdown, 'text/markdown;charset=utf-8');
  else if (format === 'txt')
    downloadFile(
      `EverChat-${selected}.txt`,
      markdown.replace(/^#{1,6} /gm, ''),
      'text/plain;charset=utf-8',
    );
  else {
    const body = messages
      .map(
        (message) =>
          `<article><h2>${escapeHtml(role(message) + (message.revisionOf ? t(($) => $.newVersion) : ''))}</h2>${model(message) ? `<p class="meta">${escapeHtml(model(message))}</p>` : ''}<pre>${escapeHtml([messageText(message), attachments(message)].filter(Boolean).join('\n'))}</pre>${messageText(message, 'reasoning') ? `<details open><summary>${escapeHtml(t(($) => $.reasoning))}</summary><pre>${escapeHtml(messageText(message, 'reasoning'))}</pre></details>` : ''}${status(message) ? `<p class="error">${escapeHtml(status(message))}</p>` : ''}</article>`,
      )
      .join('');
    const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:54rem;margin:2rem auto;padding:0 1rem;color:#1f2937}article{border-top:1px solid #d1d5db;padding:1.5rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.meta{color:#6b7280;font-size:.875rem}.error{color:#b91c1c}summary{cursor:pointer}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
    downloadFile(`EverChat-${selected}.html`, html, 'text/html;charset=utf-8');
  }
}
