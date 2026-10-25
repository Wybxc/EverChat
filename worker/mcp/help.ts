import { toJsonSchema } from '@valibot/to-json-schema';
import {
  cancelSchema,
  chatSchema,
  emptySchema,
  getSchema,
  helpInputSchema,
  MCP_TOOL_NAMES,
  type HelpResult,
  type McpToolName,
} from './contracts';

export const mcpToolInputs = {
  everchat_help: helpInputSchema,
  everchat_models_list: emptySchema,
  everchat_chat: chatSchema,
  everchat_run_get: getSchema,
  everchat_run_cancel: cancelSchema,
} as const;

export const mcpToolDescriptions = {
  everchat_help:
    'Get usage instructions, exact input schemas and examples for the available EverChat MCP tools. Omit tool for the full guide, or specify a tool name. Does not call a model or create a conversation.',
  everchat_models_list:
    'List enabled models and prompt presets. Use the exact stable model ref when calling everchat_chat. Provider endpoints and credentials remain private.',
  everchat_chat:
    'Create a normal saved conversation, or continue from an explicit continuation returned by an earlier answer. Supply a UUID requestId; transport retries MUST reuse the same requestId and original arguments. A new requestId intentionally generates again and may incur costs. Waits are bounded; pending generations continue in the background. Poll with everchat_run_get. presetId and systemPrompt are mutually exclusive.',
  everchat_run_get:
    'Get your own run and persisted partial output, optionally wait up to 20 seconds. Follow output.nextCursor while hasMore is true; at a running tail, save resumeCursor and poll from that position. completion.truncated signals a provider length limit, independent of paging. Reasoning is opt-in and separately paginated. Disconnecting or ending a wait does not cancel generation.',
  everchat_run_cancel:
    'Explicitly cancel your own generation. Saved partial output remains in the normal conversation. Cancellation is idempotent; completed answers are unchanged.',
} satisfies Record<McpToolName, string>;

const guides = {
  everchat_help: {
    examples: [
      { description: 'Read the full guide.', arguments: {} },
      {
        description: 'Read only the chat tool guide.',
        arguments: { tool: 'everchat_chat' },
      },
    ],
    notes: [
      'Only implemented tools are documented. Tool schemas are the authoritative input contract.',
    ],
  },
  everchat_models_list: {
    examples: [{ description: 'Discover callable models and presets.', arguments: {} }],
    notes: [
      'Use models[].ref as modelRef; a model name or provider model ID is not a substitute.',
      'Presets expose IDs and names, not system prompt contents. Provider credentials and endpoints are never returned.',
      'defaultModelRef is present only when an automation default model is configured.',
    ],
  },
  everchat_chat: {
    examples: [
      {
        description: 'Start a saved conversation. Replace the model ref and generate a fresh UUID.',
        arguments: {
          requestId: 'b60fbbac-edcf-43c6-9bf1-d1f1881ab2d5',
          modelRef: '<models[].ref>',
          prompt: 'List three implementation suggestions.',
          waitMs: 10000,
        },
      },
      {
        description: 'Continue from a returned answer position using a new request UUID.',
        arguments: {
          requestId: '58141c29-555e-410c-9d01-a33ca5dceae2',
          continuation: '<previous result.continuation>',
          prompt: 'Expand the second suggestion.',
          waitMs: 0,
        },
      },
    ],
    notes: [
      'For transport failures or an unknown outcome, retry the same requestId and original input. Only waitMs may change. A new requestId intentionally starts another potentially paid generation.',
      'Without continuation, this creates a normal saved conversation. Continuation identifies an exact answer position and only works for this API key. Wait for a usable answer before continuing.',
      'The first call needs modelRef unless an automation default is configured. A continuation inherits its prior model unless modelRef is supplied.',
      'presetId and systemPrompt are mutually exclusive. webSearch enables both search and page reading when a web service is configured. Capability-dependent parameters may be rejected by the selected model.',
      'waitMs defaults to 10000 and accepts 0–20000. accepted/running means generation continues in the background; use everchat_run_get with runRef and avoid tight polling.',
      'If the result error is SUBMISSION_UNCONFIRMED, retry everchat_chat with the same requestId and original input to finish admission; polling alone may not submit the generation.',
      'Only one generation may run in a conversation at a time. Attachments, temporary conversations and model JSON Schema output are not currently supported.',
    ],
  },
  everchat_run_get: {
    examples: [
      {
        description: 'Wait for an existing run and include reasoning when available.',
        arguments: { runRef: '<result.runRef>', waitMs: 10000, includeReasoning: true },
      },
      {
        description: 'Read the next body page without generating again.',
        arguments: {
          runRef: '<result.runRef>',
          outputCursor: '<result.output.nextCursor>',
          waitMs: 0,
        },
      },
      {
        description: 'Resume at a running tail after waiting for more saved content.',
        arguments: {
          runRef: '<result.runRef>',
          outputCursor: '<result.output.resumeCursor>',
          waitMs: 10000,
        },
      },
      {
        description: 'Read the next reasoning page using its independent cursor.',
        arguments: {
          runRef: '<result.runRef>',
          includeReasoning: true,
          reasoningCursor: '<result.reasoning.nextCursor>',
          waitMs: 0,
        },
      },
    ],
    notes: [
      'Querying a run never starts a new model request. Disconnecting or ending a wait does not cancel the generation.',
      'Append output.text and follow output.nextCursor as outputCursor while output.hasMore is true. Reasoning is opt-in and has its own hasMore/nextCursor and reasoningCursor.',
      'When hasMore is false and contentFinal is false, save resumeCursor and use it on a later poll to read only newly persisted text. Partial output may lag the live stream; polling never forces a checkpoint.',
      'A completed status does not mean the current page contains the whole answer. Read all remaining pages, including for interrupted, failed or cancelled runs with retained output.',
      'completion is null while running. completion.truncated=true means a provider length limit: finish reading the saved pages, then use a new requestId and explicit continuation if you want the model to continue. Re-reading the run never generates more. Unknown finish reasons and interrupted streams do not imply a length limit.',
      'Run statuses are accepted, running, completed, interrupted, failed and cancelled. Use a returned continuation only when it is available.',
      'Errors include code, stage and retryable. OUTCOME_UNKNOWN does not prove a model request was never sent; retry the original chat requestId and input rather than starting a new paid request.',
    ],
  },
  everchat_run_cancel: {
    examples: [{ description: 'Stop your own run.', arguments: { runRef: '<result.runRef>' } }],
    notes: [
      'Cancelling is explicit and idempotent. It does not delete the conversation or saved partial output, and it does not change a completed answer.',
      'Deleting an API key is not a cancellation request; already accepted generations can continue. Cancellation does not undo provider charges already incurred.',
    ],
  },
} satisfies Record<McpToolName, Pick<HelpResult['tools'][number], 'examples' | 'notes'>>;

export function mcpHelp(tool?: McpToolName): HelpResult {
  return {
    workflow: [
      'Discover models and presets with everchat_models_list.',
      'Call everchat_chat with a fresh UUID requestId, prompt and a modelRef or configured default.',
      'For accepted/running results, wait with everchat_run_get using runRef. Read all body and requested reasoning pages.',
      'Continue with everchat_chat using a new requestId and the returned continuation. Retry an unknown submission with its original requestId and input.',
      'Use everchat_run_cancel only when you intend to stop generation.',
    ],
    notes: [
      'All tools require an EverChat MCP Bearer API key. References locate objects but do not grant access. Each key can operate only on its own runs and continuation positions.',
      'Tool examples show arguments, not complete JSON-RPC requests. Replace reference placeholders with returned values and generate fresh UUIDs for new chat requests; do not reuse the illustrative UUIDs.',
      'Results are returned as structuredContent with a text JSON representation. Tool errors set isError and include an error object; run failures may instead appear in status and error.',
      'Help is read-only: it does not access provider settings, call a model or create a conversation.',
    ],
    tools: (tool ? [tool] : MCP_TOOL_NAMES).map((name) => ({
      name,
      description: mcpToolDescriptions[name],
      inputSchema: {
        ...toJsonSchema(mcpToolInputs[name], {
          target: 'draft-2020-12',
          typeMode: 'input',
          errorMode: 'ignore',
        }),
      },
      ...guides[name],
    })),
  };
}
