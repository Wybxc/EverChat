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
  helpInputSchema,
  helpResultSchema,
  McpError,
  modelsSchema,
  runSchema,
  contextGetSchema,
  contextResultSchema,
  usageGetSchema,
  usageResultSchema,
} from './contracts';
import { mcpHelp, mcpToolDescriptions } from './help';
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
          'everchat_help',
          {
            description: mcpToolDescriptions.everchat_help,
            inputSchema: schema(helpInputSchema),
            outputSchema: schema(helpResultSchema),
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
          },
          ({ tool }) => result(async () => mcpHelp(tool)),
        );
        server.registerTool(
          'everchat_models_list',
          {
            description: mcpToolDescriptions.everchat_models_list,
            inputSchema: schema(emptySchema),
            outputSchema: schema(modelsSchema),
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          () => result(() => service.models()),
        );
        server.registerTool(
          'everchat_chat',
          {
            description: mcpToolDescriptions.everchat_chat,
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
            description: mcpToolDescriptions.everchat_run_get,
            inputSchema: schema(getSchema),
            outputSchema: schema(runSchema),
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          (input) => result(() => service.get(input)),
        );
        server.registerTool(
          'everchat_run_context_get',
          {
            description: mcpToolDescriptions.everchat_run_context_get,
            inputSchema: schema(contextGetSchema),
            outputSchema: schema(contextResultSchema),
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          (input) => result(() => service.context(input)),
        );
        server.registerTool(
          'everchat_run_usage_get',
          {
            description: mcpToolDescriptions.everchat_run_usage_get,
            inputSchema: schema(usageGetSchema),
            outputSchema: schema(usageResultSchema),
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
          (input) => result(() => service.usage(input)),
        );
        server.registerTool(
          'everchat_run_cancel',
          {
            description: mcpToolDescriptions.everchat_run_cancel,
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
