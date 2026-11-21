import * as v from 'valibot';
import type { ProviderConfig } from '../providers/types';
import { AppError, problem } from '../errors/descriptor';

export const SERVER_TOOL_KINDS = [
  'web-search',
  'web-fetch',
  'file-search',
  'code-execution',
  'image-generation',
  'shell',
] as const;
export type ServerToolKind = (typeof SERVER_TOOL_KINDS)[number];
export type ServerToolVendor = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'openrouter';
export interface ServerToolCapability {
  vendor: ServerToolVendor;
  tool: ServerToolKind;
  wireName: string;
  resources?: 'vector-stores' | 'file-search-stores';
}

const toolKind = v.picklist(SERVER_TOOL_KINDS);
const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const resources = v.pipe(
  v.array(v.pipe(identifier, v.regex(/^(?:vs_[a-zA-Z0-9_-]+|fileSearchStores\/[a-zA-Z0-9_-]+)$/))),
  v.minLength(1),
  v.maxLength(2),
  v.check((ids) => new Set(ids).size === ids.length),
);
export const serverToolSelectionSchema = v.variant('tool', [
  ...(['web-search', 'web-fetch', 'code-execution', 'image-generation', 'shell'] as const).map(
    (tool) => v.strictObject({ tool: v.literal(tool) }),
  ),
  v.strictObject({ tool: v.literal('file-search'), resources }),
]);
export type ServerToolSelection = v.InferOutput<typeof serverToolSelectionSchema>;

export const modelServerToolsSchema = v.pipe(
  v.array(
    v.strictObject({
      providerId: v.pipe(v.string(), v.uuid()),
      model: identifier,
      tools: v.pipe(
        v.array(serverToolSelectionSchema),
        v.minLength(1),
        v.maxLength(SERVER_TOOL_KINDS.length),
        v.check((tools) => new Set(tools.map(({ tool }) => tool)).size === tools.length),
      ),
    }),
  ),
  v.maxLength(12),
  v.check(
    (models) =>
      new Set(models.map(({ providerId, model }) => JSON.stringify([providerId, model]))).size ===
      models.length,
  ),
);
export type ModelServerTools = v.InferOutput<typeof modelServerToolsSchema>[number];
export type ResolvedServerTool = ServerToolCapability & { resourceIds?: string[] };
type Model = Pick<ProviderConfig, 'baseUrl' | 'provider' | 'model'>;

export function serverToolCatalog({ baseUrl, provider, model }: Model): ServerToolCapability[] {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return [];
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return [];
  const host = url.hostname;
  const add = (
    vendor: ServerToolVendor,
    definitions: [ServerToolKind, string, ServerToolCapability['resources']?][],
  ) =>
    definitions.map(([tool, wireName, resources]) => ({
      vendor,
      tool,
      wireName,
      ...(resources ? { resources } : {}),
    }));
  if (host === 'api.openai.com' && provider === 'openai-responses') {
    if (
      !/^gpt-(?:4\.1|5(?:\.[1-6])?|6(?:\.[12])?)(?:-(?:mini|nano|pro|sol|luna|astra|terra))?(?:-\d{4}-\d\d-\d\d)?$/.test(
        model,
      )
    )
      return [];
    return add('openai', [
      ['web-search', 'web_search'],
      ['file-search', 'file_search', 'vector-stores'],
      ['code-execution', 'code_interpreter'],
      ...(/^gpt-(?:5\.[1-6]|6(?:\.1)?)(?!.*-nano)(?:-|$)/.test(model)
        ? ([['shell', 'shell']] as const).map(([kind, name]): [ServerToolKind, string] => [
            kind,
            name,
          ])
        : []),
    ]);
  }
  if (host === 'api.anthropic.com' && provider === 'anthropic') {
    if (
      !/^claude-(?:(?:opus|sonnet|haiku)-4(?:[.-]\d+)?|(?:opus|sonnet|haiku|fable|mythos)-5(?:[.-]\d+)?)(?:-\d{8})?$/.test(
        model,
      )
    )
      return [];
    return add('anthropic', [
      ['web-search', 'web_search_20250305'],
      ['web-fetch', 'web_fetch_20250910'],
      ['code-execution', 'code_execution_20250825'],
    ]);
  }
  if (host === 'generativelanguage.googleapis.com' && provider === 'gemini') {
    if (
      !/^gemini-(?:2\.5-(?:pro|flash(?:-lite)?)|3(?:\.(?:1|5|6|7|8))?-(?:pro|flash(?:-lite)?)|4-(?:hydrogen|carbon|argon|neon))(?:-preview(?:-\d\d-\d\d)?)?$/.test(
        model,
      )
    )
      return [];
    const fileSearch = model !== 'gemini-2.5-flash';
    return add('google', [
      ['web-search', 'google_search'],
      ['web-fetch', 'url_context'],
      ...(fileSearch
        ? [['file-search', 'file_search', 'file-search-stores'] as const].map(
            ([tool, name, resources]): [
              ServerToolKind,
              string,
              ServerToolCapability['resources'],
            ] => [tool, name, resources],
          )
        : []),
      ['code-execution', 'code_execution'],
    ]);
  }
  if (host === 'api.deepseek.com' && provider !== 'gemini') {
    if (model === 'deepseek-flash')
      return add('deepseek', [
        ['web-search', 'deepseek_web_search'],
        ['web-fetch', 'deepseek_read_url'],
      ]);
    if (model === 'deepseek-v4-pro' && provider === 'openai-responses')
      return add('deepseek', [['web-search', 'web_search']]);
  }
  if (host === 'openrouter.ai' && provider === 'openai-chat' && model.includes('/'))
    return add('openrouter', [
      ['web-search', 'openrouter:web_search'],
      ['web-fetch', 'openrouter:web_fetch'],
    ]);
  return [];
}

export function selectedModelServerTools(
  model: { providerId?: string; model: string },
  selections?: readonly ModelServerTools[],
) {
  return (
    selections?.find((item) => item.providerId === model.providerId && item.model === model.model)
      ?.tools ?? []
  );
}

export function resolveServerTools(
  model: Model & { providerId?: string },
  selections?: readonly ModelServerTools[],
): ResolvedServerTool[] {
  const tools = selectedModelServerTools(model, selections);
  if (!tools.length) return [];
  const catalog = serverToolCatalog(model);
  if (
    model.provider === 'gemini' &&
    tools.length > 1 &&
    tools.some(({ tool }) => tool === 'file-search')
  )
    throw new AppError(problem('TOOL_INVALID'), 'Gemini 文件检索需单独使用。');
  return tools.map((selection) => {
    const capability = catalog.find(({ tool }) => tool === selection.tool);
    if (!capability)
      throw new AppError(
        problem('MODEL_TOOLS_UNSUPPORTED'),
        '所选供应商和模型不支持此服务端工具。',
      );
    if (selection.tool !== 'file-search') return capability;
    const prefix = capability.resources === 'vector-stores' ? 'vs_' : 'fileSearchStores/';
    if (!selection.resources.every((id) => id.startsWith(prefix)))
      throw new AppError(problem('TOOL_INVALID'), '文件检索资源与当前供应商不匹配。');
    return { ...capability, resourceIds: selection.resources };
  });
}

const httpUrl = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.check((value) => {
    try {
      const parsed = new URL(value);
      return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }),
);
export const serverToolSourceSchema = v.strictObject({
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
  url: v.optional(httpUrl),
});
export type ServerToolSource = v.InferOutput<typeof serverToolSourceSchema>;
export const serverToolActivitySchema = v.pipe(
  v.array(
    v.strictObject({
      id: identifier,
      tool: toolKind,
      vendor: v.picklist(['openai', 'anthropic', 'google', 'deepseek', 'openrouter']),
      status: v.picklist(['running', 'completed', 'failed', 'interrupted']),
      sources: v.pipe(v.array(serverToolSourceSchema), v.maxLength(16)),
      count: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
    }),
  ),
  v.maxLength(32),
);
export type ServerToolActivity = v.InferOutput<typeof serverToolActivitySchema>[number];

export function mergeServerToolActivity(
  earlier?: readonly ServerToolActivity[],
  current?: readonly ServerToolActivity[],
) {
  if (!earlier?.length && !current?.length) return;
  return [
    ...new Map([...(earlier ?? []), ...(current ?? [])].map((entry) => [entry.id, entry])).values(),
  ].slice(0, 32);
}
