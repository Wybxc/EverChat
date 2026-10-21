import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import type { GenericSchema } from 'valibot';
import type { Env } from '../http/env';
import { HttpError, json } from '../http/response';
import { authenticateMcp } from './auth';
import {
  cancelSchema,
  chatSchema,
  emptySchema,
  getSchema,
  McpError,
  modelsSchema,
  runSchema,
} from './contracts';
import { McpChatService } from './service';

function schema<T extends GenericSchema>(source: T) {
  const converted = toStandardJsonSchema(source),
    json = converted['~standard'].jsonSchema;
  return {
    '~standard': {
      ...converted['~standard'],
      jsonSchema: {
        input: (options: Parameters<typeof json.input>[0]) =>
          json.input({ ...options, libraryOptions: { errorMode: 'ignore' } }),
        output: (options: Parameters<typeof json.output>[0]) =>
          json.output({ ...options, libraryOptions: { errorMode: 'ignore' } }),
      },
    },
  };
}

export async function serveMcp(request: Request, env: Env) {
  const origin = new URL(request.url).origin;
  if (request.headers.has('Origin') && request.headers.get('Origin') !== origin)
    return json({ error: 'Cross-origin MCP requests are not allowed.' }, 403);
  try {
    const principal = await authenticateMcp(request, env);
    const handler = createMcpHandler(
      () => {
        const service = new McpChatService(env, principal, request.signal);
        const server = new McpServer({ name: 'EverChat', version: '1.0.0' });
        const result = async (action: () => Promise<object>) => {
          try {
            const value = await action();
            if (!(await env.LIBRARY.getByName('personal').mcpKeyExists(principal.keyId)))
              throw new McpError({
                code: 'MCP_KEY_REVOKED',
                message: 'This API key was revoked.',
                stage: 'authorization',
                retryable: false,
              });
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(value) }],
              structuredContent: value as Record<string, unknown>,
            };
          } catch (error) {
            const detail =
              error instanceof McpError
                ? error.detail
                : {
                    code: 'OUTCOME_UNKNOWN',
                    message:
                      'The operation could not be confirmed. For chat submissions, retry the original requestId and input; do not issue a new paid request.',
                    stage: 'transport',
                    retryable: true,
                  };
            return {
              isError: true,
              content: [{ type: 'text' as const, text: JSON.stringify(detail) }],
              structuredContent: { error: detail },
            };
          }
        };
        server.registerTool(
          'everchat_models_list',
          {
            description:
              'List enabled models and prompt presets. Use the exact stable model ref when calling everchat_chat. Provider endpoints and credentials remain private.',
            inputSchema: schema(emptySchema),
            outputSchema: schema(modelsSchema),
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          () => result(() => service.models()),
        );
        server.registerTool(
          'everchat_chat',
          {
            description:
              'Create a normal saved conversation, or continue from an explicit continuation returned by an earlier answer. Supply a UUID requestId; transport retries MUST reuse the same requestId and original arguments. A new requestId intentionally generates again and may incur costs. Waits are bounded; pending generations continue in the background. Poll with everchat_run_get. presetId and systemPrompt are mutually exclusive.',
            inputSchema: schema(chatSchema),
            outputSchema: schema(runSchema),
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true,
            },
          },
          (input) => result(() => service.chat(input)),
        );
        server.registerTool(
          'everchat_run_get',
          {
            description:
              'Get your own run, optionally wait up to 20 seconds. When output.hasMore is true, call again with output.nextCursor as outputCursor until false. Reasoning is opt-in and separately paginated with reasoningCursor. Disconnecting or ending a wait does not cancel generation.',
            inputSchema: schema(getSchema),
            outputSchema: schema(runSchema),
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          (input) => result(() => service.get(input)),
        );
        server.registerTool(
          'everchat_run_cancel',
          {
            description:
              'Explicitly cancel your own generation. Saved partial output remains in the normal conversation. Cancellation is idempotent; completed answers are unchanged.',
            inputSchema: schema(cancelSchema),
            outputSchema: schema(runSchema),
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          ({ runRef }) => result(() => service.cancel(runRef)),
        );
        return server;
      },
      { maxRequestBodySize: 2 * 1024 * 1024 },
    );
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (error instanceof HttpError)
      return json(
        { error: error.message, code: error.code },
        error.status,
        error.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="EverChat MCP"' } : undefined,
      );
    return json({ error: 'MCP is temporarily unavailable.' }, 503);
  }
}
