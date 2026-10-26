import type { PublicShare } from '../../shared/sharing/types';
import type { Locale } from '../../shared/i18n/locale';
import { renderShareChrome } from './render';

export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

export function shareDocument(
  template: string,
  locale: Locale,
  share: PublicShare,
  parts: Generator<string>,
) {
  const chrome = renderShareChrome(share, locale);
  const [before, after] = chrome.split('<!--EVERCHAT_MESSAGES-->');
  if (after === undefined) throw new Error('Missing share message slot');
  const [head, tail] = template.split('<!--EVERCHAT_SHARE-->');
  if (tail === undefined) throw new Error('Missing share document slot');
  const prefix = head
    .replace('lang="en"', `lang="${locale}"`)
    .replace('__EVERCHAT_SHARE_TITLE__', escapeHtml(`${share.title} · EverChat`))
    .replace('__EVERCHAT_SHARE_ID__', share.id)
    .replace('__EVERCHAT_SHARE_EXPIRY__', String(share.expiresAt ?? ''));
  const content = (function* () {
    try {
      yield prefix + before;
      yield* parts;
      yield after + tail;
    } finally {
      parts.return(undefined);
    }
  })();
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          const next = content.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (error) {
          content.return(undefined);
          controller.error(error);
        }
      },
      cancel() {
        content.return(undefined);
      },
    }),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
