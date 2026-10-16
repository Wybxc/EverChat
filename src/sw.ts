/// <reference lib="webworker" />
import { clientsClaim, setCacheNameDetails } from 'workbox-core';
import { addPlugins, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import {
  APP_VERSION,
  PWA_CHANNEL,
  STATIC_CACHE_PREFIX,
  type Preparation,
  type ReloadCommand,
} from './platform/pwa/protocol';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[];
};
setCacheNameDetails({ prefix: 'everchat-static' });
addPlugins([
  {
    fetchDidSucceed: async ({ request, response }) => {
      if (
        response.redirected ||
        !response.ok ||
        new URL(response.url).origin !== self.location.origin
      )
        throw new Error('Application resource was redirected or unavailable');
      if (
        /\.(?:js|mjs|css|woff2)(?:$|\?)/.test(request.url) &&
        response.headers.get('Content-Type')?.includes('text/html')
      )
        throw new Error('Application resource returned an authentication page');
      return response;
    },
  },
]);
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api(?:\/|$)/, /^\/auth(?:\/|$)/, /^\/cdn-cgi(?:\/|$)/],
  }),
);
clientsClaim();

const appClients = async () =>
  (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(
    (client) => !/^\/(?:api|auth|cdn-cgi)(?:\/|$)/.test(new URL(client.url).pathname),
  );
const ask = (client: WindowClient, token: string) =>
  new Promise<Preparation>((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve({ ready: false, reason: '另一个页面尚未响应，请关闭后重试' });
    }, 8000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(
        event.data?.ready === true
          ? { ready: true }
          : { ready: false, reason: event.data?.reason || '另一个页面尚未准备好' },
      );
    };
    client.postMessage({ channel: PWA_CHANNEL, type: 'prepare', token }, [channel.port2]);
  });
let operation: Promise<Preparation> | undefined;
async function coordinate(command: ReloadCommand) {
  const token = crypto.randomUUID();
  const prepared = new Set<string>();
  const release = async () => {
    for (const client of await appClients())
      client.postMessage({ channel: PWA_CHANNEL, type: 'release', token });
  };
  try {
    // Include pages opened while the first group is saving. A continuously changing client set waits.
    for (let round = 0; round < 3; round++) {
      const clients = await appClients();
      const fresh = clients.filter((client) => !prepared.has(client.id));
      const replies = await Promise.all(fresh.map((client) => ask(client, token)));
      const blocked = replies.find((reply) => !reply.ready);
      if (blocked) {
        await release();
        return blocked;
      }
      fresh.forEach((client) => prepared.add(client.id));
      const current = await appClients();
      if (current.every((client) => prepared.has(client.id))) {
        if (command === 'repair') {
          for (const name of await caches.keys())
            if (name.startsWith(STATIC_CACHE_PREFIX)) await caches.delete(name);
          await self.registration.unregister();
          for (const client of current)
            client.postMessage({ channel: PWA_CHANNEL, type: 'reload', token });
        } else await self.skipWaiting();
        return { ready: true };
      }
    }
    await release();
    return { ready: false, reason: '页面状态正在变化，请稍后重试' };
  } catch {
    await release();
    return { ready: false, reason: '更新未能完成，请重试' };
  }
}
self.addEventListener('message', (event) => {
  if (event.data?.channel !== PWA_CHANNEL) return;
  if (event.data.type === 'version') {
    event.ports[0]?.postMessage({ version: APP_VERSION });
    return;
  }
  const command = event.data.type;
  if (command !== 'update' && command !== 'repair') return;
  event.waitUntil(
    (async () => {
      operation ??= coordinate(command).finally(() => {
        operation = undefined;
      });
      event.ports[0]?.postMessage(await operation);
    })(),
  );
});
