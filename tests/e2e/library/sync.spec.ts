import { expect, test, type Page } from '@playwright/test';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function fixture(page: Page) {
  await page.request.post('/__dev/access/login', { headers });
  const id = crypto.randomUUID(),
    title = `Sync ${id.slice(0, 8)}`;
  expect(
    (await page.request.post('/api/conversations', { headers, data: { id, title } })).status(),
  ).toBe(201);
  const requests = { library: 0, snapshots: 0, settings: 0 };
  const ready = { library: 0, conversation: 0 };
  const sent: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/conversations' && request.method() === 'GET') requests.library++;
    if (url.pathname === `/api/conversations/${id}` && request.method() === 'GET')
      requests.snapshots++;
    if (url.pathname === '/api/notifications/device' && request.method() === 'PUT')
      requests.settings++;
  });
  page.on('websocket', (ws) => {
    const library = ws.url().includes('/notifications/sync');
    if (!library && !ws.url().includes(`/conversations/${id}/sync`)) return;
    ws.on('framereceived', ({ payload }) => {
      if (String(payload) === 'pong') return;
      const value = JSON.parse(String(payload));
      if (value.type === 'ready') ready[library ? 'library' : 'conversation']++;
    });
    ws.on('framesent', ({ payload }) => sent.push(String(payload)));
  });
  return {
    id,
    title,
    requests,
    ready,
    sent,
    row: page.locator(`[data-conversation-row="${id}"]`),
    open: async () => {
      await page.goto(`/c/${id}`);
      await expect.poll(() => ready.library).toBeGreaterThan(0);
      await expect.poll(() => ready.conversation).toBeGreaterThan(0);
    },
    close: async () => {
      await page.request.delete(`/api/conversations/${id}`, { headers });
    },
  };
}

test('idle pages use automatic pings without full-list polling or database sync checks; cached reload skips history', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await page.clock.install();
    await f.open();
    await expect(f.row).toContainText(f.title);
    const before = { ...f.requests };
    await page.clock.fastForward(31_000);
    await expect.poll(() => f.sent.includes('ping')).toBe(true);
    await page.waitForTimeout(300);
    expect(f.requests).toEqual(before);
    expect(f.sent.some((value) => value === 'session-check' || value.includes('sync-check'))).toBe(
      false,
    );
    await page.reload();
    await expect.poll(() => f.ready.conversation).toBeGreaterThan(1);
    await expect.poll(() => f.ready.library).toBeGreaterThan(1);
    expect(f.requests.library).toBe(before.library);
    expect(f.requests.snapshots).toBe(before.snapshots);
  } finally {
    await f.close();
  }
});

test('authenticated lease renewal replaces both sockets without downloading unchanged history or saving settings', async ({
  page,
}) => {
  const f = await fixture(page);
  const shortened = new Set<string>();
  await page.routeWebSocket('**/api/**/sync?*', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((data) => {
      if (String(data) === 'pong') {
        ws.send(data);
        return;
      }
      const packet = JSON.parse(String(data));
      const path = new URL(ws.url()).pathname;
      if (packet.type === 'ready' && !shortened.has(path)) {
        shortened.add(path);
        packet.revalidateAt = Date.now() + 700;
      }
      ws.send(JSON.stringify(packet));
    });
  });
  try {
    await f.open();
    const before = { ...f.requests };
    await expect.poll(() => f.ready.library).toBeGreaterThan(1);
    await expect.poll(() => f.ready.conversation).toBeGreaterThan(1);
    expect(f.requests).toEqual(before);
  } finally {
    await f.close();
  }
});

test('a change arriving during the first snapshot is fetched and a hidden page catches up from its watermark', async ({
  page,
}) => {
  const f = await fixture(page);
  let delayed = false;
  await page.route('**/api/conversations?*', async (route) => {
    const response = await route.fetch();
    if (!delayed) {
      delayed = true;
      expect(
        (
          await page.request.patch(`/api/conversations/${f.id}`, {
            headers,
            data: { title: 'Changed during snapshot' },
          })
        ).ok(),
      ).toBe(true);
    }
    await route.fulfill({ response });
  });
  try {
    await f.open();
    await expect(f.row).toContainText('Changed during snapshot');
    expect(f.requests.library).toBeLessThanOrEqual(3);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(
      (
        await page.request.patch(`/api/conversations/${f.id}`, {
          headers,
          data: { title: 'Changed while hidden' },
        })
      ).ok(),
    ).toBe(true);
    const before = f.requests.library;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(f.row).toContainText('Changed while hidden');
    expect(f.requests.library).toBe(before + 1);
  } finally {
    await f.close();
  }
});

test('connections that repeatedly fail just after ready back off without refreshing unchanged lists', async ({
  page,
}) => {
  const f = await fixture(page);
  let attempts = 0;
  await page.routeWebSocket('**/api/notifications/sync?*', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((data) => {
      ws.send(data);
      if (String(data) !== 'pong' && JSON.parse(String(data)).type === 'ready') {
        attempts++;
        ws.close({ code: 1011, reason: 'Synthetic repeated failure' });
        server.close();
      }
    });
  });
  try {
    await page.clock.install();
    await f.open();
    await expect(f.row).toContainText(f.title);
    const before = f.requests.library;
    // Advance in small steps so each browser retry can complete its real upgrade.
    for (let step = 0; step < 16; step++) {
      await page.clock.fastForward(2000);
      await page.waitForTimeout(40);
    }
    expect(attempts).toBeGreaterThan(2);
    expect(attempts).toBeLessThanOrEqual(7);
    expect(f.requests.library).toBe(before);
  } finally {
    await f.close();
  }
});
