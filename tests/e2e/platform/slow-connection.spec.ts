import { expect, test, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import { openSpaceSettings } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };
const composer = (page: Page) => page.getByRole('textbox', { name: '消息', exact: true });

async function hold(page: Page, pattern: string | RegExp, failure = false) {
  let release!: () => void;
  let started!: () => void;
  let hits = 0;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const handler = async (route: import('@playwright/test').Route) => {
    hits++;
    const response = await route.fetch();
    started();
    await waiting;
    try {
      if (failure) await route.fulfill({ status: 503, json: { error: '测试：读取暂时失败' } });
      else await route.fulfill({ response });
    } catch {
      /* Navigation or session invalidation can cancel the waiting request. */
    }
  };
  await page.route(pattern, handler);
  return { entered, release, hits: () => hits, remove: () => page.unroute(pattern, handler) };
}

async function fixture(page: Page) {
  expect((await page.request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const original = (await page.request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const providerId = crypto.randomUUID();
  expect(
    (
      await page.request.put('/api/settings/providers', {
        headers,
        data: {
          ...original,
          activeProviderId: providerId,
          activeModel: 'test-model',
          providers: [
            {
              id: providerId,
              name: '慢连接测试',
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [{ id: 'test-model', name: '测试模型', enabled: true }],
            },
          ],
        },
      })
    ).ok(),
  ).toBe(true);
  const ids: string[] = [];
  const create = async (title: string) => {
    const id = crypto.randomUUID();
    ids.push(id);
    expect(
      (await page.request.post('/api/conversations', { headers, data: { id, title } })).ok(),
    ).toBe(true);
    expect(
      (
        await page.request.post(`/api/__test/conversations/${id}/search-history`, {
          headers,
          data: {},
        })
      ).ok(),
    ).toBe(true);
    return id;
  };
  return {
    create,
    cleanup: async () => {
      for (const id of ids) await page.request.delete(`/api/conversations/${id}`, { headers });
      await page.request.put('/api/settings/providers', { headers, data: original });
    },
  };
}

test('pending identity keeps a private-free frame, usable settings and one shared identity check', async ({
  page,
}, info) => {
  const data = await fixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await composer(page).fill('身份确认前不可见的草稿');
  const request = await hold(page, '**/api/session');
  try {
    await page.reload();
    await request.entered;
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await expect(page.getByRole('button', { name: '开启新对话' })).toBeVisible();
    await expect(composer(page)).toHaveCount(0);
    await expect(page.getByText('身份确认前不可见的草稿')).toHaveCount(0);
    const before = request.hits();
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    await page.getByRole('button', { name: '空间设置' }).click();
    await expect(page.getByRole('tablist', { name: '设置分类' })).toBeVisible();
    for (const label of ['浅色', '深色']) {
      await page.getByRole('radio', { name: label, exact: true }).focus();
      await page.getByRole('radio', { name: label, exact: true }).press('Space');
      await page.screenshot({
        path: info.outputPath(`pending-identity-${label}.png`),
        animations: 'disabled',
      });
    }
    expect(request.hits()).toBe(before);
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.screenshot({
      path: info.outputPath('pending-identity-frame-dark.png'),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '空间设置' }).click();
    await page.getByRole('tab', { name: '联网', exact: true }).click();
    await expect(page.getByText('身份确认后可用')).toBeVisible();
    request.release();
    await expect(page.getByRole('combobox', { name: '联网服务', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: '联网', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('button', { name: '关闭设置' }).click();
    await expect(composer(page)).toHaveValue('身份确认前不可见的草稿');
  } finally {
    request.release();
    await data.cleanup();
  }
});

test('slow provider settings do not block tabs, local controls or independent service queries', async ({
  page,
}, info) => {
  const data = await fixture(page);
  const request = await hold(page, '**/api/settings/providers', true);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await openSpaceSettings(page);
    expect(request.hits()).toBe(0);
    await page.getByRole('tab', { name: '供应商', exact: true }).click();
    await request.entered;
    await expect(page.getByRole('tab', { name: '供应商', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('status', { name: '正在读取设置' })).toBeVisible();
    await expect(page.getByRole('button', { name: '关闭设置' })).toBeVisible();
    await page.screenshot({
      path: info.outputPath('pending-providers-mobile.png'),
      animations: 'disabled',
    });
    await page.getByRole('tab', { name: '联网', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '联网服务', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '预设', exact: true }).click();
    await expect(page.getByRole('button', { name: '添加预设', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '通用', exact: true }).click();
    await page.getByRole('radio', { name: '深色', exact: true }).focus();
    await page.getByRole('radio', { name: '深色', exact: true }).press('Space');
    request.release();
    await page.getByRole('tab', { name: '供应商', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('服务暂时不可用');
    await request.remove();
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.getByLabel('名称', { exact: true })).toHaveValue('慢连接测试');
    await page
      .getByTestId('settings-scroll')
      .evaluate((node) => node.scrollTo(0, node.scrollHeight));
    await expect(page.getByRole('button', { name: '关闭设置' })).toBeInViewport();
    await page.getByRole('button', { name: '关闭设置' }).click();
    await expect(composer(page)).toBeVisible();
  } finally {
    request.release();
    await data.cleanup();
  }
});

test('slow saves preserve edits and a single store when switching tabs and reopening settings', async ({
  page,
}) => {
  const data = await fixture(page);
  try {
    await page.goto('/');
    await openSpaceSettings(page);
    await page.getByRole('tab', { name: '供应商', exact: true }).click();
    const name = page.getByLabel('名称', { exact: true });
    await expect(name).toHaveValue('慢连接测试');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    await page.route('**/api/settings/providers', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      writes++;
      await waiting;
      await route.continue();
    });
    try {
      await name.fill('第一次修改');
      await expect.poll(() => writes).toBe(1);
      await name.fill('等待期间继续修改');
      await page.getByRole('tab', { name: '对话', exact: true }).click();
      await page.getByRole('tab', { name: '供应商', exact: true }).click();
      await expect(name).toHaveValue('等待期间继续修改');
      await page.getByRole('button', { name: '关闭设置' }).click();
      await openSpaceSettings(page);
      await expect(name).toHaveValue('等待期间继续修改');
      release();
      await expect(page.getByTestId('settings-save-status')).toHaveText('已保存');
      expect(writes).toBe(2);
      const saved = (await page.request
        .get('/api/settings/providers')
        .then((r) => r.json())) as ProviderSettings;
      expect(saved.providers[0].name).toBe('等待期间继续修改');
    } finally {
      release();
    }
  } finally {
    await data.cleanup();
  }
});

test('initial library and preset reads are not presented as empty results', async ({ page }) => {
  const data = await fixture(page);
  await data.create('读取后才出现的对话');
  const library = await hold(page, /\/api\/conversations\?/);
  const presets = await hold(page, '**/api/settings/presets');
  try {
    await page.goto('/');
    await library.entered;
    await expect(page.getByRole('status', { name: '正在读取对话列表' })).toBeVisible();
    await expect(page.getByText('暂无对话', { exact: true })).toHaveCount(0);
    await openSpaceSettings(page);
    await page.getByRole('tab', { name: '预设', exact: true }).click();
    await presets.entered;
    await expect(page.getByRole('combobox', { name: '编辑预设' })).toContainText('读取中');
    await expect(page.getByRole('button', { name: '添加预设', exact: true })).toBeDisabled();
    presets.release();
    await expect(page.getByRole('button', { name: '添加预设', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '关闭设置' }).click();
    library.release();
    await expect(page.getByRole('link', { name: '读取后才出现的对话', exact: true })).toBeVisible();
  } finally {
    library.release();
    presets.release();
    await data.cleanup();
  }
});

test('a cached empty library keeps its empty state while refreshing', async ({ page }) => {
  const data = await fixture(page);
  const pattern = /\/api\/conversations\?/;
  await page.route(pattern, (route) =>
    route.fulfill({
      json: {
        conversations: [],
        activity: {},
        deletions: [],
        deletionCursor: 0,
        hasMoreDeletions: false,
      },
    }),
  );
  try {
    await page.goto('/');
    await expect(page.getByText('暂无对话', { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('everchat:library')))
      .toBe('[]');
    await page.unroute(pattern);
    const request = await hold(page, pattern);
    try {
      await page.reload();
      await request.entered;
      await expect(page.getByText('暂无对话', { exact: true })).toBeVisible();
      await expect(page.getByRole('status', { name: '正在读取对话列表' })).toHaveCount(0);
    } finally {
      request.release();
    }
  } finally {
    await data.cleanup();
  }
});

test('uncached history keeps an editable draft and does not steal focus when it arrives', async ({
  page,
}, info) => {
  const data = await fixture(page);
  const id = await data.create('慢速历史');
  const request = await hold(page, `**/api/conversations/${id}?after=*`);
  try {
    await page.goto(`/c/${id}`);
    await request.entered;
    await expect(page.getByRole('status', { name: '正在读取对话', exact: true })).toBeVisible();
    await composer(page).fill('读取历史时继续写');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    const model = page.getByRole('combobox', { name: '聊天模型', exact: true });
    await model.focus();
    const header = await page.getByRole('banner').boundingBox();
    await page.screenshot({ path: info.outputPath('pending-history.png') });
    request.release();
    await expect(page.getByTestId('assistant-message').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await expect(composer(page)).toHaveValue('读取历史时继续写');
    await expect(model).toBeFocused();
    expect(await page.getByRole('banner').boundingBox()).toEqual(header);
    await info.attach('startup-resources', {
      body: JSON.stringify(
        await page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .filter((r) => r.name.includes('/api/'))
            .map((r) => ({ url: new URL(r.name).pathname, duration: Math.round(r.duration) })),
        ),
        null,
        2,
      ),
      contentType: 'application/json',
    });
  } finally {
    request.release();
    await data.cleanup();
  }
});

test('cached history remains readable through a failed refresh and a late response cannot replace another conversation', async ({
  page,
}) => {
  const data = await fixture(page);
  const a = await data.create('历史 A');
  const b = await data.create('历史 B');
  try {
    await page.goto(`/c/${a}`);
    await expect(page.getByTestId('assistant-message').first()).toBeVisible();
    await composer(page).fill('A 的草稿');
    await expect
      .poll(() =>
        page.evaluate((id) => Boolean(localStorage.getItem(`everchat:snapshot:parts-v1:${id}`)), a),
      )
      .toBe(true);
    const request = await hold(page, `**/api/conversations/${a}?after=*`, true);
    try {
      await page.reload();
      await request.entered;
      await expect(page.getByTestId('assistant-message').first()).toBeVisible();
      await expect(page.getByRole('status', { name: '正在读取对话', exact: true })).toHaveCount(0);
      await expect(composer(page)).toHaveValue('A 的草稿');
      await expect(page.getByRole('button', { name: '复制消息' }).first()).toBeEnabled();
      request.release();
      await expect(page.getByRole('banner')).toContainText('连接中');
      await expect(page.getByRole('alert')).toContainText('服务暂时不可用');
      await expect(page.getByTestId('assistant-message').first()).toBeVisible();
      await request.remove();
    } finally {
      request.release();
    }
    const late = await hold(page, `**/api/conversations/${a}?after=*`);
    try {
      await page.reload();
      await late.entered;
      await page.getByRole('link', { name: '历史 B', exact: true }).click();
      await expect(page.getByTestId('conversation-title')).toHaveText('历史 B');
      await composer(page).fill('B 的草稿');
      late.release();
      await expect(page).toHaveURL(new RegExp(`/c/${b}`));
      await expect(composer(page)).toHaveValue('B 的草稿');
      await expect(page.getByTestId('conversation-title')).toHaveText('历史 B');
    } finally {
      late.release();
    }
  } finally {
    await data.cleanup();
  }
});

test('a changed verified identity clears old drafts and never delivers the old identity outbox', async ({
  page,
}) => {
  const data = await fixture(page);
  const id = await data.create('旧身份缓存');
  try {
    await page.goto(`/c/${id}`);
    await composer(page).fill('旧身份私密草稿');
    const session = await page.request.get('/api/session').then((r) => r.json());
    await page.evaluate(
      ({ id, identity }) => {
        localStorage.setItem(
          'everchat:pending',
          JSON.stringify([
            {
              owner: JSON.stringify([identity.issuer, identity.sub]),
              conversation: {
                id,
                title: '旧身份缓存',
                createdAt: 1,
                updatedAt: 1,
                pinned: false,
              },
              input: { requestId: crypto.randomUUID(), content: '不能发送的旧队列' },
            },
          ]),
        );
      },
      { id, identity: session.identity },
    );
    let deliveries = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/messages$/.test(new URL(r.url()).pathname)) deliveries++;
    });
    await page.route('**/api/session', (route) =>
      route.fulfill({
        json: {
          ...session,
          identity: { ...session.identity, sub: 'another-verified-test-identity' },
        },
      }),
    );
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await expect(composer(page)).toHaveValue('');
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending') ?? '[]')))
      .toEqual([]);
    expect(deliveries).toBe(0);
  } finally {
    await data.cleanup();
  }
});

test('a late identity refresh cannot restore private UI after a cross-tab sign-out', async ({
  page,
}) => {
  const data = await fixture(page);
  try {
    await page.goto('/');
    await composer(page).fill('退出后不能恢复');
    const request = await hold(page, '**/api/session');
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await request.entered;
      await expect(composer(page)).toHaveValue('退出后不能恢复');
      await page.evaluate(() => {
        const channel = new BroadcastChannel('everchat-access');
        channel.postMessage('sign-out');
        channel.close();
      });
      await expect(page.getByRole('button', { name: '完成退出' })).toBeVisible();
      request.release();
      await expect(composer(page)).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(localStorage).filter((key) => key.startsWith('everchat:')),
          ),
        )
        .toEqual([]);
      await page.reload();
      await expect(page.getByRole('button', { name: '完成退出' })).toBeVisible();
      await expect(composer(page)).toHaveCount(0);
    } finally {
      request.release();
    }
  } finally {
    await data.cleanup();
  }
});

test('startup remains visible before scripts and while IndexedDB is delayed', async ({ page }) => {
  expect((await page.request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const script = await hold(page, /\/src\/main\.tsx(?:\?.*)?$/);
  await page.addInitScript(() => {
    const original = indexedDB.open.bind(indexedDB);
    let first = true;
    indexedDB.open = (...args: Parameters<IDBFactory['open']>) => {
      const request = original(...args);
      if (first) {
        first = false;
        Object.defineProperty(request, 'onsuccess', {
          set(callback: (event: Event) => void) {
            request.addEventListener('success', (event) => {
              (window as unknown as { releaseStorage: () => void }).releaseStorage = () =>
                callback.call(request, event);
            });
          },
        });
      }
      return request;
    };
  });
  try {
    await page.goto('/', { waitUntil: 'commit' });
    await script.entered;
    await expect(page.getByRole('status', { name: '正在启动 EverChat' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    script.release();
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { releaseStorage?: () => void }).releaseStorage === 'function',
    );
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await expect(composer(page)).toHaveCount(0);
    await page.getByRole('button', { name: '空间设置' }).click();
    await page.getByRole('tab', { name: '联网', exact: true }).click();
    await expect(page.getByText('身份确认后可用')).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { releaseStorage: () => void }).releaseStorage(),
    );
    await expect(page.getByRole('combobox', { name: '联网服务', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭设置' }).click();
    await expect(composer(page)).toBeVisible();
  } finally {
    script.release();
  }
});
