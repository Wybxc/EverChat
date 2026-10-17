import { expect, test, type APIRequestContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:5174';
const headers = { Origin: origin };

async function configure(request: APIRequestContext, model = 'benchmark-text-2-10-32') {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const initial = await request.get('/api/settings/providers').then((response) => response.json());
  const providerId = '00000000-0000-4000-8000-000000000099';
  const settings = {
    providers: [
      {
        id: providerId,
        name: 'Integration',
        provider: 'openai-chat',
        baseUrl: 'https://provider.test/v1',
        models: [{ id: model, name: 'test-model', enabled: true }],
        apiKey: 'integration-test-key',
      },
    ],
    activeProviderId: providerId,
    activeModel: model,
    systemPrompt: '',
    maxOutputTokens: 128,
  };
  expect((await request.put('/api/settings/providers', { headers, data: settings })).status()).toBe(
    200,
  );
  return { initial };
}

test('continuing an older branch keeps alternate answers out of the provider context', async ({
  request,
}) => {
  const { initial } = await configure(request);
  const id = crypto.randomUUID();
  try {
    expect(
      (
        await request.post('/api/conversations', { headers, data: { id, title: '分支上下文' } })
      ).status(),
    ).toBe(201);
    expect(
      (
        await request.post(`/api/conversations/${id}/messages`, {
          headers,
          data: { requestId: crypto.randomUUID(), content: '缺少父节点' },
        })
      ).status(),
    ).toBe(400);
    const first = await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: { requestId: crypto.randomUUID(), content: '第一条消息', parentId: null },
    });
    expect(first.status()).toBe(202);
    await expect
      .poll(
        async () =>
          (
            await request.get(`/api/conversations/${id}`).then((response) => response.json())
          ).messages.at(-1)?.status,
        { timeout: 30_000 },
      )
      .toBe('completed');
    const firstSnapshot = await request
      .get(`/api/conversations/${id}`)
      .then((response) => response.json());
    const firstAssistant = firstSnapshot.messages[1];
    expect(
      (
        await request.post(`/api/conversations/${id}/messages`, {
          headers,
          data: { requestId: crypto.randomUUID(), content: '不能默认为最新消息', parentId: null },
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await request.post(`/api/conversations/${id}/messages`, {
          headers,
          data: {
            requestId: crypto.randomUUID(),
            content: '其他对话的消息',
            parentId: crypto.randomUUID(),
          },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.post(`/api/conversations/${id}/messages`, {
          headers,
          data: {
            requestId: crypto.randomUUID(),
            retryOf: firstAssistant.id,
            parentId: firstAssistant.id,
          },
        })
      ).status(),
    ).toBe(400);

    const retry = await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: { requestId: crypto.randomUUID(), retryOf: firstAssistant.id },
    });
    expect(retry.status()).toBe(202);
    await expect
      .poll(
        async () =>
          (
            await request.get(`/api/conversations/${id}`).then((response) => response.json())
          ).messages.at(-1)?.status,
        { timeout: 30_000 },
      )
      .toBe('completed');
    const retried = await request
      .get(`/api/conversations/${id}`)
      .then((response) => response.json());
    expect(retried.messages).toHaveLength(3);
    expect(retried.messages[2]).toMatchObject({
      role: 'assistant',
      revisionOf: firstAssistant.id,
      parentId: retried.messages[0].id,
    });

    const branch = await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        content: '沿旧分支继续',
        parentId: firstAssistant.id,
      },
    });
    expect(branch.status()).toBe(202);
    const branchSubmission = (await branch.json()) as {
      runId: string;
      userId: string;
      assistantId: string;
    };
    const context = await request
      .post(`/api/__test/conversations/${id}/context`, {
        headers,
        data: { runId: branchSubmission.runId },
      })
      .then((response) => response.json());
    expect(context.context).toHaveLength(3);
    expect(context.context.map(({ role }: { role: string }) => role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(context.context[0].content).toBe('第一条消息');
    expect(context.context[2].content).toBe('沿旧分支继续');
    await expect
      .poll(
        async () =>
          (
            await request.get(`/api/conversations/${id}`).then((response) => response.json())
          ).messages.at(-1)?.status,
        { timeout: 30_000 },
      )
      .toBe('completed');
    const final = await request.get(`/api/conversations/${id}`).then((response) => response.json());
    expect(final.messages[3]).toMatchObject({ role: 'user', parentId: firstAssistant.id });
    expect(final.messages[4]).toMatchObject({ role: 'assistant', parentId: final.messages[3].id });

    const edited = await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        content: '修改第一条消息',
        revisionOf: firstSnapshot.messages[0].id,
      },
    });
    expect(edited.status()).toBe(202);
    const editedSubmission = await edited.json();
    const editedContext = await request
      .post(`/api/__test/conversations/${id}/context`, {
        headers,
        data: { runId: editedSubmission.runId },
      })
      .then((response) => response.json());
    expect(editedContext.context).toEqual([{ role: 'user', content: '修改第一条消息' }]);
    await expect
      .poll(
        async () =>
          (
            await request.get(`/api/conversations/${id}`).then((response) => response.json())
          ).messages.at(-1)?.status,
      )
      .toBe('completed');

    const continued = await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        content: '沿修改后的根继续',
        parentId: editedSubmission.assistantId,
      },
    });
    expect(continued.status()).toBe(202);
    const continuedSubmission = await continued.json();
    const continuedContext = await request
      .post(`/api/__test/conversations/${id}/context`, {
        headers,
        data: { runId: continuedSubmission.runId },
      })
      .then((response) => response.json());
    expect(continuedContext.context).toHaveLength(3);
    expect(continuedContext.context[0].content).toBe('修改第一条消息');
    expect(continuedContext.context[2].content).toBe('沿修改后的根继续');
    expect(
      continuedContext.context.some(({ content }: { content: string }) => content === '第一条消息'),
    ).toBe(false);
  } finally {
    await request.delete(`/api/conversations/${id}`, { headers });
    expect(
      (await request.put('/api/settings/providers', { headers, data: initial })).status(),
    ).toBe(200);
  }
});

async function branchingFixture(request: APIRequestContext, rich = false) {
  const { initial } = await configure(request, 'benchmark-text-20-100-32'),
    empty = crypto.randomUUID();
  expect(
    (
      await request.post('/api/conversations', {
        headers,
        data: { id: empty, title: '分支导航回归' },
      })
    ).status(),
  ).toBe(201);
  const backup = await request
    .get(`/api/conversations/${empty}/backup`)
    .then((response) => response.json());
  const ids = Array.from({ length: 8 }, () => crypto.randomUUID());
  const content = [
    '原始提问',
    '原始回答',
    '原分支追问',
    '原分支后续',
    '另一回答',
    '另一追问',
    '另一后续',
    '第三回答',
  ];
  if (rich)
    content[1] = `原始回答\n\n${Array.from({ length: 45 }, (_, i) => `段落 ${i}：**长回答**中需要保持分叉操作行的位置。`).join('\n\n')}\n\n| 列 | 内容 |\n| --- | --- |\n${Array.from({ length: 35 }, (_, i) => `| ${i} | 表格内容 |`).join('\n')}\n\n\`\`\`js\n${Array.from({ length: 80 }, (_, i) => `const value${i} = ${i};`).join('\n')}\n\`\`\``;
  const parents = [null, 0, 1, 2, 0, 1, 5, 0];
  backup.conversation.messages = content.map((text, i) => ({
    id: ids[i],
    role: [0, 2, 5].includes(i) ? 'user' : 'assistant',
    parts: [{ type: 'text', text }],
    status: 'completed',
    createdAt: i,
    parentId: parents[i] === null ? null : ids[parents[i]!],
    revisionOf: i === 4 ? ids[1] : i === 7 ? ids[4] : null,
    error: null,
    providerId: null,
    model: null,
    modelName: null,
  }));
  const restored = await request.post('/api/backup/restore', { headers, data: backup });
  expect(restored.status()).toBe(201);
  const { id, snapshot } = await restored.json();
  const messages = snapshot.messages as import('../../../shared/conversation/types').Message[];
  return {
    id,
    empty,
    messages,
    cleanup: async () => {
      await request.delete(`/api/conversations/${id}`, { headers });
      await request.delete(`/api/conversations/${empty}`, { headers });
      expect((await request.put('/api/settings/providers', { headers, data: initial })).ok()).toBe(
        true,
      );
    },
  };
}
const at = (page: import('@playwright/test').Page, id: string) =>
  page.locator(`[data-message-id="${id}"]`);

test('bubble switches restore nested branches, URL history, draft and keyboard focus without calling a provider', async ({
  page,
}) => {
  const f = await branchingFixture(page.request),
    m = f.messages;
  try {
    await page.goto(`/c/${f.id}?branch=${m[3].id}`);
    await expect(page.getByTestId('assistant-message')).toHaveCount(2);
    await expect(at(page, m[4].id)).toHaveCount(0);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('保留草稿');
    await at(page, m[2].id).getByRole('button', { name: '下一个提问版本', exact: true }).click();
    await expect(at(page, m[6].id)).toBeVisible();
    await expect(at(page, m[3].id)).toHaveCount(0);
    await at(page, m[1].id).getByRole('button', { name: '下一个回答版本', exact: true }).click();
    await expect(at(page, m[4].id)).toBeVisible();
    await expect(page.getByTestId('assistant-message')).toHaveCount(1);
    await expect(
      at(page, m[4].id).getByRole('button', { name: '下一个回答版本', exact: true }),
    ).toBeFocused();
    await expect(page).toHaveURL(`/c/${f.id}?branch=${m[4].id}`);
    await page.goBack();
    await expect(at(page, m[6].id)).toBeVisible();
    await page.goForward();
    await expect(at(page, m[4].id)).toBeVisible();
    await at(page, m[4].id).getByRole('button', { name: '上一个回答版本', exact: true }).click();
    await expect(at(page, m[6].id)).toBeVisible();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('保留草稿');
    await page.reload();
    await expect(at(page, m[6].id)).toBeVisible();
    const resources = await page.request
      .post(`/api/__test/conversations/${f.id}/resources`, { headers, data: {} })
      .then((response) => response.json());
    expect(resources.calls).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test('editing a past prompt or answer creates an independent version and keeps all old descendants on the old branch', async ({
  page,
}) => {
  const f = await branchingFixture(page.request),
    m = f.messages;
  try {
    await page.goto(`/c/${f.id}?branch=${m[3].id}`);
    await at(page, m[1].id).getByRole('button', { name: '编辑回答', exact: true }).click();
    await page.getByRole('textbox', { name: '回答内容', exact: true }).fill('手动修改后的回答');
    await page.getByRole('button', { name: '保存新版本', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '编辑回答', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('assistant-message')).toHaveCount(1);
    await expect(page.getByTestId('assistant-message')).toContainText('手动修改后的回答');
    await expect(at(page, m[2].id)).toHaveCount(0);
    const edited = await page.request
      .get(`/api/conversations/${f.id}`)
      .then((response) => response.json());
    expect(edited.messages.slice(0, 8)).toEqual(m);
    expect(edited.messages.at(-1)).toMatchObject({
      parentId: m[0].id,
      revisionOf: m[1].id,
      runId: null,
    });
    await page
      .getByTestId('assistant-message')
      .getByRole('button', { name: '上一个回答版本', exact: true })
      .click();
    await page
      .getByTestId('assistant-message')
      .getByRole('button', { name: '上一个回答版本', exact: true })
      .click();
    await page
      .getByTestId('assistant-message')
      .getByRole('button', { name: '上一个回答版本', exact: true })
      .click();
    await expect(at(page, m[3].id)).toBeVisible();
    await at(page, m[0].id).getByRole('button', { name: '编辑提问', exact: true }).click();
    await expect(
      at(page, m[0].id).getByRole('textbox', { name: '提问内容', exact: true }),
    ).toHaveValue('原始提问');
    await page.getByRole('textbox', { name: '提问内容', exact: true }).fill('修改后的根提问');
    await page.getByRole('button', { name: '保存并重新生成', exact: true }).click();
    await expect(page.getByTestId('user-message')).toHaveCount(1);
    await expect(page.getByTestId('user-message')).toContainText('修改后的根提问');
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    await page
      .getByTestId('user-message')
      .getByRole('button', { name: '上一个提问版本', exact: true })
      .click();
    await expect(at(page, m[3].id)).toBeVisible();
  } finally {
    await f.cleanup();
  }
});

test('continuing in the middle creates a sibling question with a fixed parent and preserves the old continuation', async ({
  page,
}) => {
  const f = await branchingFixture(page.request),
    m = f.messages;
  try {
    await page.goto(`/c/${f.id}?branch=${m[3].id}`);
    await at(page, m[1].id).getByRole('button', { name: '更多消息操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '从这里继续', exact: true }).click();
    await expect(at(page, m[2].id)).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '查看后续', exact: true }).click();
    await expect(at(page, m[3].id)).toBeVisible();
    await page.goBack();
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    await editor.fill('独立的新追问');
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/conversations/${f.id}/messages`),
    );
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const submission = await (await accepted).json();
    const input = await page.request
      .post(`/api/__test/conversations/${f.id}/context`, {
        headers,
        data: { runId: submission.runId },
      })
      .then((response) => response.json());
    expect(input.context.map((item: { content: string }) => item.content)).toEqual([
      '原始提问',
      '原始回答',
      '独立的新追问',
    ]);
    await expect(page.getByTestId('user-message').last()).toContainText('独立的新追问');
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute(
      'data-status',
      'completed',
    );
    const snapshot = await page.request
      .get(`/api/conversations/${f.id}`)
      .then((response) => response.json());
    const user = snapshot.messages.at(-2);
    expect(user).toMatchObject({ parentId: m[1].id, revisionOf: null });
    await at(page, user.id).getByRole('button', { name: '上一个提问版本', exact: true }).click();
    await expect(at(page, m[6].id)).toBeVisible();
  } finally {
    await f.cleanup();
  }
});

test('late acceptance and hidden streaming never take over reading or restart the provider', async ({
  page,
}) => {
  const f = await branchingFixture(page.request),
    m = f.messages;
  let release = () => {};
  try {
    await page.goto(`/c/${f.id}?branch=${m[3].id}`);
    let accepted: { assistantId: string; runId: string } | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/conversations/${f.id}/messages`, async (route) => {
      const response = await route.fetch();
      accepted = await response.json();
      await gate;
      await route.fulfill({ response });
    });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('后台生成的问题');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => accepted?.assistantId).toBeTruthy();
    await at(page, m[1].id).getByRole('button', { name: '下一个回答版本', exact: true }).click();
    const arrow = at(page, m[4].id).getByRole('button', { name: '下一个回答版本', exact: true });
    await expect(arrow).toBeFocused();
    release();
    await expect(page.getByRole('status').filter({ hasText: '另一分支生成中' })).toBeVisible();
    await expect(page).toHaveURL(`/c/${f.id}?branch=${m[4].id}`);
    await expect(at(page, accepted!.assistantId)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '另一分支已结束' })).toBeVisible();
    await expect(arrow).toBeFocused();
    await page.getByRole('button', { name: '查看', exact: true }).click();
    await expect(at(page, accepted!.assistantId)).toHaveAttribute('data-status', 'completed');
    await expect(
      at(page, accepted!.assistantId).locator('[data-search-content$=":content"]'),
    ).not.toBeEmpty();
    const resources = await page.request
      .post(`/api/__test/conversations/${f.id}/resources`, { headers, data: {} })
      .then((response) => response.json());
    expect(resources.calls).toBe(1);
  } finally {
    release();
    await f.cleanup();
  }
});

test('offline queued messages retain their original parent after the reader switches branches', async ({
  page,
  context,
}) => {
  const f = await branchingFixture(page.request),
    m = f.messages;
  try {
    await page.goto(`/c/${f.id}?branch=${m[3].id}`);
    await expect(at(page, m[3].id)).toBeVisible();
    await context.setOffline(true);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('离线追问');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('离线追问', { exact: true })).toBeVisible();
    await at(page, m[1].id).getByRole('button', { name: '下一个回答版本', exact: true }).click();
    await expect(page.getByText('另一分支等待发送', { exact: true })).toBeVisible();
    await expect(page.getByText('离线追问', { exact: true })).toHaveCount(0);
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/conversations/${f.id}/messages`),
    );
    await context.setOffline(false);
    const response = await accepted,
      input = response.request().postDataJSON(),
      result = await response.json();
    expect(input.parentId).toBe(m[3].id);
    const run = await page.request
      .post(`/api/__test/conversations/${f.id}/context`, { headers, data: { runId: result.runId } })
      .then((response) => response.json());
    expect(run.context.map((item: { content: string }) => item.content)).toEqual([
      '原始提问',
      '原始回答',
      '原分支追问',
      '原分支后续',
      '离线追问',
    ]);
    await expect(page).toHaveURL(`/c/${f.id}?branch=${m[4].id}`);
    const repeated = await page.request.post(`/api/conversations/${f.id}/messages`, {
      headers,
      data: input,
    });
    expect(repeated.status()).toBe(202);
    expect(await repeated.json()).toEqual(result);
    const cancellation = page.waitForRequest((request) =>
      request.url().endsWith(`/conversations/${f.id}/cancel`),
    );
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
    expect((await cancellation).postDataJSON()).toEqual({ runId: result.runId });
    await expect
      .poll(
        async () =>
          (
            await page.request.get(`/api/conversations/${f.id}`).then((response) => response.json())
          ).messages.at(-1)?.status,
      )
      .toBe('cancelled');
    await expect(page.getByRole('button', { name: '关闭后台分支提示', exact: true })).toBeVisible();
    await page.reload();
    await expect(at(page, m[4].id)).toBeVisible();
  } finally {
    await context.setOffline(false);
    await f.cleanup();
  }
});

test('deleted leaves recover locally while deleted connectors keep old descendants reachable on another device', async ({
  page,
  browser,
}) => {
  const f = await branchingFixture(page.request),
    m = f.messages,
    device = await browser.newContext();
  try {
    await device.request.post('/__dev/access/login', { headers });
    const other = await device.newPage();
    await other.goto(`/c/${f.id}?branch=${m[3].id}`);
    await page.goto(`/c/${f.id}?branch=${m[7].id}`);
    await page.request.delete(`/api/conversations/${f.id}/messages/${m[7].id}`, { headers });
    await expect(page).toHaveURL(`/c/${f.id}?branch=${m[4].id}`);
    await expect(at(other, m[3].id)).toBeVisible();
    await page.request.delete(`/api/conversations/${f.id}/messages/${m[1].id}`, { headers });
    await expect(at(other, m[1].id)).toContainText('消息已删除');
    await expect(at(other, m[3].id)).toBeVisible();
    await expect(other).toHaveURL(`/c/${f.id}?branch=${m[3].id}`);
    await page.reload();
    await expect(at(page, m[4].id)).toBeVisible();
    await page.goto(`/c/${f.id}?branch=${crypto.randomUUID()}`);
    await expect(page).toHaveURL(`/c/${f.id}?branch=${m[4].id}`);
    await expect(page.getByText('该分支已不可用，已显示可用分支。', { exact: true })).toBeVisible();
  } finally {
    await device.close();
    await f.cleanup();
  }
});

test('branch exports and search use the visible path; full copies, idempotent mappings and backups retain the graph', async ({
  page,
  context,
}) => {
  const f = await branchingFixture(page.request),
    m = f.messages,
    copies: string[] = [];
  try {
    await page.goto(`/c/${f.id}?branch=${m[3].id}`);
    await expect(at(page, m[3].id)).toBeVisible();
    await page.getByRole('button', { name: '更多会话操作', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Markdown', exact: true }).click();
    const text = await readFile((await (await download).path())!, 'utf8');
    expect(text).toContain('原分支后续');
    expect(text).not.toContain('另一回答');
    expect(text).not.toContain('第三回答');
    await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
    await page.getByRole('textbox', { name: '查找当前对话', exact: true }).fill('另一回答');
    await expect(page.getByRole('search', { name: '当前对话搜索', exact: true })).toContainText(
      '没有匹配结果',
    );
    await page.getByRole('button', { name: '关闭对话搜索', exact: true }).click();
    await page.getByRole('button', { name: '全局搜索', exact: true }).click();
    await page.getByRole('combobox', { name: '搜索对话', exact: true }).fill('另一回答');
    const result = page.getByRole('region', { name: '正文搜索结果' }).getByRole('link');
    await expect(result).toHaveAttribute('href', `/c/${f.id}?branch=${m[4].id}`);
    const newTab = await context.newPage();
    await newTab.goto((await result.getAttribute('href'))!);
    await expect(at(newTab, m[4].id)).toBeVisible();
    await expect(at(newTab, m[3].id)).toHaveCount(0);
    await newTab.close();
    await result.click();
    await expect(at(page, m[4].id)).toBeVisible();
    await expect(page.locator('[data-search-current]')).toHaveAttribute('data-message-id', m[4].id);
    const requestId = crypto.randomUUID(),
      data = { requestId, viewHeadId: m[4].id };
    const copied = await page.request.post(`/api/conversations/${f.id}/duplicate`, {
      headers,
      data,
    });
    expect(copied.status()).toBe(201);
    const copy = await copied.json();
    copies.push(copy.id);
    expect(copy.snapshot.messages).toHaveLength(8);
    expect(copy.viewHeadId).toBe(copy.snapshot.messages[4].id);
    expect(copy.viewHeadId).not.toBe(m[4].id);
    const repeated = await page.request.post(`/api/conversations/${f.id}/duplicate`, {
      headers,
      data,
    });
    expect(repeated.status()).toBe(201);
    expect((await repeated.json()).viewHeadId).toBe(copy.viewHeadId);
    expect(
      (
        await page.request.post(`/api/conversations/${f.id}/duplicate`, {
          headers,
          data: { ...data, viewHeadId: m[3].id },
        })
      ).status(),
    ).toBe(409);
    await page.goto(`/c/${copy.id}?branch=${copy.viewHeadId}`);
    await expect(page.getByTestId('assistant-message')).toHaveCount(1);
    const backup = await page.request
      .get(`/api/conversations/${f.id}/backup`)
      .then((response) => response.json());
    expect(backup.conversation.messages).toHaveLength(8);
    const restore = await page.request.post('/api/backup/restore', { headers, data: backup });
    expect(restore.status()).toBe(201);
    const restored = await restore.json();
    copies.push(restored.id);
    expect(restored.snapshot.messages).toHaveLength(8);
  } finally {
    for (const id of copies) await page.request.delete(`/api/conversations/${id}`, { headers });
    await f.cleanup();
  }
});

test('narrow layouts and keyboard switches retain visible focus, 44px targets and light/dark contrast tokens', async ({
  page,
}, info) => {
  const f = await branchingFixture(page.request),
    m = f.messages;
  try {
    await page.setViewportSize({ width: 390, height: 640 });
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`/c/${f.id}?branch=${m[4].id}`);
      const arrow = at(page, m[4].id).getByRole('button', { name: '下一个回答版本', exact: true });
      await arrow.focus();
      await arrow.press('Enter');
      const previous = at(page, m[7].id).getByRole('button', {
        name: '上一个回答版本',
        exact: true,
      });
      await expect(previous).toBeFocused();
      await expect(previous).toBeInViewport();
      await expect(at(page, m[7].id)).toContainText('第三回答');
      const rect = await previous.boundingBox();
      expect(rect!.width).toBeGreaterThanOrEqual(44);
      expect(rect!.height).toBeGreaterThanOrEqual(44);
      const contrast = await previous.evaluate((button) => {
        const canvas = document.createElement('canvas'),
          context = canvas.getContext('2d')!;
        const luminance = (color: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const foreground = luminance(getComputedStyle(button).color),
          background = luminance(
            getComputedStyle(document.documentElement).getPropertyValue('--background'),
          );
        return (
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        );
      });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: info.outputPath(`branches-${theme}.png`) });
      await previous.press('Space');
      await expect(at(page, m[4].id)).toBeVisible();
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).not.toBeFocused();
    }
  } finally {
    await f.cleanup();
  }
});

test('regeneration and cancelled answers remain versions, and continuing excludes unfinished content in mixed-role siblings', async ({
  page,
}) => {
  const f = await branchingFixture(page.request),
    m = f.messages;
  try {
    await page.goto(`/c/${f.id}?branch=${m[4].id}`);
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/conversations/${f.id}/messages`),
    );
    await at(page, m[4].id).getByRole('button', { name: '重新生成', exact: true }).click();
    const task = await (await accepted).json();
    await expect(at(page, task.assistantId)).toHaveAttribute('data-status', 'running');
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect(at(page, task.assistantId)).toHaveAttribute('data-status', 'cancelled');
    const again = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/conversations/${f.id}/messages`),
    );
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('失败后直接继续');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const submission = await (await again).json();
    const run = await page.request
      .post(`/api/__test/conversations/${f.id}/context`, {
        headers,
        data: { runId: submission.runId },
      })
      .then((response) => response.json());
    expect(run.context).toEqual([
      { role: 'user', content: '原始提问' },
      { role: 'user', content: '失败后直接继续' },
    ]);
    await expect(at(page, submission.assistantId)).toHaveAttribute('data-status', 'completed');
    await at(page, submission.userId)
      .getByRole('button', { name: '上一个分支', exact: true })
      .click();
    await expect(at(page, task.assistantId)).toHaveAttribute('data-status', 'cancelled');
    await expect(at(page, submission.userId)).toHaveCount(0);
    const saved = await page.request
      .get(`/api/conversations/${f.id}`)
      .then((response) => response.json());
    expect(
      saved.messages.find((item: { id: string }) => item.id === task.assistantId),
    ).toMatchObject({ parentId: m[0].id, revisionOf: m[4].id });
  } finally {
    await f.cleanup();
  }
});

test('broken parent chains block both displayed-path sending and server context construction', async ({
  page,
}) => {
  const f = await branchingFixture(page.request),
    m = f.messages;
  try {
    expect(
      (
        await page.request.post(`/api/__test/conversations/${f.id}/parent`, {
          headers,
          data: { messageId: m[3].id, parentId: m[3].id },
        })
      ).ok(),
    ).toBe(true);
    await page.goto(`/c/${f.id}?branch=${m[3].id}`);
    await expect(page.getByRole('alert')).toContainText('消息分支关系无效');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('不可发送');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    const rejected = await page.request.post(`/api/conversations/${f.id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        content: '不可构建上下文',
        parentId: m[3].id,
        selection: {
          providerId: '00000000-0000-4000-8000-000000000099',
          model: 'benchmark-text-20-100-32',
        },
      },
    });
    expect(rejected.status()).toBe(409);
    expect((await rejected.json()).error).toContain('分支');
  } finally {
    await f.cleanup();
  }
});

test('a search URL for an uncached message waits for a fresh authoritative snapshot when revisiting a conversation', async ({
  page,
}) => {
  const f = await branchingFixture(page.request),
    m = f.messages;
  let release = () => {};
  try {
    await page.goto(`/c/${f.id}?branch=${m[3].id}`);
    await expect(at(page, m[3].id)).toBeVisible();
    await page.getByRole('button', { name: '开启新对话', exact: true }).click();
    await expect(page).toHaveURL('/');
    const text = `远端新增版本${crypto.randomUUID()}`;
    const revised = await page.request
      .patch(`/api/conversations/${f.id}/messages/${m[4].id}`, {
        headers,
        data: { requestId: crypto.randomUUID(), content: text },
      })
      .then((response) => response.json());
    await page.getByRole('button', { name: '全局搜索', exact: true }).click();
    await page.getByRole('combobox', { name: '搜索对话', exact: true }).fill('远端新增版本');
    const result = page.getByRole('region', { name: '正文搜索结果' }).getByRole('link');
    await expect(result).toHaveCount(1);
    const shadow = await page.request.patch(`/api/conversations/${f.id}/messages/${m[4].id}`, {
      headers,
      data: { requestId: crypto.randomUUID(), content: `${text.slice(0, -1)}X` },
    });
    expect(shadow.status()).toBe(201);
    const full = await page.request.get(`/api/search?${new URLSearchParams({ q: text })}`);
    expect(full.status()).toBe(200);
    expect(
      (await full.json()).results.map((item: { messageId: string }) => item.messageId),
    ).toEqual([revised.messageId]);
    await page.getByRole('combobox', { name: '搜索对话', exact: true }).fill(text);
    await expect(result).toHaveCount(1);
    let waiting = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/conversations/${f.id}`, async (route) => {
      waiting = true;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    await result.click();
    await expect.poll(() => waiting).toBe(true);
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await expect(page).toHaveURL(`/c/${f.id}?branch=${revised.messageId}`);
    release();
    await expect(at(page, revised.messageId)).toContainText(text);
    await expect(page.getByText('该分支已不可用，已显示可用分支。', { exact: true })).toHaveCount(
      0,
    );
  } finally {
    release();
    await f.cleanup();
  }
});

test('an offline request whose parent was deleted retains its text and can be recovered from another branch', async ({
  page,
  context,
}) => {
  const f = await branchingFixture(page.request),
    m = f.messages;
  try {
    await page.goto(`/c/${f.id}?branch=${m[3].id}`);
    await expect(at(page, m[3].id)).toBeVisible();
    await context.setOffline(true);
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    await editor.fill('父节点失效仍保留的内容');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await at(page, m[1].id).getByRole('button', { name: '下一个回答版本', exact: true }).click();
    expect(
      (
        await page.request.delete(`/api/conversations/${f.id}/messages/${m[3].id}`, { headers })
      ).ok(),
    ).toBe(true);
    await context.setOffline(false);
    await expect(page.getByRole('status').filter({ hasText: '发送失败' })).toContainText(
      '找不到可继续的父消息',
    );
    await page.getByRole('button', { name: '编辑待发送消息', exact: true }).click();
    await expect(editor).toHaveValue('父节点失效仍保留的内容');
    await expect(editor).toBeFocused();
    await expect(page).toHaveURL(`/c/${f.id}?branch=${m[4].id}`);
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('everchat:pending')!)),
    ).toEqual([]);
    const resources = await page.request
      .post(`/api/__test/conversations/${f.id}/resources`, { headers, data: {} })
      .then((response) => response.json());
    expect(resources.calls).toBe(0);
  } finally {
    await context.setOffline(false);
    await f.cleanup();
  }
});

test('an unknown first submission outcome remains retryable and does not create a second version', async ({
  page,
}) => {
  const f = await branchingFixture(page.request);
  try {
    await page.goto(`/c/${f.empty}`);
    await page.route(
      `**/api/conversations/${f.empty}/messages`,
      async (route) => {
        await route.fetch();
        await route.abort('failed');
      },
      { times: 1 },
    );
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('首条消息结果未知');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('发送结果待确认', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByText('发送结果待确认', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    const saved = await page.request
      .get(`/api/conversations/${f.empty}`)
      .then((response) => response.json());
    expect(saved.messages).toHaveLength(2);
    const resources = await page.request
      .post(`/api/__test/conversations/${f.empty}/resources`, { headers, data: {} })
      .then((response) => response.json());
    expect(resources.calls).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test('long Markdown switches keep the navigation anchor and editing another branch retains its original parent', async ({
  page,
}) => {
  const f = await branchingFixture(page.request, true),
    m = f.messages;
  try {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`/c/${f.id}?branch=${m[3].id}`);
    await expect(at(page, m[1].id).locator('pre code')).toContainText('value79');
    await at(page, m[1].id).getByRole('button', { name: '下一个回答版本', exact: true }).click();
    const back = at(page, m[4].id).getByRole('button', { name: '上一个回答版本', exact: true });
    await expect(back).toBeInViewport();
    const top = (await back.boundingBox())!.y;
    await back.click();
    const forward = at(page, m[1].id).getByRole('button', { name: '下一个回答版本', exact: true });
    await expect(at(page, m[1].id).locator('pre code')).toContainText('value79');
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await expect(forward).toBeInViewport();
    await expect.poll(async () => (await forward.boundingBox())!.y).toBeCloseTo(top, 0);
    await at(page, m[2].id).getByRole('button', { name: '编辑提问', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '提问内容', exact: true });
    await expect(editor).toHaveValue('原分支追问');
    await editor.fill('绑定原追问的修改');
    await forward.click();
    await expect(at(page, m[2].id)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '返回原消息', exact: true })).toBeVisible();
    await expect(editor).toHaveCount(0);
    await page.getByRole('button', { name: '返回原消息', exact: true }).click();
    await expect(editor).toHaveValue('绑定原追问的修改');
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/conversations/${f.id}/messages`),
    );
    await page.getByRole('button', { name: '保存并重新生成', exact: true }).click();
    const response = await accepted,
      submission = await response.json();
    expect(response.request().postDataJSON()).toMatchObject({ revisionOf: m[2].id });
    expect(response.request().postDataJSON()).not.toHaveProperty('parentId');
    await expect(at(page, submission.assistantId)).toHaveAttribute('data-status', 'completed');
    const saved = await page.request
      .get(`/api/conversations/${f.id}`)
      .then((response) => response.json());
    expect(
      saved.messages.find((item: { id: string }) => item.id === submission.userId),
    ).toMatchObject({ parentId: m[1].id, revisionOf: m[2].id });
    expect(saved.messages.slice(0, 8)).toEqual(m);
  } finally {
    await f.cleanup();
  }
});
