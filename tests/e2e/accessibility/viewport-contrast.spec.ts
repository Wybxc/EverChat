import { expect, test, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import { openSpaceSettings } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function fixture(page: Page) {
  await page.request.post('/__dev/access/login', { headers });
  const original = (await page.request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const provider = crypto.randomUUID(),
    id = crypto.randomUUID();
  await page.request.put('/api/settings/providers', {
    headers,
    data: {
      ...original,
      activeProviderId: provider,
      activeModel: 'test-model',
      providers: [
        {
          id: provider,
          name: '界面验收',
          provider: 'openai-chat',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'integration-test-key',
          models: [
            {
              id: 'test-model',
              name: '一个用于检查窄屏和长名称截断的模型显示名',
              enabled: true,
              reasoningSupport: 'supported',
              metadataOverrides: { contextWindow: 128000 },
            },
          ],
        },
      ],
    },
  });
  await page.request.post('/api/conversations', {
    headers,
    data: { id, title: '一条很长的对话名称，用于确认标题不会挤压导航按钮或超出视口' },
  });
  await page.request.post(`/api/__test/conversations/${id}/search-history`, { headers, data: {} });
  return {
    id,
    cleanup: async () => {
      await page.request.delete(`/api/conversations/${id}`, { headers });
      await page.request.put('/api/settings/providers', { headers, data: original });
    },
  };
}

async function theme(page: Page, name: string) {
  await openSpaceSettings(page);
  const tab = page.getByRole('tab', { name: '通用', exact: true });
  await tab.focus();
  await tab.press('Space');
  const control = page.getByRole('radio', { name, exact: true });
  await control.focus();
  await control.press('Space');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
}

test('viewport matrix preserves usable reading, compact navigation, menus and rich content in both themes', async ({
  page,
}) => {
  const source = await fixture(page);
  try {
    await page.goto(`/c/${source.id}`);
    await expect(page.getByTestId('assistant-message').last()).toBeVisible();
    await page.locator('[data-streamdown="mermaid-block"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-streamdown="mermaid"] svg').first()).toBeVisible();
    for (const mode of ['浅色', '深色']) {
      await theme(page, mode);
      for (const [width, height] of [
        [320, 568],
        [360, 640],
        [390, 844],
        [768, 1024],
        [1024, 768],
        [1280, 720],
        [1440, 900],
        [844, 390],
      ]) {
        await page.setViewportSize({ width, height });
        await page.goto('/');
        await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
        await expect(page.getByTestId('context-omission')).toHaveCount(0);
        const composer = await page.getByTestId('chat-composer').boundingBox();
        const reading = await page.getByTestId('message-viewport').boundingBox();
        expect(composer!.height, `${mode} ${width} input`).toBeLessThanOrEqual(160);
        const greeting = await page
          .getByRole('heading', { name: '今天想聊些什么？' })
          .boundingBox();
        expect(greeting!.y).toBeGreaterThan(50);
        expect(composer!.y + composer!.height).toBeLessThanOrEqual(height);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          `${mode} ${width} overflow`,
        ).toBe(width);
        const header = page.getByRole('banner');
        expect(await header.locator('button:visible').count()).toBeLessThanOrEqual(
          width >= 768 && width < 1024 ? 4 : 3,
        );
        for (const control of await header.locator('button:visible').all()) {
          const box = await control.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        }
        await page.getByRole('button', { name: '更多会话操作' }).click();
        const menu = page.getByRole('menu');
        const box = await menu.boundingBox();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(height);
        await page.keyboard.press('Escape');
        await page.goto(`/c/${source.id}`);
        await expect(page.getByTestId('assistant-message').last()).toBeVisible();
        await page.locator('[data-streamdown="mermaid-block"]').scrollIntoViewIfNeeded();
        await expect(page.locator('[data-streamdown="mermaid"] svg').first()).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          `${mode} ${width} rich content overflow`,
        ).toBe(width);
        if (height >= 568)
          expect(
            (await page.getByTestId('message-viewport').boundingBox())!.height,
          ).toBeGreaterThanOrEqual(300);
        if (width === 390 || width === 1280)
          await page.screenshot({ path: test.info().outputPath(`layout-${mode}-${width}.png`) });
      }
    }
  } finally {
    await source.cleanup();
  }
});

test('200% text keeps model selection and sending within a 320px reflow viewport', async ({
  page,
}) => {
  const source = await fixture(page);
  try {
    // 320 CSS pixels also covers reflow at 400% page zoom on a 1280px layout.
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    await page.getByLabel('消息', { exact: true }).fill('放大文字后仍可发送');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    for (const label of ['聊天模型', '更多参数', '发送消息']) {
      const control = page.getByLabel(label, { exact: true });
      await expect(control).toBeInViewport({ ratio: 1 });
      expect((await control.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole('button', { name: '更多参数', exact: true }).click();
    await expect(page.getByLabel('思维强度', { exact: true })).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
  } finally {
    await source.cleanup();
  }
});

// Resolve modern theme colors in the browser's canvas, then composite alpha against ancestor surfaces.
async function contrast(
  page: Page,
  samples: {
    selector: string;
    property?: 'color' | 'borderTopColor' | 'outlineColor' | 'stroke';
    pseudo?: string;
    minimum?: number;
  }[],
) {
  const results = await page.evaluate((samples) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).map((value, i) =>
        i === 3 ? value / 255 : value / 255,
      );
    };
    const blend = (fg: number[], bg: number[]) =>
      fg
        .slice(0, 3)
        .map((value, i) => value * fg[3] + bg[i] * (1 - fg[3]))
        .concat(1);
    const luminance = (rgb: number[]) =>
      rgb
        .slice(0, 3)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    return samples.map((sample) => {
      const element = document.querySelector<HTMLElement>(sample.selector)!;
      if (!element) throw new Error(`Missing contrast sample: ${sample.selector}`);
      let background = [1, 1, 1, 1];
      const ancestors: HTMLElement[] = [];
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement)
        ancestors.unshift(parent);
      for (const parent of ancestors)
        background = blend(rgba(getComputedStyle(parent).backgroundColor), background);
      const color = getComputedStyle(element, sample.pseudo)[sample.property ?? 'color'];
      const foreground = blend(rgba(color), background);
      const light = luminance(foreground),
        dark = luminance(background);
      return {
        selector: sample.selector,
        color,
        ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05),
        minimum: sample.minimum ?? 4.5,
      };
    });
  }, samples);
  for (const result of results)
    expect(result.ratio, `${result.selector} ${result.color}`).toBeGreaterThanOrEqual(
      result.minimum,
    );
}

test('semantic theme text, selected navigation, placeholders and focus meet contrast targets', async ({
  page,
}) => {
  // Sample the final theme colors rather than intermediate transition frames.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const source = await fixture(page);
  try {
    await page.goto(`/c/${source.id}`);
    await page.getByLabel('消息', { exact: true }).fill('对比度验收');
    for (const mode of ['浅色', '深色']) {
      await page.setViewportSize({ width: 1280, height: 720 });
      await theme(page, mode);
      await page.getByLabel('消息', { exact: true }).focus();
      // WebKit may report the previous inherited text color for the first
      // transition frame, even with reduced motion. Verify the endpoint first.
      await expect(page.getByLabel('消息', { exact: true })).toHaveCSS(
        'color',
        await page.locator('body').evaluate((node) => getComputedStyle(node).color),
      );
      await contrast(page, [
        { selector: '[data-testid="conversation-title"]' },
        { selector: 'aside [aria-current="page"]' },
        { selector: '[data-testid="chat-composer"] textarea' },
        { selector: '[data-testid="chat-composer"] textarea', pseudo: '::placeholder' },
        { selector: '[data-testid="chat-composer"]', property: 'borderTopColor', minimum: 3 },
        { selector: '[data-testid="chat-composer"]', property: 'outlineColor', minimum: 3 },
        { selector: '[aria-label="发送消息"]' },
        { selector: '.context-trigger' },
        { selector: '.context-trigger [data-slot=progress-track]', property: 'stroke', minimum: 3 },
        {
          selector: '.context-trigger [data-slot=progress-indicator]',
          property: 'stroke',
          minimum: 3,
        },
      ]);
      await page.getByRole('button', { name: '发送消息', exact: true }).hover();
      await contrast(page, [{ selector: '[aria-label="发送消息"]' }]);
      await page.getByRole('button', { name: '会话参数', exact: true }).focus();
      await contrast(page, [
        { selector: '[aria-label="会话参数"]', property: 'outlineColor', minimum: 3 },
      ]);
      await openSpaceSettings(page);
      await page.getByRole('tab', { name: '供应商', exact: true }).click();
      await page.getByLabel('名称', { exact: true }).fill(`对比度 ${mode}`);
      await expect(page.getByTestId('settings-save-status')).toBeVisible();
      await contrast(page, [
        { selector: '#space-settings-title' },
        { selector: '#settings-tab-providers' },
        { selector: '[data-testid="settings-save-status"]' },
      ]);
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    }
  } finally {
    await source.cleanup();
  }
});
