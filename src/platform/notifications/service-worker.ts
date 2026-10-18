/// <reference lib="webworker" />
import * as v from 'valibot';
import {
  completionId,
  completionIsRecent,
  completionSchema,
  completionUrl,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_TTL,
  shouldNotify,
  type AnswerCompletion,
} from '../../../shared/notifications/protocol';
import { claimLocalNotification, readNotificationPreference } from './store';

declare const self: ServiceWorkerGlobalScope;
const windows = async () =>
  (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(
    (client) =>
      new URL(client.url).origin === self.location.origin &&
      !/^\/(api|auth|cdn-cgi)(\/|$)/.test(new URL(client.url).pathname),
  );
const options = (completion?: AnswerCompletion): NotificationOptions & { renotify: boolean } => ({
  body: completion ? '回答已完成' : '通知已启用',
  icon: '/icon-192.png',
  badge: '/icon-192.png',
  tag: completion ? completionId(completion) : 'everchat:test',
  renotify: false,
  data: { channel: NOTIFICATION_CHANNEL, ...(completion ? { completion } : {}) },
});
export function registerAnswerNotifications() {
  self.addEventListener('push', (event) => {
    event.waitUntil(
      (async () => {
        let input: unknown;
        try {
          input = event.data?.json();
        } catch {
          return;
        }
        if (
          !input ||
          typeof input !== 'object' ||
          !('channel' in input) ||
          input.channel !== NOTIFICATION_CHANNEL
        )
          return;
        const { channel: _, ...value } = input;
        const completion = v.safeParse(completionSchema, value);
        if (!completion.success) return;
        // Every accepted push displays a visible notification, including a foreground race
        // or a retry. The server suppresses foreground delivery before contacting the gateway.
        await self.registration.showNotification('EverChat', options(completion.output));
      })(),
    );
  });
  self.addEventListener('message', (event) => {
    const input = event.data;
    if (
      input?.channel !== NOTIFICATION_CHANNEL ||
      !event.source ||
      !('url' in event.source) ||
      new URL(event.source.url).origin !== self.location.origin
    )
      return;
    if (input.type !== 'local' && input.type !== 'test') return;
    event.waitUntil(
      (async () => {
        try {
          const preference = await readNotificationPreference();
          if (
            !preference?.enabled ||
            !preference.owner ||
            preference.mode === 'never' ||
            preference.revision !== input.revision
          )
            return;
          if (input.type === 'test') {
            await self.registration.showNotification('EverChat', options());
          } else {
            const result = v.safeParse(completionSchema, input.completion);
            if (!result.success || !completionIsRecent(result.output) || preference.push) return;
            const focused = (await windows()).some(
              (client) => client.focused && client.visibilityState === 'visible',
            );
            if (
              !shouldNotify(preference.mode, focused) ||
              !(await claimLocalNotification(
                completionId(result.output),
                result.output.completedAt + NOTIFICATION_TTL,
              ))
            )
              return;
            const latest = await readNotificationPreference();
            if (!latest?.enabled || latest.revision !== preference.revision) return;
            await self.registration.showNotification('EverChat', options(result.output));
          }
          event.ports[0]?.postMessage({ ok: true });
        } catch {
          event.ports[0]?.postMessage({ ok: false });
        }
      })(),
    );
  });
  self.addEventListener('notificationclick', (event) => {
    if (event.notification.data?.channel !== NOTIFICATION_CHANNEL) return;
    event.notification.close();
    event.waitUntil(
      (async () => {
        const result = v.safeParse(completionSchema, event.notification.data.completion);
        const clients = await windows(),
          target = clients.find((client) => client.focused) ?? clients[0];
        if (target) {
          if (result.success)
            target.postMessage({
              channel: NOTIFICATION_CHANNEL,
              type: 'navigate',
              completion: result.output,
            });
          await target.focus();
        } else await self.clients.openWindow(result.success ? completionUrl(result.output) : '/');
      })(),
    );
  });
}
