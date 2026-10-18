import { messageParts } from '../../../shared/conversation/content';
import type { Snapshot } from '../../../shared/streaming/protocol';
// Serve the production shell with read-only synthetic API data; DO behavior is covered by the main E2E suite.
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startCloudflareAssets } from './cloudflare-assets';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { preparePwaBuilds } from './pwa-builds';

const builds = await preparePwaBuilds();
const temporary = await mkdtemp(resolve(tmpdir(), 'everchat-assets-'));
const stopAssets = await startCloudflareAssets(builds.a, temporary);
let root = builds.a;
let failSettings = false,
  failAsset = false,
  failSw = false;
let swMode: 'normal' | 'html' | 'redirect' = 'normal';
let swDelay = 0;
let assetDelay = 0;
let swRequests = 0;
let moduleResponse: 'normal' | 'html' | 'redirect' | 'failure' = 'normal';
let richMarkdown = false;
const optionalAsset =
  '/assets/' +
  (await readdir(resolve(builds.a, 'assets'))).find(
    (name) => name.startsWith('mermaid-parser.core-') && name.endsWith('.js'),
  )!;
const defaultProviderSettings = () => ({
  providers: [],
  activeProviderId: null,
  activeModel: '',
  systemPrompt: '',
  maxOutputTokens: null,
});
let providerSettings = defaultProviderSettings();
const conversationId = '00000000-0000-4000-8000-000000000101';
const title = '离线 URL 验证';
const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:5175');
  const path = url.pathname;
  const json = (data: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  if (
    path === '/__test/pwa/build' &&
    request.method === 'POST' &&
    request.headers.origin === 'http://127.0.0.1:5175'
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as {
      version?: 'a' | 'b';
      failSettings?: boolean;
      failAsset?: boolean;
      failSw?: boolean;
      swMode?: typeof swMode;
      swDelay?: number;
      assetDelay?: number;
      moduleResponse?: typeof moduleResponse;
      richMarkdown?: boolean;
      resetSettings?: boolean;
    };
    if (input.version) root = builds[input.version];
    if (input.failSettings !== undefined) failSettings = input.failSettings;
    if (input.failAsset !== undefined) failAsset = input.failAsset;
    if (input.failSw !== undefined) failSw = input.failSw;
    if (input.swMode !== undefined) swMode = input.swMode;
    if (input.swDelay !== undefined) swDelay = input.swDelay;
    if (input.assetDelay !== undefined) assetDelay = input.assetDelay;
    if (input.moduleResponse !== undefined) moduleResponse = input.moduleResponse;
    if (input.richMarkdown !== undefined) richMarkdown = input.richMarkdown;
    if (input.resetSettings) providerSettings = defaultProviderSettings();
    return json({ ok: true, swRequests, optionalAsset });
  }
  if (path === '/api/settings/providers') {
    if (request.method === 'PUT') {
      if (failSettings) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"Fixture settings failure"}');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      providerSettings = JSON.parse(Buffer.concat(chunks).toString()) as typeof providerSettings;
    }
    return json(providerSettings);
  }
  if (path.startsWith('/auth/') || path.startsWith('/cdn-cgi/access/')) {
    response.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    response.end('Access network boundary');
    return;
  }
  if (path === '/api/session')
    return json({
      authenticated: true,
      identity: {
        issuer: 'http://everchat.local.invalid',
        sub: 'local-developer',
        email: 'developer@everchat.local',
      },
      logoutUrl: '/cdn-cgi/access/logout',
      attachmentsConfigured: false,
      provider: '',
      model: '',
      models: [],
    });
  if (path === '/api/settings/presets') return json([]);
  if (path === '/api/conversations')
    return json({
      conversations: [{ id: conversationId, title, createdAt: 1, updatedAt: 1, pinned: false }],
      deletions: [],
      activity: {},
      deletionCursor: 0,
      hasMoreDeletions: false,
    });
  if (path === `/api/conversations/${conversationId}`) {
    const snapshot: Snapshot = {
      seq: 1,
      messages: [
        {
          id: 'user',
          role: 'user',
          parts: messageParts(title),
          status: 'completed',
          createdAt: 1,
          runId: null,
          parentId: null,
          revisionOf: null,
          error: null,
        },
        {
          id: 'assistant',
          role: 'assistant',
          parts: messageParts(
            richMarkdown
              ? [
                  '**按需模块**：$E=mc^2$',
                  '```javascript\nconst cached = 42;\n```',
                  '```mermaid\ngraph LR\nA[启动] --> B[按需缓存]\n```',
                ].join('\n\n')
              : '**已保存的正文**\n\n行内 $E=mc^2$。\n\n\\[\n\\frac{1}{2}\n\\]',
            richMarkdown ? '' : '**已保存的思考** \\(a+b\\)',
          ),
          status: 'completed',
          createdAt: 2,
          runId: 'run',
          parentId: 'user',
          revisionOf: null,
          error: null,
        },
      ],
    };
    return json(url.searchParams.has('after') ? { snapshot, after: 2, done: true } : snapshot);
  }
  if (path.startsWith('/api/')) {
    response.writeHead(404);
    response.end();
    return;
  }
  if (path === '/sw.js') {
    swRequests++;
    if (swDelay) await new Promise((resolve) => setTimeout(resolve, swDelay));
  }
  if (assetDelay && path === '/icon-512.png')
    await new Promise((resolve) => setTimeout(resolve, assetDelay));
  if (path === optionalAsset && moduleResponse !== 'normal') {
    response.writeHead(
      moduleResponse === 'redirect' ? 302 : moduleResponse === 'failure' ? 503 : 200,
      {
        'Content-Type': 'text/html',
        ...(moduleResponse === 'redirect' ? { Location: '/cdn-cgi/access/login' } : {}),
      },
    );
    response.end('<html>Authentication or unavailable</html>');
    return;
  }
  if (path === '/sw.js' && swMode !== 'normal') {
    response.writeHead(swMode === 'html' ? 200 : 302, {
      'Content-Type': 'text/html',
      ...(swMode === 'redirect' ? { Location: '/cdn-cgi/access/login' } : {}),
    });
    response.end('<html>Authentication</html>');
    return;
  }
  if ((failSw && path === '/sw.js') || (failAsset && path === '/icon-512.png')) {
    response.writeHead(503);
    response.end('Fixture static resource failure');
    return;
  }
  const file = resolve(root, `.${decodeURIComponent(path)}`);
  if (!file.startsWith(`${root}${sep}`) && file !== root) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const source = path === '/' || !extname(path) ? resolve(root, 'index.html') : file;
    const body = await readFile(source);
    response.writeHead(200, {
      'Content-Type': types[extname(source)] ?? 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
server.on('upgrade', (_request, socket) => socket.destroy());
server.listen(5175, '127.0.0.1');
const close = () =>
  server.close(
    () =>
      void stopAssets()
        .then(() => rm(temporary, { recursive: true, force: true }))
        .then(() => builds.dispose())
        .finally(() => process.exit(0)),
  );
process.on('SIGTERM', close);
process.on('SIGINT', close);
