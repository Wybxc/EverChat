import type { ProviderConfig } from '../../shared/providers/types';
import {
  hostedMcpLabel,
  hostedMcpVendor,
  providerMcpConnections,
  type ResolvedRemoteMcp,
} from '../../shared/tools/remote-mcp';
import { ProviderError } from '../generation/errors';

export interface HostedMcpCredential {
  id: string;
  token?: string;
}

export function addHostedMcp(
  config: ProviderConfig,
  init: RequestInit,
  credentials: readonly HostedMcpCredential[],
) {
  const connections = providerMcpConnections(config);
  if (!connections.length) return init;
  const vendor = hostedMcpVendor(config);
  if (!vendor || typeof init.body !== 'string')
    throw new ProviderError('当前模型接口无法配置供应商托管 MCP。');
  const payload = JSON.parse(init.body);
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const authorized = connections.map((connection) => {
    const credential = credentials.find(({ id }) => id === connection.id);
    if (!credential) throw new ProviderError('缺少已授权的 MCP 连接资料。');
    return { connection, token: credential.token, label: hostedMcpLabel(connection.id) };
  });
  if (vendor === 'openai') {
    payload.max_tool_calls ??= 4;
    payload.tools = [
      ...tools,
      ...authorized.map(({ connection, token, label }) => ({
        type: 'mcp',
        server_label: label,
        server_url: connection.endpoint,
        allowed_tools: connection.tools.map(({ name }) => name),
        require_approval: 'always',
        ...(token ? { authorization: token } : {}),
      })),
    ];
    return { ...init, body: JSON.stringify(payload) };
  }
  const defer = config.serverTools?.some(({ tool }) => tool === 'tool-search');
  payload.mcp_servers = authorized.map(({ connection, token, label }) => ({
    type: 'url',
    name: label,
    url: connection.endpoint,
    ...(token ? { authorization_token: token } : {}),
  }));
  payload.tools = [
    ...tools,
    ...authorized.map(({ connection, label }) => ({
      type: 'mcp_toolset',
      mcp_server_name: label,
      default_config: { enabled: false },
      configs: Object.fromEntries(
        connection.tools.map((tool) => [
          tool.name,
          { enabled: true, ...(defer ? { defer_loading: true } : {}) },
        ]),
      ),
    })),
  ];
  const headers = new Headers(init.headers);
  const betas = new Set(
    (headers.get('anthropic-beta') ?? '')
      .split(',')
      .map((beta) => beta.trim())
      .filter(Boolean),
  );
  betas.add('mcp-client-2025-11-20');
  headers.set('anthropic-beta', [...betas].join(','));
  return { ...init, headers, body: JSON.stringify(payload) };
}

export function hostedMcpTool(
  config: ProviderConfig,
  label: unknown,
  name: unknown,
):
  | {
      connection: ResolvedRemoteMcp;
      title: string;
    }
  | undefined {
  const connection = providerMcpConnections(config).find(
    (entry) => hostedMcpLabel(entry.id) === label,
  );
  const tool = connection?.tools.find((entry) => entry.name === name);
  return connection && tool ? { connection, title: tool.title } : undefined;
}
