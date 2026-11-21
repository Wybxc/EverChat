import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import type { ToolSet } from 'ai';
import type { ProviderConfig } from '../../shared/providers/types';
import type { ResolvedServerTool } from '../../shared/tools/server-tools';

const MAX_SERVER_TOOL_CALLS = 4;

function sdkTool({ vendor, tool, resourceIds }: ResolvedServerTool) {
  switch (vendor) {
    case 'openai':
      switch (tool) {
        case 'web-search':
          return openai.tools.webSearch({ searchContextSize: 'medium' });
        case 'file-search':
          return openai.tools.fileSearch({ vectorStoreIds: resourceIds!, maxNumResults: 8 });
        case 'code-execution':
          return openai.tools.codeInterpreter();
        case 'image-generation':
          return openai.tools.imageGeneration({
            outputFormat: 'webp',
            quality: 'medium',
            partialImages: 1,
          });
        case 'shell':
          return openai.tools.shell({
            environment: { type: 'containerAuto', networkPolicy: { type: 'disabled' } },
          });
      }
      return;
    case 'anthropic':
      if (tool === 'web-search')
        return anthropic.tools.webSearch_20250305({ maxUses: MAX_SERVER_TOOL_CALLS });
      if (tool === 'web-fetch')
        return anthropic.tools.webFetch_20250910({
          maxUses: MAX_SERVER_TOOL_CALLS,
          maxContentTokens: 8000,
          citations: { enabled: true },
        });
      if (tool === 'code-execution') return anthropic.tools.codeExecution_20250825();
      return;
    case 'google':
      if (tool === 'web-search') return google.tools.googleSearch({});
      if (tool === 'web-fetch') return google.tools.urlContext({});
      if (tool === 'code-execution') return google.tools.codeExecution({});
      if (tool === 'file-search')
        return google.tools.fileSearch({ fileSearchStoreNames: resourceIds!, topK: 8 });
  }
}

export function sdkServerTools(config: ProviderConfig): ToolSet {
  const tools: ToolSet = {};
  for (const item of config.serverTools ?? []) {
    const definition = sdkTool(item);
    if (!definition) continue;
    // Anthropic maps the provider definition to its canonical native name.
    // The alias keeps a simultaneous EverChat web_search distinct in Core.
    const name = item.wireName === 'web_search' ? 'provider_web_search' : item.wireName;
    // Provider factories bind different input/output types. This is the
    // dynamic boundary where Core receives a heterogeneous tool registry.
    tools[name] = definition as unknown as ToolSet[string];
  }
  return tools;
}

export function addServerToolOptions(
  body: Record<string, unknown>,
  config: ProviderConfig,
  choice?: 'auto' | 'none',
) {
  const tools = config.serverTools ?? [];
  const vendor = tools[0]?.vendor;
  if (vendor === 'openai') body.max_tool_calls = MAX_SERVER_TOOL_CALLS;
  if (choice === 'none') return;
  if (vendor === 'deepseek' || vendor === 'openrouter')
    body.tools = [
      ...(Array.isArray(body.tools) ? body.tools : []),
      ...tools.map(({ wireName }) => ({
        type: wireName,
        ...(config.provider === 'anthropic' ? { name: wireName } : {}),
      })),
    ];
}
