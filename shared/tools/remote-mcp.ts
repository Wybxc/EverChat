import * as v from 'valibot';

export const REMOTE_MCP_TOOL = 'remote_mcp';
export const MAX_REMOTE_MCP_CALLS = 6;
export const MAX_REMOTE_MCP_ARG_BYTES = 8192;
const encoder = new TextEncoder();
const id = v.pipe(v.string(), v.uuid());
const text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
const token = v.pipe(v.string(), v.minLength(1), v.maxLength(4096), v.regex(/^[\x21-\x7e]+$/));
const name = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_.-]{1,128}$/));
export function remoteMcpEndpoint(value: string): boolean {
  if (value.length > 1200 || /[\\\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname;
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      !url.search &&
      /^[a-z\d][a-z\d.-]*\.[a-z]{2,}$/i.test(host) &&
      host
        .split('.')
        .every(
          (label) =>
            label.length > 0 &&
            label.length <= 63 &&
            !label.startsWith('-') &&
            !label.endsWith('-'),
        ) &&
      !/(?:^|\.)(?:localhost|local|internal|lan|invalid|test|arpa|onion)$/i.test(host)
    );
  } catch {
    return false;
  }
}
export const remoteMcpConnectionSchema = v.strictObject({
  name: text(80),
  endpoint: v.pipe(text(1200), v.check(remoteMcpEndpoint)),
  token: v.optional(v.nullable(token)),
});
export type RemoteMcpConnectionInput = v.InferOutput<typeof remoteMcpConnectionSchema>;
export type RemoteMcpConnection = Omit<RemoteMcpConnectionInput, 'token'> & {
  id: string;
  revision: string;
  hasToken: boolean;
};

const boundedObject = v.pipe(
  v.record(v.string(), v.unknown()),
  v.check((value) => encoder.encode(JSON.stringify(value)).length <= MAX_REMOTE_MCP_ARG_BYTES),
);
export const remoteMcpToolSchema = v.strictObject({
  name,
  title: text(180),
  description: v.pipe(v.string(), v.maxLength(500)),
  readOnly: v.boolean(),
  inputSchema: v.pipe(
    v.string(),
    v.check((json) => encoder.encode(json).length <= MAX_REMOTE_MCP_ARG_BYTES),
  ),
});
export type RemoteMcpTool = v.InferOutput<typeof remoteMcpToolSchema>;
export interface RemoteMcpCatalog {
  connection: RemoteMcpConnection;
  tools: RemoteMcpTool[];
}
export const remoteMcpSelectionsSchema = v.pipe(
  v.array(
    v.strictObject({
      id,
      revision: id,
      tools: v.pipe(
        v.array(name),
        v.minLength(1),
        v.maxLength(8),
        v.check((tools) => new Set(tools).size === tools.length),
      ),
    }),
  ),
  v.maxLength(2),
  v.check((connections) => new Set(connections.map(({ id }) => id)).size === connections.length),
);
export type RemoteMcpSelection = v.InferOutput<typeof remoteMcpSelectionsSchema>[number];
export type ResolvedRemoteMcp = Omit<RemoteMcpConnection, 'hasToken'> & { tools: RemoteMcpTool[] };

export const remoteMcpCallSchema = v.strictObject({
  connection: id,
  tool: name,
  arguments: boundedObject,
});
export type RemoteMcpCall = v.InferOutput<typeof remoteMcpCallSchema>;
export const remoteMcpApprovalSchema = v.strictObject({ approve: v.boolean() });
export const remoteMcpDecisionSchema = v.strictObject({
  endpoint: v.pipe(text(1200), v.check(remoteMcpEndpoint)),
  title: text(180),
});
