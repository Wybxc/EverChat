/// <reference lib="webworker" />
import { registerAnswerNotifications } from './platform/notifications/service-worker';
import { isSharePage } from '../shared/sharing/types';
import { SHARE_CSP } from '../shared/sharing/security';
import { cacheNames, clientsClaim, setCacheNameDetails } from 'workbox-core';
import {
  addPlugins,
  createHandlerBoundToURL,
  getCacheKeyForURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { CacheExpiration, ExpirationPlugin } from 'workbox-expiration';
import { isBundledAsset } from './platform/pwa/assets';
import {
  APP_VERSION,
  PWA_CHANNEL,
  STATIC_CACHE_PREFIX,
  type Preparation,
} from './platform/pwa/protocol';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[];
};
registerAnswerNotifications();
const repairGeneration = new URL(self.location.href).searchParams.get('repair');
setCacheNameDetails({
  prefix: 'everchat-static',
  ...(repairGeneration ? { suffix: repairGeneration } : {}),
});
const validateResource = {
  fetchDidSucceed: async ({ request, response }: { request: Request; response: Response }) => {
    if (
      response.redirected ||
      !response.ok ||
      new URL(response.url).origin !== self.location.origin
    )
      throw new Error('Application resource was redirected or unavailable');
    const path = new URL(request.url).pathname;
    if (path.startsWith('/assets/')) {
      const type = response.headers.get('Content-Type') ?? '';
      if (
        type.includes('text/html') ||
        (/\.(?:js|mjs)$/.test(path) && !/(?:java|ecma)script/.test(type)) ||
        (path.endsWith('.css') && !type.includes('text/css'))
      )
        throw new Error('Application resource returned an invalid content type');
    }
    return response;
  },
};
addPlugins([validateResource]);
precacheAndRoute(self.__WB_MANIFEST);
// Only immutable bundled assets; API responses, attachments and authentication never enter this cache.
const moduleCache = `${cacheNames.runtime}-modules`;
const modules = new CacheFirst({
  cacheName: moduleCache,
  plugins: [validateResource, new ExpirationPlugin({ maxEntries: 192, purgeOnQuotaError: true })],
});
registerRoute(({ url }) => isBundledAsset(url, self.location.origin), modules);
const navigation = createHandlerBoundToURL('/index.html');
// Cache only the shell visited under this build; shared conversation data stays network-only.
const shareDocumentCache = `${cacheNames.runtime}-share-${encodeURIComponent(APP_VERSION)}`;
const shareNavigation = new NetworkFirst({
  cacheName: shareDocumentCache,
  plugins: [
    validateResource,
    {
      cacheWillUpdate: async ({ response }) =>
        response.headers.get('Content-Type')?.includes('text/html') &&
        (await response.clone().text()).includes(
          `name="everchat-build" content="${encodeURIComponent(APP_VERSION)}"`,
        )
          ? response
          : null,
    },
  ],
});
registerRoute(
  new NavigationRoute(
    async (options) => {
      const publicPage = isSharePage(new URL(options.request.url).pathname);
      if (!publicPage) return navigation(options);
      const response = await shareNavigation.handle({
        request: new Request(new URL('/share.html', self.location.origin), {
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        }),
        event: options.event,
      });
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', SHARE_CSP);
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
      return new Response(response.body, { status: response.status, headers });
    },
    {
      denylist: [
        /^\/api(?:\/|$)/,
        /^\/auth(?:\/|$)/,
        /^\/public(?:\/|$)/,
        /^\/mcp(?:\/|$)/,
        /^\/cdn-cgi(?:\/|$)/,
      ],
    },
  ),
);
clientsClaim();
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (
          name.startsWith(STATIC_CACHE_PREFIX) &&
          name !== cacheNames.precache &&
          name !== moduleCache &&
          name !== shareDocumentCache
        ) {
          await caches.delete(name);
          if (name.endsWith('-modules'))
            await new CacheExpiration(name, { maxEntries: 192 }).delete();
        }
    })(),
  );
});

const appClients = async () =>
  (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((client) => {
    const path = new URL(client.url).pathname;
    return !isSharePage(path) && !/^\/(?:public|api|auth|cdn-cgi)(?:\/|$)/.test(path);
  });
const ask = (client: WindowClient, token: string) =>
  new Promise<Preparation>((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve({ ready: false, reason: 'otherPageTimeout' });
    }, 8000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(
        event.data?.ready === true
          ? { ready: true }
          : { ready: false, reason: event.data?.reason || 'otherPageNotReady' },
      );
    };
    client.postMessage({ channel: PWA_CHANNEL, type: 'prepare', token }, [channel.port2]);
  });
let operation: Promise<Preparation> | undefined;
async function coordinate(): Promise<Preparation> {
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
        // Repair also comes from a fully installed waiting worker with a fresh cache generation.
        // Do not unregister: WebKit can discard unrelated CacheStorage entries when we do.
        await self.skipWaiting();
        return { ready: true };
      }
    }
    await release();
    return { ready: false, reason: 'pageChanging' };
  } catch {
    await release();
    return { ready: false, reason: 'workerUpdateFailed' };
  }
}
self.addEventListener('message', (event) => {
  if (event.data?.channel !== PWA_CHANNEL) return;
  if (event.data.type === 'cache-used' && Array.isArray(event.data.urls)) {
    const candidates: unknown[] = event.data.urls;
    const urls = [...new Set(candidates.filter((url): url is string => typeof url === 'string'))]
      .slice(0, 192)
      .filter((url) => {
        try {
          return isBundledAsset(new URL(url), self.location.origin) && !getCacheKeyForURL(url);
        } catch {
          return false;
        }
      });
    // Cover resources used by the first page before this worker took control. This is
    // best effort and never extends installation or downloads modules the page hasn't used.
    event.waitUntil(
      Promise.all(
        Array.from({ length: Math.min(4, urls.length) }, async () => {
          for (let url = urls.pop(); url; url = urls.pop())
            await Promise.allSettled(
              modules.handleAll({
                request: new Request(url, { credentials: 'same-origin' }),
                event,
              }),
            );
        }),
      ),
    );
    return;
  }
  if (event.data.type === 'version') {
    event.ports[0]?.postMessage({ version: APP_VERSION });
    return;
  }
  const command = event.data.type;
  if (command !== 'update' && command !== 'repair') return;
  event.waitUntil(
    (async () => {
      operation ??= coordinate().finally(() => {
        operation = undefined;
      });
      event.ports[0]?.postMessage(await operation);
    })(),
  );
});
