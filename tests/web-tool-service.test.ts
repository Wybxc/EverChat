import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeWebTool, WEB_TOOL_RESPONSE_BYTES, type WebToolFetch } from '../worker/web-tools/service';
import type { WebToolServiceConfig } from '../shared/web-tools/service';
import type { WebToolCall } from '../shared/web-tools/tasks';

const config: WebToolServiceConfig = { provider: 'tavily', apiKey: 'tvly-unit-private-key', dailyLimit: 20 };
const search: WebToolCall = { id: 'search-0', name: 'web_search', input: { query: 'Cloudflare 资料🙂' } };
const webpage: WebToolCall = { id: 'page-0', name: 'read_webpage', input: { url: 'https://developers.cloudflare.com/' } };
const source = { title: '官方文档🙂', url: webpage.input.url, content: '本地参考资料🙂' };
const json = (value: unknown) => Response.json(value);
const run = (response: Response, call: WebToolCall = search) => executeWebTool(config, call, new AbortController().signal, async () => response);

test('Tavily requests pin the fixed credential origin, disable redirects and expensive automatic options, and extract one text URL', async () => {
  const fetcher: WebToolFetch = async (request) => {
    assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'manual');
    assert.equal(request.headers.get('Authorization'), `Bearer ${config.apiKey}`);
    const body = await request.json();
    if (request.url.endsWith('/search')) {
      assert.equal(request.url, 'https://api.tavily.com/search');
      assert.deepEqual(body, { query: search.input.query, topic: 'general', search_depth: 'basic', max_results: 5,
        auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false, include_favicon: false });
      return json({ results: [source] });
    }
    assert.equal(request.url, 'https://api.tavily.com/extract');
    assert.deepEqual(body, { urls: [webpage.input.url], extract_depth: 'basic', format: 'text', timeout: 10, include_images: false, include_favicon: false });
    return json({ results: [{ url: source.url, raw_content: source.content }], failed_results: [] });
  };
  assert.deepEqual(await executeWebTool(config, search, new AbortController().signal, fetcher), { id: search.id, name: search.name, status: 'completed', sources: [source] });
  assert.deepEqual(await executeWebTool(config, webpage, new AbortController().signal, fetcher), { id: webpage.id, name: webpage.name, status: 'completed',
    sources: [{ ...source, title: 'developers.cloudflare.com' }] });
});

test('search results cap five sources and a shared 12000-character budget without splitting a surrogate or returning control characters', async () => {
  const result = await run(json({ results: Array.from({ length: 7 }, (_, i) => ({ ...source, content: i ? '后续' : `\u0000${'🙂'.repeat(5999)}x🙂`, title: '标题'.repeat(300) })) }));
  assert.equal(result.status, 'completed');
  if (result.status !== 'completed') return;
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].content.length, 12000); assert.ok(result.sources[0].content.endsWith('\n[内容已截取]'));
  assert.equal(result.sources[0].title.length, 300); assert.doesNotMatch(JSON.stringify(result), /\\u0000/);
  assert.equal((await run(json({ results: Array(10).fill(source) }))).status, 'completed');
  const limited = await run(json({ results: Array(10).fill(source) }));
  if (limited.status === 'completed') assert.equal(limited.sources.length, 5);
});

test('empty search is a valid result while empty/failed HTTP 200 extraction is an explicit failure', async () => {
  assert.deepEqual(await run(json({ results: [] })), { id: search.id, name: search.name, status: 'completed', sources: [] });
  for (const value of [
    { results: [], failed_results: [] }, { results: [], failed_results: [{ url: webpage.input.url, error: config.apiKey }] },
    { results: [{ url: source.url, raw_content: ' ' }], failed_results: [] },
    { results: [{ url: source.url, raw_content: source.content }], failed_results: [{ error: config.apiKey }] },
  ]) { const result = await run(json(value), webpage); assert.equal(result.status, 'failed'); assert.doesNotMatch(JSON.stringify(result), /tvly-unit/); }
});

test('private URLs, credentials, malformed schemas and echoed service keys never become a source or public error', async () => {
  for (const value of [
    { results: [{ ...source, url: 'https://127.0.0.1/' }] }, { results: [{ ...source, url: 'https://user:pass@example.com/' }] },
    { results: [{ ...source, url: 'http://example.com/' }] }, { results: [{ ...source, content: config.apiKey }] },
    { results: [{ ...source, title: config.apiKey }] }, { results: [{ ...source, url: `https://example.com/?key=${config.apiKey}` }] },
    { results: [{ ...source, content: null }] }, { results: null }, [], { results: [null] },
  ]) { const result = await run(json(value)); assert.equal(result.status, 'failed'); assert.doesNotMatch(JSON.stringify(result), /tvly-unit|127\.0\.0\.1|user:pass/); }
  const quoted = 'tvly-"quoted-key"';
  assert.equal((await executeWebTool({ ...config, apiKey: quoted }, search, new AbortController().signal,
    async () => json({ results: [{ ...source, content: quoted }] }))).status, 'failed');
});

for (const status of [401, 403, 429, 432, 433, 500]) test(`HTTP ${status} is not retried and its raw error/key is never returned`, async () => {
  let count = 0;
  const result = await executeWebTool(config, search, new AbortController().signal, async () => { count++; return new Response(config.apiKey, { status }); });
  assert.equal(count, 1); assert.equal(result.status, 'failed'); assert.doesNotMatch(JSON.stringify(result), /tvly-unit/);
});

test('invalid input and absent credentials cannot start any request', async () => {
  let count = 0; const fetcher = async () => { count++; return json({ results: [] }); };
  await assert.rejects(() => executeWebTool(config, { ...webpage, input: { url: 'https://localhost/' } }, new AbortController().signal, fetcher));
  assert.equal((await executeWebTool({ ...config, apiKey: '' }, search, new AbortController().signal, fetcher)).status, 'failed');
  assert.equal(count, 0);
});

test('redirect responses are rejected without following their target or forwarding any credentials', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let requests = 0;
    const result = await executeWebTool(config, search, new AbortController().signal, async (request) => {
      requests++; assert.equal(request.url, 'https://api.tavily.com/search'); assert.equal(request.redirect, 'manual');
      return new Response(null, { status, headers: { Location: 'https://other.example/private' } });
    });
    assert.equal(result.status, 'failed'); assert.equal(requests, 1); assert.doesNotMatch(JSON.stringify(result), /other\.example|tvly-unit/);
  }
});

test('bounded JSON rejects oversized, wrongly encoded, non-JSON and redirected responses, and cancels the body', async () => {
  for (const response of [new Response('x', { headers: { 'content-type': 'text/html' } }), new Response('{', { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
    new Response('x', { headers: { 'content-type': 'application/json', 'content-length': String(WEB_TOOL_RESPONSE_BYTES + 1) } }),
    new Response(new Uint8Array(WEB_TOOL_RESPONSE_BYTES + 1), { headers: { 'content-type': 'application/json' } })]) assert.equal((await run(response)).status, 'failed');
  const redirected = json({ results: [source] }); Object.defineProperty(redirected, 'redirected', { value: true });
  assert.equal((await run(redirected)).status, 'failed');
  let cancelled = false;
  const tooBig = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(WEB_TOOL_RESPONSE_BYTES + 1)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  assert.equal((await run(tooBig)).status, 'failed'); assert.equal(cancelled, true);
});

test('a stalled response body is cancelled by the caller and pre-cancelled requests never fetch', async () => {
  const controller = new AbortController(); let cancelled = false;
  const result = executeWebTool(config, search, controller.signal, async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"results":[')); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }));
  await new Promise((resolve) => setTimeout(resolve, 5)); controller.abort();
  assert.equal((await result).status, 'failed'); assert.equal(cancelled, true);
  assert.equal((await executeWebTool(config, search, controller.signal, async () => { throw new Error('Must not fetch'); })).status, 'failed');
});

test('streaming JSON preserves fragmented UTF-8', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ results: [source] })); let index = 0;
  const result = await run(new Response(new ReadableStream({ pull(c) { if (index === bytes.length) c.close(); else c.enqueue(bytes.subarray(index, ++index)); } }), { headers: { 'content-type': 'application/json' } }));
  assert.equal(result.status, 'completed'); if (result.status === 'completed') assert.deepEqual(result.sources, [source]);
});
