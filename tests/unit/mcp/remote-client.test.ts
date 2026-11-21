import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { callRemoteMcpTool, listRemoteMcpTools } from '../../../worker/remote-mcp/client';
import { remoteMcpEndpoint } from '../../../shared/tools/remote-mcp';

const connection = { endpoint: 'https://tools.example.org/mcp', token: 'scoped-fixture-token' };
const tool = (name: string, readOnlyHint: boolean) => ({
  name,
  description: `Fixture ${connection.token}`,
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint },
});
function upstream(t: TestContext, redirect = false) {
  const methods: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(url.href, connection.endpoint);
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${connection.token}`);
    assert.equal(init.redirect, 'manual');
    if (init.method !== 'POST') return new Response(null, { status: 405 });
    const request = JSON.parse(String(init.body));
    methods.push(request.method);
    if (redirect)
      return new Response(null, {
        status: 307,
        headers: { Location: 'https://unrelated.example.org/mcp' },
      });
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    switch (request.method) {
      case 'initialize':
        result = {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'Fixture', version: '1' },
        };
        break;
      case 'tools/list':
        result = request.params?.cursor
          ? { tools: [tool('update_note', false)] }
          : { tools: [tool('read_note', true)], nextCursor: 'next' };
        break;
      case 'tools/call':
        assert.deepEqual(request.params, { name: 'read_note', arguments: { id: 'fixture' } });
        result = { content: [{ type: 'text', text: `Value ${connection.token}` }] };
        break;
      default:
        throw new Error('Unexpected method ' + request.method);
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  });
  return methods;
}

test('remote MCP lists all pages, uses scoped credentials, and bounds public tool output', async (t) => {
  const methods = upstream(t);
  const tools = await listRemoteMcpTools(connection);
  assert.deepEqual(
    tools.map(({ name, readOnly }) => [name, readOnly]),
    [
      ['read_note', true],
      ['update_note', false],
    ],
  );
  assert.equal(methods.filter((method) => method === 'tools/list').length, 2);
  assert.doesNotMatch(JSON.stringify(tools), /scoped-fixture-token/);
  assert.deepEqual(await callRemoteMcpTool(connection, 'read_note', { id: 'fixture' }), {
    output: 'Value [隐藏]',
    isError: false,
  });
  assert.equal(methods.filter((method) => method === 'tools/call').length, 1);
});

test('remote MCP never forwards credentials to another URL', async (t) => {
  const methods = upstream(t, true);
  await assert.rejects(listRemoteMcpTools(connection));
  assert.ok(methods.length > 0);
  for (const url of [
    'http://tools.example.org/mcp',
    'https://127.0.0.1/mcp',
    'https://service.internal/mcp',
    'https://token@tools.example.org/mcp',
    'https://tools.example.org/mcp?token=secret',
  ])
    assert.equal(remoteMcpEndpoint(url), false);
});
