import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as v from 'valibot';
import {
  remoteMcpEndpoint,
  remoteMcpToolSchema,
  type RemoteMcpTool,
} from '../../shared/tools/remote-mcp';

export type RemoteEndpoint = { endpoint: string; token?: string };
const MAX_RESPONSE_BYTES = 192 * 1024;
const MAX_REQUESTS = 16;

function redact(value: string, token?: string) {
  return (token ? value.replaceAll(token, '[隐藏]') : value).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    '',
  );
}

async function withSession<T>(
  config: RemoteEndpoint,
  perform: (client: Client, signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
) {
  if (!remoteMcpEndpoint(config.endpoint)) throw new Error('远程 MCP 服务地址无效。');
  const url = new URL(config.endpoint);
  const limit = AbortSignal.timeout(15_000);
  const signal = parentSignal ? AbortSignal.any([parentSignal, limit]) : limit;
  let requests = 0,
    called = false;
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { redirect: 'manual' },
    onInsufficientScope: 'throw',
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    async fetch(input, init) {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.href !== url.href || ++requests > MAX_REQUESTS)
        throw new Error('远程 MCP 请求超过连接范围。');
      if (typeof init?.body === 'string' && JSON.parse(init.body).method === 'tools/call') {
        if (called) throw new Error('同一工具调用已提交，不能重发。');
        called = true;
      }
      const headers = new Headers(init?.headers);
      if (config.token) headers.set('Authorization', `Bearer ${config.token}`);
      const response = await fetch(target, {
        ...init,
        headers,
        redirect: 'manual',
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
      if (!response.body) return response;
      let bytes = 0;
      return new Response(
        response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              if ((bytes += chunk.byteLength) > MAX_RESPONSE_BYTES) {
                controller.error(new Error('远程 MCP 响应超过保护大小。'));
                return;
              }
              controller.enqueue(chunk);
            },
          }),
        ),
        { status: response.status, headers: response.headers },
      );
    },
  });
  const client = new Client({ name: 'EverChat', version: '1.0.0' });
  try {
    await client.connect(transport, { signal });
    return await perform(client, signal);
  } finally {
    if (transport.sessionId && !signal.aborted) await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

export async function listRemoteMcpTools(config: RemoteEndpoint): Promise<RemoteMcpTool[]> {
  return withSession(config, async (client, signal) => {
    const tools = new Map<string, RemoteMcpTool>(),
      cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal });
      for (const item of result.tools) {
        const safeInput =
          config.token && JSON.stringify(item.inputSchema).includes(config.token)
            ? { type: 'object' }
            : item.inputSchema;
        const parsed = v.safeParse(remoteMcpToolSchema, {
          name: item.name,
          title: redact(item.title ?? item.annotations?.title ?? item.name, config.token)
            .trim()
            .slice(0, 180),
          description: redact(item.description ?? '', config.token).slice(0, 500),
          readOnly:
            item.annotations?.readOnlyHint === true && item.annotations?.destructiveHint !== true,
          inputSchema: JSON.stringify(safeInput),
        });
        if (!parsed.success || (config.token && item.name.includes(config.token))) continue;
        if (tools.has(parsed.output.name) || tools.size >= 100)
          throw new Error('远程 MCP 工具目录重复或过大。');
        tools.set(parsed.output.name, parsed.output);
      }
      const next = result.nextCursor;
      if (!next) return [...tools.values()];
      if (next.length > 1024 || cursors.has(next)) throw new Error('远程 MCP 工具目录分页无效。');
      cursors.add(next);
      cursor = next;
    }
    throw new Error('远程 MCP 工具目录超过分页上限。');
  });
}

export function callRemoteMcpTool(
  config: RemoteEndpoint,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return withSession(
    config,
    async (client, signal) => {
      const result = await client.callTool({ name, arguments: args }, { signal });
      const text = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
      const output = redact(
        text.join('\n') || JSON.stringify(result.structuredContent ?? {}),
        config.token,
      )
        .trim()
        .slice(0, 8192);
      return { output, isError: result.isError === true };
    },
    signal,
  );
}
