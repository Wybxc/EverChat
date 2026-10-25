import { toJsonSchema } from '@valibot/to-json-schema';
import {
  attachmentsPrepareSchema,
  attachmentsPutSchema,
  attachmentsGetSchema,
  attachmentsDeleteSchema,
} from './attachment-contracts';
import {
  cancelSchema,
  chatSchema,
  emptySchema,
  getSchema,
  helpInputSchema,
  MCP_TOOL_NAMES,
  contextGetSchema,
  usageGetSchema,
  conversationListSchema,
  conversationReadSchema,
  type HelpResult,
  type McpToolName,
} from './contracts';

export const mcpToolInputs = {
  everchat_help: helpInputSchema,
  everchat_models_list: emptySchema,
  everchat_chat: chatSchema,
  everchat_run_get: getSchema,
  everchat_run_cancel: cancelSchema,
  everchat_run_context_get: contextGetSchema,
  everchat_run_usage_get: usageGetSchema,
  everchat_conversations_list: conversationListSchema,
  everchat_conversation_read: conversationReadSchema,
  everchat_conversation_export: conversationReadSchema,
  everchat_attachments_prepare: attachmentsPrepareSchema,
  everchat_attachments_put: attachmentsPutSchema,
  everchat_attachments_get: attachmentsGetSchema,
  everchat_attachments_delete: attachmentsDeleteSchema,
} as const;

export const mcpToolDescriptions = {
  everchat_help:
    'Get usage instructions, exact input schemas and examples for the available EverChat MCP tools. Omit tool for the full guide, or specify a tool name. Does not call a model or create a conversation.',
  everchat_models_list:
    'List enabled models and prompt presets. Use the exact stable model ref when calling everchat_chat. Provider endpoints and credentials remain private.',
  everchat_chat:
    'Create a normal saved conversation, continue from an explicit continuation, or start a new independent/review discussion with an explicit source whitelist. Supply a UUID requestId; transport retries MUST reuse the same requestId and original arguments. A new requestId intentionally generates again and may incur costs. Waits are bounded; pending generations continue in the background. Poll with everchat_run_get. presetId and systemPrompt are mutually exclusive.',
  everchat_run_get:
    'Get your own run and persisted partial output, optionally wait up to 20 seconds. Follow output.nextCursor while hasMore is true; at a running tail, save resumeCursor and poll from that position. completion.truncated signals a provider length limit, independent of paging. Reasoning is opt-in and separately paginated. Disconnecting or ending a wait does not cancel generation.',
  everchat_run_cancel:
    'Explicitly cancel your own generation. Saved partial output remains in the normal conversation. Cancellation is idempotent; completed answers are unchanged.',
  everchat_run_context_get:
    'Read durable server input receipts for your own run, including selected sources, omissions, files, effective parameters and the adapted request fingerprint. Paginated manifest by default; text, metadata and exclusions are explicit views. Submission attempted does not prove provider receipt or model understanding. System prompt text requires explicit key permission; private provider continuation is never returned.',
  everchat_run_usage_get:
    'Read paginated model-step usage and cost estimates for your own answer. Returns null for unknown counters, evidence sources and immutable price-snapshot metadata. Does not recalculate prices, call a model or expose workspace totals.',
  everchat_conversations_list:
    'List normal conversations explicitly authorized for this API key. Conversations created by this key are granted automatically, including later website additions. Other keys and unrelated website conversations are excluded.',
  everchat_conversation_read:
    'Read one authorized conversation: use view=branches to discover branch heads, then specify headId for ordered, structured message records. Large bodies and attachment metadata continue across pages. A changed snapshot requires restarting the read; this never calls a model.',
  everchat_conversation_export:
    'Export a fixed authorized branch as paginated Markdown, preserving turns, model, time, attachment versions and summary boundaries. Concatenate text pages locally; reasoning and tools are opt-in. No original files or temporary download URLs are included.',
  everchat_attachments_prepare:
    'Prepare a batch of immutable private files in a new or explicitly continued normal conversation. Returns fixed-expiry R2 PUT URLs. Upload bytes with the exact signed headers, then call everchat_chat with uploadRef and selected attachmentRefs; no confirmation call is needed. Never send your EverChat key to R2.',
  everchat_attachments_put:
    'Save small actual UTF-8 text or canonical base64 files using MCP only. Reuse uploadId and identical bytes for retries. PDF extraction must be produced by the client. Does not call a model.',
  everchat_attachments_get:
    'Inspect files owned by this key, read bounded extracted-text previews, or explicitly read remaining fixed-expiry upload URLs. Metadata reads never accept uploads or start parsing. File refs do not grant access without the key.',
  everchat_attachments_delete:
    "Delete this key's unused files. Files referenced by a message or active task are protected. Deletion is idempotent; URL slots remain subject to expiry and delayed cleanup.",
} satisfies Record<McpToolName, string>;

const guides = {
  everchat_attachments_prepare: {
    examples: [
      {
        description: 'Prepare a Typst source file without compiling or following includes.',
        arguments: {
          uploadId: '00000000-0000-4000-8000-000000000001',
          files: [
            {
              clientFileId: '00000000-0000-4000-8000-000000000002',
              name: '1021.typ',
              mediaType: 'text/plain',
              purpose: 'document',
              size: 123,
              sha256: '0'.repeat(64),
            },
          ],
        },
      },
    ],
    notes: [
      'Normal workflow is prepare -> PUT original and optional PDF text slots -> chat. HTTP success does not prove model input readiness. File preparation does not call a model.',
      'Use exact signed headers, disable redirects, never attach EverChat/Access credentials, and do not log URLs. URL expiry is fixed and retries do not extend it. Reusing uploadId with different metadata or content is rejected.',
      'PDF pdfText declares the size/hash of the complete metadata-line + UTF-8-text stream (application/vnd.everchat.pdf-text). Client extraction uses the supported PDF.js version and source hash; Workers do not run PDF.js.',
      'Large batches return 16 file records per page. Follow nextCursor with everchat_attachments_get, the same uploadRef, and view=uploads to obtain remaining URLs. No additional confirmation is needed.',
    ],
  },
  everchat_attachments_put: {
    examples: [
      {
        description: 'Save a small actual source file with a server-computed hash.',
        arguments: {
          uploadId: '00000000-0000-4000-8000-000000000001',
          files: [
            {
              clientFileId: '00000000-0000-4000-8000-000000000002',
              name: '1021.typ',
              mediaType: 'text/plain',
              purpose: 'document',
              text: '= Background\nActual source text',
            },
          ],
        },
      },
    ],
    notes: [
      'Supply actual text or canonical padded dataBase64, never local paths or URLs. The total MCP request limit is 2 MiB; use direct PUT for larger files. PDF needs matching extraction data. Returned refs are immutable, not filename aliases.',
    ],
  },
  everchat_attachments_get: {
    examples: [
      {
        description: 'Inspect a batch without accepting or parsing files.',
        arguments: { uploadRef: '<prepare.uploadRef>' },
      },
      {
        description: 'Read an extracted-text preview.',
        arguments: { attachmentRef: '<file.attachmentRef>', view: 'text' },
      },
    ],
    notes: [
      'Metadata and text views are read-only. view=uploads explicitly signs already registered fixed-expiry slots without extending their lease. Text pages use UTF-8-byte cursors. Download original bytes with Bearer authentication at /mcp/attachments/<attachmentRef>; never send keys in query strings.',
    ],
  },
  everchat_attachments_delete: {
    examples: [
      {
        description: 'Delete unused files.',
        arguments: { attachmentRefs: ['<file.attachmentRef>'] },
      },
    ],
    notes: [
      'Used files return ATTACHMENT_IN_USE. Deleting a key immediately stops new use; already accepted normal messages remain. R2 PUT URLs cannot be immediately revoked, and late unused objects are cleaned after expiry plus grace.',
    ],
  },
  everchat_conversations_list: {
    examples: [{ description: 'Discover discussions this API key can read.', arguments: {} }],
    notes: [
      'A conversationRef is an address, not a capability. Every page checks authorization; revoking the API key stops subsequent access.',
    ],
  },
  everchat_conversation_read: {
    examples: [
      {
        description: 'Discover branch heads.',
        arguments: { conversationRef: '<conversation.ref>', view: 'branches' },
      },
      {
        description: 'Read an explicit branch.',
        arguments: {
          conversationRef: '<conversation.ref>',
          headId: '00000000-0000-4000-8000-000000000001',
        },
      },
    ],
    notes: [
      'Follow nextCursor with exactly the same head and options. Records include message headers, text fragments, JSON attachment fragments, summary coverage and optional public tools. Group fragments by messageId/channel (or attachment index), preserving order.',
      'BRANCH_ACTIVE requires waiting or includeActive=true; partial pages are durable watermarks, not complete answers. SNAPSHOT_CHANGED means restart without a cursor. The initial implementation conservatively invalidates on any conversation revision.',
      'Attachment JSON uses code-point offsets; message body offsets use UTF-16. Treat cursors as opaque. Deleted messages are tombstones, with no old text. Sibling answers never enter this branch.',
    ],
  },
  everchat_conversation_export: {
    examples: [
      {
        description: 'Export a branch by turns.',
        arguments: {
          conversationRef: '<conversation.ref>',
          headId: '00000000-0000-4000-8000-000000000001',
          fromRound: 1,
          toRound: 3,
        },
      },
    ],
    notes: [
      'Concatenate text from all pages verbatim. Read with the same head and options; do not append pages after SNAPSHOT_CHANGED. Export is read-only and never summarizes with a model.',
      'Only attachment metadata is exported. No API keys, presigned URLs, binary objects or provider private continuation are returned.',
    ],
  },
  everchat_run_usage_get: {
    examples: [
      {
        description: 'Read model-step token usage and cost estimates.',
        arguments: { runRef: '<result.runRef>' },
      },
      {
        description:
          'Sum model steps exactly by currency and list linked web-service costs separately.',
        arguments: { runRef: '<result.runRef>', view: 'costs' },
      },
    ],
    notes: [
      'Amounts are decimal currency strings with up to 12 decimal places, calculated from the recorded price snapshot. They are estimates, not supplier invoices; never add different currencies.',
      'view=costs sums across steps by kind and currency using integer arithmetic. amount is null unless its scope is fully priced; knownSubtotal preserves only known amounts. Chat is included in the answer total; web_search/read_webpage are related fees, separately listed. Title and summary exclusions are explicit. Follow cost pages with the same view; a changed ledger requires restarting.',
      'Scope is answer model steps. Automatic titles, summaries and web-service fees are excluded. Follow nextCursor to inspect every step; accounting may lag generation completion.',
      'Unknown token values are null. knownSubtotal is not a complete total when reportedSteps is less than expectedSteps. finalized means the task ended, independent of usage completeness.',
      'provider_reported preserves explicit zeros and native totals. derived identifies protocol normalization (Anthropic input components, Gemini prompt plus tool input or text plus thoughts, input minus cache, and output minus reasoning). A conflicting native total is preserved with inconsistent_usage.',
    ],
  },
  everchat_run_context_get: {
    examples: [
      {
        description: 'Read the first input step manifest.',
        arguments: { runRef: '<result.runRef>' },
      },
      {
        description: 'Read a message input item.',
        arguments: { runRef: '<result.runRef>', view: 'text', step: 0, item: 1 },
      },
      {
        description: 'Read omitted and summarized source IDs.',
        arguments: { runRef: '<result.runRef>', view: 'exclusions' },
      },
    ],
    notes: [
      'Follow nextCursor with the same runRef, view and item. Manifest pagination advances across model steps. Later steps inherit previousStepId and contain only new tool context.',
      'The receipt describes logical inputs and a fingerprint of the final serialized request; it never returns the HTTP body, credentials, images as base64 or private encrypted reasoning.',
      'System prompts are redacted by default. A website owner may grant readSystemPrompts to this key; only new requests retain effective prompt text, and disabling the permission immediately blocks reads. Old prompts are never reconstructed. New document inputs keep deduplicated private snapshots of the exact injected logical text; images expose verification metadata, not base64.',
      'Large item metadata is replaced by details=metadata_view. Read view=metadata with step/item to concatenate the exact JSON in bounded pages. textUnit identifies UTF-16 message text, Unicode-code-point metadata or UTF-8-byte document offsets; cursors remain opaque. Missing or deleted file snapshots return content_unavailable and are never rebuilt during a read.',
      'No receipt is invented for historical requests. pending means a selected request has not reached the submission boundary. Reads do not call a model or force checkpoints.',
    ],
  },
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
      {
        description:
          'Start an independent proposal from one verified user background, without prior answers.',
        arguments: {
          requestId: '00000000-0000-4000-8000-000000000003',
          modelRef: '<models[].ref>',
          prompt: 'Propose an independent solution.',
          discussion: {
            mode: 'independent',
            background: [{ messageRef: '<record.ref>', revision: 12, sha256: '0'.repeat(64) }],
          },
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
      'Only one generation may run in a conversation at a time. Temporary conversations and model JSON Schema output are not supported.',
      'Files: prepare -> R2 PUT -> chat, or attachments_put for small actual bytes. Pass uploadRef on the first request, attachments[{attachmentRef,mode}] to activate exact versions; a batch does not implicitly attach every file. PDF pageRanges are 1-based inclusive; text ranges are UTF-16 half-open.',
      'New replacements declare replaces=<old attachmentRef> when uploading to the same explicit continuation. mode=replace removes old material blocks only in this branch; include_both intentionally compares versions; reuse never silently switches an already active document version. Old answers may still discuss old material. Active files remain pinned across history trimming and summaries; oversized materials reject admission instead of being clipped.',
      'discussion starts a new normal conversation and is mutually exclusive with continuation and uploadRef/attachments. background accepts completed user message citations only. review additionally requires explicit completed answer targets. No parent chain, reasoning or derived summary is inherited. files contains already parsed, key-owned text attachmentRefs; exact bytes and version metadata are saved once as visible background text. Large backgrounds must fit the single-message/context budget; no silent clipping or automatic file compilation.',
      'Read conversation records first: use ref and revision, concatenate content text, compute its UTF-8 SHA-256 for sha256. Optional UTF-16 half-open range requires quoteHash of the exact selected text; review targets may also carry claimId. Changed revision/hash or invalid quote fails before generation. Quotes are evidence, not system instructions; selection cannot prove semantic independence or correctness.',
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
