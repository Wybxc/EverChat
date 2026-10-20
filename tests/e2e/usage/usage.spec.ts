import { expect, test } from '@playwright/test';
import { emptyTotals } from '../../../worker/usage/aggregate';
test.use({ hasTouch: true });
const headers = { Origin: 'http://127.0.0.1:5174' };
test('nested usage tabs stay horizontal and transparent in both themes and viewport sizes', async ({
  page,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  await page.goto('/');
  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  await page.getByRole('tab', { name: '用量统计', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const list = dialog.getByRole('tablist', { name: '统计分类', exact: true });
  const outer = dialog.getByRole('tablist', { name: '设置分类', exact: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(outer).toHaveAttribute(
      'aria-orientation',
      width === 390 ? 'horizontal' : 'vertical',
    );
    for (const dark of [true, false]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark);
      await expect(list).toHaveAttribute('aria-orientation', 'horizontal');
      await expect
        .poll(() => list.evaluate((el) => getComputedStyle(el).flexDirection))
        .toBe('row');
      const boxes = await list.getByRole('tab').evaluateAll((tabs) =>
        tabs.map((tab) => {
          const { x, y } = tab.getBoundingClientRect();
          return { x, y };
        }),
      );
      expect(new Set(boxes.map(({ y }) => Math.round(y))).size).toBe(1);
      expect(boxes.every((box, index) => index === 0 || box.x > boxes[index - 1].x)).toBe(true);
      for (const element of [list, ...(await list.getByRole('tab').all())])
        await expect
          .poll(() => element.evaluate((el) => getComputedStyle(el).backgroundColor))
          .toBe('rgba(0, 0, 0, 0)');
      await expect
        .poll(() =>
          dialog.getByTestId('usage-tab-header').evaluate((header) => {
            const panel = header.closest('[data-slot="dialog-content"]')!;
            return (
              getComputedStyle(header).backgroundColor === getComputedStyle(panel).backgroundColor
            );
          }),
        )
        .toBe(true);
      for (const target of await list.getByRole('tab').all()) {
        await target.click();
        await expect(target).toHaveAttribute('aria-selected', 'true');
        await expect
          .poll(() => target.evaluate((tab) => getComputedStyle(tab).backgroundColor))
          .toBe('rgba(0, 0, 0, 0)');
      }
    }
  }
});
test('configured official models receive catalog defaults and explicit custom zero pricing overrides them', async ({
  request,
}) => {
  await request.post('/__dev/access/login', { headers });
  const original = await request.get('/api/settings/providers').then((response) => response.json());
  const providerId = crypto.randomUUID();
  try {
    expect(
      (
        await request.put('/api/settings/providers', {
          headers,
          data: {
            ...original,
            activeProviderId: providerId,
            activeModel: 'deepseek-flash',
            providers: [
              {
                id: providerId,
                name: '默认价格验证',
                provider: 'openai-chat',
                baseUrl: 'https://api.deepseek.com/',
                apiKey: 'integration-test-key',
                models: [{ id: 'deepseek-flash', name: 'Flash', enabled: true }],
              },
            ],
          },
        })
      ).ok(),
    ).toBe(true);
    const prices = () => request.get('/api/usage/prices').then((response) => response.json());
    const price = (await prices()).find(
      (entry: { providerId: string }) => entry.providerId === providerId,
    );
    expect(price).toMatchObject({
      currency: 'USD',
      input: '0.15',
      output: '0.6',
      cacheRead: '0.003',
      reasoning: '0.6',
    });
    expect(price.id).toMatch(/^models.dev:/);
    const { id: _id, effectiveFrom: _at, ...input } = price;
    expect(
      (
        await request.put('/api/usage/prices', {
          headers,
          data: { ...input, input: '0', source: '自定义' },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (await prices()).filter((entry: { providerId: string }) => entry.providerId === providerId),
    ).toMatchObject([{ input: '0', source: '自定义' }]);
  } finally {
    await request.put('/api/settings/providers', { headers, data: original });
  }
});
test('line trend supports tooltips, keyboard inspection, metric switching and range selection on compact layouts', async ({
  page,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const trend = Array.from({ length: 12 }, (_, index) => ({
    ...emptyTotals(),
    key: `2026-10-${String(index + 1).padStart(2, '0')}`,
    label: `2026-10-${String(index + 1).padStart(2, '0')}`,
    at: Date.UTC(2026, 9, index + 1),
    requests: index + 1,
    inputTokens: 1000 * index,
    outputTokens: 100 * index,
    currencies: { USD: String(BigInt(index + 1) * 1000000000n) },
  }));
  await page.route('**/api/usage/report?*', (route) =>
    route.fulfill({
      json: { totals: emptyTotals(), trend, providers: [], models: [], collectedSince: null },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  await page.getByRole('tab', { name: '用量统计', exact: true }).click();
  const chart = page.getByRole('figure', { name: '用量趋势图' });
  await expect(chart.locator('.recharts-line-curve')).toBeVisible();
  await chart.locator('.recharts-wrapper').tap({ position: { x: 120, y: 70 } });
  await expect(chart.locator('.recharts-tooltip-wrapper')).toBeVisible();
  const plot = chart.locator('.recharts-surface').first();
  await plot.focus();
  await page.keyboard.press('ArrowRight');
  await expect(chart.locator('.recharts-tooltip-wrapper')).toBeVisible();
  await expect(chart.locator('.recharts-tooltip-wrapper')).toContainText('次请求');
  await chart.getByLabel('趋势指标').selectOption('tokens');
  await expect(chart.locator('.recharts-line-curve')).toHaveCount(2);
  await expect(chart.locator('.recharts-legend-wrapper')).toContainText('输入 Token');
  await expect(chart.locator('.recharts-legend-wrapper')).toContainText('输出 Token');
  await plot.focus();
  await page.keyboard.press('ArrowRight');
  await expect(chart.locator('.recharts-tooltip-wrapper')).toContainText('Tokens');
  await chart.getByLabel('趋势指标').selectOption('USD');
  await plot.focus();
  await page.keyboard.press('ArrowRight');
  await expect(chart.locator('.recharts-tooltip-wrapper')).toContainText('USD');
  const travellers = chart.locator('.recharts-brush-traveller');
  await expect(travellers).toHaveCount(2);
  await travellers.last().scrollIntoViewIfNeeded();
  const handle = await travellers.last().boundingBox();
  expect(handle).toBeTruthy();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x - 90, handle!.y + handle!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() =>
      travellers
        .last()
        .boundingBox()
        .then((box) => box!.x),
    )
    .toBeLessThan(handle!.x - 50);
  await page.setViewportSize({ width: 390, height: 740 });
  await expect(chart.locator('.recharts-line-curve')).toBeVisible();
  await expect
    .poll(() => chart.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await expect
    .poll(() =>
      page
        .getByRole('dialog', { name: '设置', exact: true })
        .boundingBox()
        .then((box) => Math.round(box!.x)),
    )
    .toBe(0);
  await expect
    .poll(() =>
      page
        .getByRole('dialog', { name: '设置', exact: true })
        .boundingBox()
        .then((box) => Math.round(box!.y)),
    )
    .toBe(0);
  await page.screenshot({ path: '/tmp/everchat-usage-line-phone.png' });
});
test('comparison charts rank existing report data without extra requests and preserve exact currency tooltips', async ({
  page,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const providers = Array.from({ length: 10 }, (_, index) => ({
    ...emptyTotals(),
    key: `provider-${index}`,
    label: `Provider ${index}`,
    requests: index + 1,
    inputTokens: (10 - index) * 100,
    currencies:
      index === 0
        ? { CNY: '5000000000000' }
        : index === 1
          ? {}
          : { USD: `${9007199254740993n + BigInt(index)}` },
    unpriced: index === 1 ? 1 : 0,
  }));
  let reports = 0;
  await page.route('**/api/usage/report?*', (route) => {
    reports++;
    return route.fulfill({
      json: {
        totals: emptyTotals(),
        providers,
        models: providers.map((p) => ({ ...p, label: `${p.label} · Model` })),
        trend: [],
        collectedSince: null,
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '空间设置', exact: true }).click();
  await page.getByRole('tab', { name: '用量统计', exact: true }).click();
  await page
    .getByRole('tablist', { name: '统计分类', exact: true })
    .getByRole('tab', { name: '供应商', exact: true })
    .click();
  const chart = page.getByRole('figure', { name: '供应商比较' });
  await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(9);
  const before = reports;
  await chart.getByLabel('比较指标').selectOption('USD');
  await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(8);
  const plot = chart.locator('.recharts-surface').first();
  await plot.focus();
  await page.keyboard.press('ArrowRight');
  await expect(chart.locator('.recharts-tooltip-wrapper')).toContainText('USD 9007.199255');
  await expect(chart.locator('.recharts-tooltip-wrapper')).toContainText('Provider ');
  await chart.getByLabel('比较指标').selectOption('CNY');
  await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(1);
  await chart.getByLabel('比较指标').selectOption('tokens');
  await expect(
    chart
      .locator('text')
      .filter({ hasText: /^Provider/ })
      .first(),
  ).toContainText('Provider 0');
  expect(reports).toBe(before);
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await expect(
    page.getByRole('figure', { name: '模型比较' }).locator('.recharts-bar-rectangle'),
  ).toHaveCount(9);
  await page.getByRole('figure', { name: '模型比较' }).locator('.recharts-surface').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('figure', { name: '模型比较' }).locator('.recharts-tooltip-wrapper'),
  ).toContainText('Model');
  await page.setViewportSize({ width: 390, height: 740 });
  await expect.poll(() => chart.count()).toBe(0);
  const modelChart = page.getByRole('figure', { name: '模型比较' });
  await expect.poll(() => modelChart.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.x)).toBe(0);
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.y)).toBe(0);
  await page.screenshot({ path: '/tmp/everchat-ai-elements-comparison-phone.png' });
});
for (const mobile of [false, true])
  test(`usage filters, pricing, export and dismissal work on ${mobile ? 'phone' : 'desktop'}`, async ({
    page,
    context,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 740 });
    const request = context.request;
    await request.post('/__dev/access/login', { headers });
    const original = await request.get('/api/settings/providers').then((r) => r.json());
    const providerId = crypto.randomUUID(),
      id = crypto.randomUUID(),
      model = 'raw-openai-chat',
      providerName = `UI 用量供应商-${mobile ? '手机' : '桌面'}`;
    try {
      expect(
        (
          await request.put('/api/settings/providers', {
            headers,
            data: {
              providers: [
                {
                  id: providerId,
                  name: providerName,
                  provider: 'openai-chat',
                  baseUrl: 'https://provider.test/v1',
                  apiKey: 'integration-test-key',
                  models: [{ id: model, name: '用量模型', enabled: true }],
                },
              ],
              activeProviderId: providerId,
              activeModel: model,
              systemPrompt: '',
              maxOutputTokens: null,
            },
          })
        ).ok(),
      ).toBe(true);
      expect(
        (
          await request.post('/api/conversations', { headers, data: { id, title: '费用验证' } })
        ).status(),
      ).toBe(201);
      const response = await request.post(`/api/conversations/${id}/messages`, {
        headers,
        data: { requestId: crypto.randomUUID(), parentId: null, content: '账本界面验证' },
      });
      expect(response.status()).toBe(202);
      await expect
        .poll(async () =>
          request
            .get(`/api/usage/report?providerId=${providerId}`)
            .then((r) => r.json())
            .then((r) => r.totals.completed),
        )
        .toBe(1);
      await page.goto('/');
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
      if (mobile) await page.getByRole('button', { name: '打开对话列表', exact: true }).click();
      await page.getByRole('button', { name: '空间设置', exact: true }).click();
      await page.getByRole('tab', { name: '用量统计', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '设置', exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('统计供应商', { exact: true }).selectOption(providerId);
      await expect(dialog.getByText('模型请求／回答', { exact: true })).toBeVisible();
      await dialog.getByRole('tab', { name: '请求', exact: true }).click();
      expect(
        await dialog
          .getByRole('tab', { name: '请求', exact: true })
          .evaluate((element) => getComputedStyle(element).outlineStyle),
      ).toBe('none');
      expect(
        await dialog
          .getByRole('tablist', { name: '统计分类' })
          .evaluate((element) => getComputedStyle(element).outlineStyle),
      ).toBe('none');
      await page.keyboard.press('ArrowRight');
      await expect(dialog.getByRole('tab', { name: '定价', exact: true })).toBeFocused();
      expect(
        await dialog
          .getByRole('tab', { name: '定价', exact: true })
          .evaluate((element) => getComputedStyle(element).outlineStyle),
      ).toBe('solid');
      await dialog.getByRole('tab', { name: '请求', exact: true }).click();
      await expect(dialog.locator('#usage-panel-requests summary')).toContainText(providerName);
      await dialog.locator('#usage-panel-requests summary').click();
      await expect(dialog.getByRole('link', { name: '定位回答' })).toBeVisible();
      await dialog.getByRole('tab', { name: '定价', exact: true }).click();
      const row = dialog
        .locator('div.flex')
        .filter({ hasText: `${providerName} · 用量模型` })
        .last();
      await row.getByRole('button', { name: '配置价格' }).click();
      const editor = page.getByRole('dialog', { name: '模型定价', exact: true });
      await expect(editor).toBeVisible();
      await editor.getByLabel('每百万输入 Token', { exact: true }).fill('2');
      await editor.getByLabel('每百万输出 Token', { exact: true }).fill('8');
      await editor.getByRole('button', { name: '保存价格', exact: true }).click();
      await expect(editor).not.toBeVisible();
      await dialog.getByRole('tab', { name: '请求', exact: true }).click();
      await dialog.locator('#usage-panel-requests summary').click();
      await expect(dialog.getByRole('button', { name: '按当前价格补算' })).toHaveCount(0);
      await expect(dialog.getByLabel('修正金额', { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '保存修正', exact: true })).toHaveCount(0);
      const downloaded = page.waitForEvent('download');
      await dialog.getByRole('button', { name: '导出 CSV', exact: true }).click();
      expect((await downloaded).suggestedFilename()).toMatch(/EverChat-usage.*csv/);
      await page.screenshot({ path: `/tmp/everchat-usage-${mobile ? 'phone' : 'desktop'}.png` });
      await page.evaluate(() => {
        document.documentElement.dataset.usageNavigation = 'same-document';
      });
      await dialog.getByRole('link', { name: '定位回答', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/c/${id}\\?branch=`));
      expect(await page.evaluate(() => document.documentElement.dataset.usageNavigation)).toBe(
        'same-document',
      );
    } finally {
      await request.delete(`/api/conversations/${id}`, { headers });
      await request.put('/api/settings/providers', { headers, data: original });
    }
  });
