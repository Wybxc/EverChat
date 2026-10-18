import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';
import { NOTIFICATION_CHANNEL, type NotificationDevice } from '../../shared/notifications/protocol';
import { openSpaceSettings } from '../support/browser/ui';

test.use({ channel: 'chromium' });
// Use Chromium's full new-headless browser: headless-shell cannot grant notifications.

async function fixture(context: BrowserContext, page: Page) {
  await context.grantPermissions(['notifications'], { origin: 'http://127.0.0.1:5175' });
  const sockets = new Set<WebSocketRoute>();
  let device: NotificationDevice | null = null;
  await context.route('**/api/notifications/config', (route) =>
    route.fulfill({ json: { publicKey: null } }),
  );
  await context.route('**/api/notifications/device', (route) => {
    device = route.request().postDataJSON() as NotificationDevice;
    return route.fulfill({ json: device });
  });
  await context.routeWebSocket('**/api/notifications/sync?*', (ws) => {
    sockets.add(ws);
    ws.onClose(() => sockets.delete(ws));
    ws.send(JSON.stringify({ type: 'ready' }));
    ws.onMessage((data) => {
      if (data === 'ping') ws.send('pong');
    });
  });
  await page.addInitScript(() => {
    const request = Notification.requestPermission.bind(Notification);
    (window as unknown as { permissionRequests: number }).permissionRequests = 0;
    Notification.requestPermission = () => {
      (window as unknown as { permissionRequests: number }).permissionRequests++;
      return request();
    };
  });
  await page.goto('/');
  expect(
    await page.evaluate(() => ({
      permission: Notification.permission,
      secure: isSecureContext,
      origin: location.origin,
    })),
  ).toEqual({ permission: 'granted', secure: true, origin: 'http://127.0.0.1:5175' });
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await navigator.serviceWorker.getRegistration('/'))?.active?.state,
      ),
    )
    .toBe('activated');
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
  await openSpaceSettings(page);
  const panel = page.getByRole('region', { name: '回答通知', exact: true });
  return {
    panel,
    sockets,
    get device() {
      return device;
    },
    emit: (
      completion: { conversationId: string; messageId: string; completedAt: number },
      revision = device!.revision,
    ) => {
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'local', completion, revision }));
    },
  };
}
type Probe = typeof globalThis & {
  registration: ServiceWorkerRegistration;
  notificationCalls: number;
};
test('production SW notifications require explicit enable, keep preferences on reload and coordinate duplicate local delivery across windows', async ({
  page,
  context,
}) => {
  const f = await fixture(context, page);
  expect(
    await page.evaluate(
      () => (window as unknown as { permissionRequests: number }).permissionRequests,
    ),
  ).toBe(0);
  await expect(f.panel.getByLabel('回答完成通知')).toHaveValue('unfocused');
  await f.panel.getByLabel('回答完成通知').selectOption('always');
  await page.reload();
  await openSpaceSettings(page);
  await expect(f.panel.getByLabel('回答完成通知')).toHaveValue('always');
  await expect(f.panel.getByRole('status')).toHaveText('未启用');
  await f.panel.getByRole('button', { name: '启用系统通知', exact: true }).click();
  await expect(f.panel.getByRole('status')).toHaveText('页面通知可用');
  expect(
    await page.evaluate(
      () => (window as unknown as { permissionRequests: number }).permissionRequests,
    ),
  ).toBe(1);
  await expect.poll(() => f.sockets.size).toBe(1);
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => {
    const scope = globalThis as Probe,
      show = scope.registration.showNotification.bind(scope.registration);
    scope.notificationCalls = 0;
    scope.registration.showNotification = (title, options) => {
      scope.notificationCalls++;
      return show(title, options);
    };
  });
  const second = await context.newPage();
  await second.goto('/');
  await expect.poll(() => f.sockets.size).toBe(2);
  const completion = {
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    completedAt: Date.now(),
  };
  f.emit(completion);
  f.emit(completion);
  await expect.poll(() => worker.evaluate(() => (globalThis as Probe).notificationCalls)).toBe(1);
  const notifications = await worker.evaluate(async () =>
    (await (globalThis as Probe).registration.getNotifications()).map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
    })),
  );
  expect(notifications).toEqual([
    {
      title: 'EverChat',
      body: '回答已完成',
      tag: `${completion.conversationId}:${completion.messageId}:completed`,
    },
  ]);
  await f.panel.getByLabel('回答完成通知').selectOption('unfocused');
  await expect.poll(() => f.device?.mode).toBe('unfocused');
  await second.bringToFront();
  f.emit({ ...completion, messageId: crypto.randomUUID(), completedAt: Date.now() });
  await page.waitForTimeout(500);
  expect(await worker.evaluate(() => (globalThis as Probe).notificationCalls)).toBe(1);
  await f.panel.getByLabel('回答完成通知').selectOption('never');
  await expect.poll(() => f.device?.mode).toBe('never');
  await expect(f.panel.getByRole('status')).toHaveText('已停用');
  expect(f.device?.subscription).toBeNull();
  await second.close();
});
test('the explicit notification test uses the active root SW and never claims remote push readiness', async ({
  page,
  context,
}) => {
  const f = await fixture(context, page);
  await f.panel.getByRole('button', { name: '启用系统通知', exact: true }).click();
  await expect(f.panel.getByRole('status')).toHaveText('页面通知可用');
  await expect(f.panel).not.toContainText('后台推送已就绪');
  await f.panel.getByRole('button', { name: '发送测试通知', exact: true }).click();
  await expect
    .poll(() =>
      context
        .serviceWorkers()[0]
        .evaluate(async () =>
          (await (globalThis as Probe).registration.getNotifications()).map((n) => n.body),
        ),
    )
    .toEqual(['通知已启用']);
});

test('a mode change while an older save is in flight is synchronized without waiting for focus', async ({
  page,
  context,
}) => {
  const f = await fixture(context, page);
  await f.panel.getByRole('button', { name: '启用系统通知', exact: true }).click();
  await expect(f.panel.getByRole('status')).toHaveText('页面通知可用');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending = false;
  await context.route('**/api/notifications/device', async (route) => {
    const data = route.request().postDataJSON() as NotificationDevice;
    if (data.mode !== 'always') return route.fallback();
    pending = true;
    await held;
    await route.fulfill({ json: data });
  });
  await f.panel.getByLabel('回答完成通知').selectOption('always');
  await expect.poll(() => pending).toBe(true);
  await f.panel.getByLabel('回答完成通知').selectOption('never');
  await expect(f.panel.getByRole('status')).toHaveText('停用待同步');
  release();
  await expect.poll(() => f.device?.mode).toBe('never');
  await expect(f.panel.getByRole('status')).toHaveText('已停用');
});

test('browser-delivered push always displays, including foreground and duplicate delivery with the same stable tag', async ({
  page,
  context,
}) => {
  const f = await fixture(context, page);
  await f.panel.getByRole('button', { name: '启用系统通知', exact: true }).click();
  await expect(f.panel.getByRole('status')).toHaveText('页面通知可用');
  await page.bringToFront();
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => {
    const scope = globalThis as Probe,
      show = scope.registration.showNotification.bind(scope.registration);
    scope.notificationCalls = 0;
    scope.registration.showNotification = (title, options) => {
      scope.notificationCalls++;
      return show(title, options);
    };
  });
  const cdp = await context.newCDPSession(page);
  let registrationId = '';
  cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
    registrationId =
      registrations.find(
        (registration) =>
          registration.scopeURL === 'http://127.0.0.1:5175/' && !registration.isDeleted,
      )?.registrationId ?? registrationId;
  });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => registrationId).not.toBe('');
  const completion = {
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    completedAt: Date.now(),
  };
  // CDP exercises the real SW push event. It bypasses gateway/encryption and is not a real Web Push acceptance test.
  const deliver = () =>
    cdp.send('ServiceWorker.deliverPushMessage', {
      origin: 'http://127.0.0.1:5175',
      registrationId,
      data: JSON.stringify({ channel: NOTIFICATION_CHANNEL, ...completion }),
    });
  await deliver();
  await expect.poll(() => worker.evaluate(() => (globalThis as Probe).notificationCalls)).toBe(1);
  await deliver();
  await expect.poll(() => worker.evaluate(() => (globalThis as Probe).notificationCalls)).toBe(2);
  const notifications = await worker.evaluate(async () =>
    (await (globalThis as Probe).registration.getNotifications()).map((notification) => ({
      body: notification.body,
      tag: notification.tag,
      renotify: (notification as Notification & { renotify: boolean }).renotify,
    })),
  );
  expect(notifications).toEqual([
    {
      body: '回答已完成',
      tag: `${completion.conversationId}:${completion.messageId}:completed`,
      renotify: false,
    },
  ]);
  await cdp.detach();
});
