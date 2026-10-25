import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as v from 'valibot';
import type { Env } from '../../../worker/http/env';
import { helpResultSchema } from '../../../worker/mcp/contracts';
import { serveMcp } from '../../../worker/mcp/handler';
import { mcpToolInputs } from '../../../worker/mcp/help';

for (const mode of ['auto', 'legacy'] as const) {
  test(`MCP help works without a configured provider and matches advertised tools (${mode})`, async () => {
    let revoked = false;
    const library = {
      async mcpAuthenticate(key: string) {
        return key === 'ec_mcp_help_test' && !revoked ? { keyId: 'test-key' } : null;
      },
      async mcpKeyExists() {
        return !revoked;
      },
    };
    // No catalog, conversation, generation or provider methods are available to the help tool.
    const env = { LIBRARY: { getByName: () => library } } as unknown as Env;
    const client = new Client(
      { name: 'help-test', version: '1.0.0' },
      { versionNegotiation: { mode } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('https://everchat.test/mcp'), {
      fetch: async (input, init) => serveMcp(new Request(input, init), env),
      requestInit: { headers: { Authorization: 'Bearer ec_mcp_help_test' } },
    });
    try {
      await client.connect(transport);
      const advertised = await client.listTools();
      const result = await client.callTool({ name: 'everchat_help', arguments: {} });
      assert.equal(result.isError, undefined);
      const help = v.parse(helpResultSchema, result.structuredContent);
      assert.deepEqual(
        help.tools.map(({ name }) => name).sort(),
        advertised.tools.map(({ name }) => name).sort(),
      );
      for (const tool of help.tools) {
        const actual = advertised.tools.find(({ name }) => name === tool.name)!;
        assert.equal(tool.description, actual.description);
        assert.deepEqual(tool.inputSchema, actual.inputSchema);
        for (const example of tool.examples)
          assert.equal(
            v.safeParse(mcpToolInputs[tool.name], example.arguments).success,
            true,
            `${tool.name}: ${example.description}`,
          );
      }
      const single = await client.callTool({
        name: 'everchat_help',
        arguments: { tool: 'everchat_chat' },
      });
      assert.deepEqual(
        v.parse(helpResultSchema, single.structuredContent).tools.map(({ name }) => name),
        ['everchat_chat'],
      );
      for (const arguments_ of [
        { tool: 'everchat_not_a_tool' },
        { tool: 'everchat_chat', apiKey: 'not-a-help-argument' },
      ]) {
        const invalid = await client.callTool({ name: 'everchat_help', arguments: arguments_ });
        assert.equal(invalid.isError, true);
      }
      const request = () =>
        new Request('https://everchat.test/mcp', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ec_mcp_help_test',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'everchat_help', arguments: {} },
          }),
        });
      const crossOrigin = request();
      crossOrigin.headers.set('Origin', 'https://another.example');
      assert.equal((await serveMcp(crossOrigin, env)).status, 403);
      const anonymous = request();
      anonymous.headers.delete('Authorization');
      assert.equal((await serveMcp(anonymous, env)).status, 401);
      revoked = true;
      assert.equal((await serveMcp(request(), env)).status, 401);
    } finally {
      await client.close();
    }
  });
}
