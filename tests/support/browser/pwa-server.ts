import { messageParts } from '../../../shared/conversation/content';
// Serve the production shell with read-only synthetic API data; DO behavior is covered by the main E2E suite.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve('dist/client');
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
  const path = new URL(request.url ?? '/', 'http://127.0.0.1:5175').pathname;
  const json = (data: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
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
      conversations: [
        { id: conversationId, title, createdAt: 1, updatedAt: 1, pinned: false, archived: false },
      ],
      deletions: [],
      deletionCursor: 0,
      hasMoreDeletions: false,
    });
  if (path === `/api/conversations/${conversationId}`)
    return json({
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
            '**已保存的正文**\n\n行内 $E=mc^2$。\n\n\\[\n\\frac{1}{2}\n\\]',
            '**已保存的思考** \\(a+b\\)',
          ),
          status: 'completed',
          createdAt: 2,
          runId: 'run',
          parentId: 'user',
          revisionOf: null,
          error: null,
        },
      ],
    });
  if (path.startsWith('/api/')) {
    response.writeHead(404);
    response.end();
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
