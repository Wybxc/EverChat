import * as v from 'valibot';
import type { ConversationSettings } from '../conversation/types';
import type { ProviderConfig } from '../providers/types';
import { AppError, problem } from '../errors/descriptor';
import type { WebToolName } from './tasks';

export const SERVER_TOOL_KINDS = [
  'web-search',
  'web-fetch',
  'file-search',
  'code-execution',
  'image-generation',
  'shell',
  'advisor',
  'tool-search',
  'remote-mcp',
] as const;
export type ServerToolKind = (typeof SERVER_TOOL_KINDS)[number];
type CatalogTool = Exclude<ServerToolKind, 'remote-mcp'>;
export type ServerToolVendor = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'openrouter';
export const reportedServerToolsSchema = v.strictObject({
  'web-search': v.optional(v.boolean()),
  'code-execution': v.optional(v.boolean()),
  'web-fetch': v.optional(v.boolean()),
});
export type ReportedServerTools = v.InferOutput<typeof reportedServerToolsSchema>;
export const serverToolProbeKinds = ['web-search', 'web-fetch'] as const;
export type ServerToolProbeKind = (typeof serverToolProbeKinds)[number];
const probedAt = v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1)));
export const testedServerToolsSchema = v.strictObject({
  'web-search': probedAt,
  'web-fetch': probedAt,
});
export type TestedServerTools = v.InferOutput<typeof testedServerToolsSchema>;
export interface ServerToolCapability {
  vendor: ServerToolVendor;
  tool: CatalogTool;
  wireName: string;
  resources?: 'vector-stores' | 'file-search-stores';
  source?: 'provider' | 'tested';
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
  ...(
    [
      'web-search',
      'web-fetch',
      'code-execution',
      'image-generation',
      'shell',
      'advisor',
      'tool-search',
    ] as const
  ).map((tool) => v.strictObject({ tool: v.literal(tool) })),
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
type Model = Pick<
  ProviderConfig,
  'baseUrl' | 'provider' | 'model' | 'reportedServerTools' | 'testedServerTools'
>;

function documentedServerTools({
  baseUrl,
  provider,
  model,
  reportedServerTools,
}: Model): ServerToolCapability[] {
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
    definitions: [CatalogTool, string, ServerToolCapability['resources']?][],
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
      ['image-generation', 'image_generation'],
      ...(/^gpt-(?:5\.[1-6]|6(?:\.1)?)(?!.*-nano)(?:-|$)/.test(model)
        ? ([['shell', 'shell']] as const).map(([kind, name]): [CatalogTool, string] => [kind, name])
        : []),
    ]);
  }
  if (host === 'api.anthropic.com' && provider === 'anthropic') {
    const known =
      /^claude-(?:(?:opus|sonnet|haiku)-4(?:[.-]\d+)?|(?:opus|sonnet|haiku|fable|mythos)-5(?:[.-]\d+)?)(?:-\d{8})?$/.test(
        model,
      );
    return add('anthropic', [
      ['web-search', 'web_search_20250305'],
      ['web-fetch', 'web_fetch_20250910'],
      ['code-execution', 'code_execution_20250825'],
      ...(/^claude-(?:sonnet|haiku)-5(?:-5)?(?:-\d{8})?$/.test(model)
        ? ([['advisor', 'advisor_20260301']] as [CatalogTool, string][])
        : []),
      ...(/^claude-(?:opus|sonnet|haiku)-(?:4-5|4-6|4-7|4-8|5)(?:-\d+)?$/.test(model)
        ? ([['tool-search', 'tool_search_tool_bm25_20251119']] as [CatalogTool, string][])
        : []),
    ]).flatMap((entry): ServerToolCapability[] => {
      const reported = reportedServerTools?.[entry.tool as keyof ReportedServerTools];
      return reported === true
        ? [{ ...entry, source: 'provider' }]
        : reported === false || !known
          ? []
          : [entry];
    });
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
            ([tool, name, resources]): [CatalogTool, string, ServerToolCapability['resources']] => [
              tool,
              name,
              resources,
            ],
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

export function serverToolProbeCandidates(model: Model): ServerToolCapability[] {
  const catalogModel: Record<string, string> = {
    'https://api.openai.com': 'gpt-6.1-sol',
    'https://api.anthropic.com': 'claude-sonnet-4-6',
    'https://generativelanguage.googleapis.com': 'gemini-4-argon',
    'https://openrouter.ai': 'openai/gpt-6.1-sol',
    'https://api.deepseek.com': model.model === 'deepseek-v4-pro' ? model.model : 'deepseek-flash',
  };
  try {
    const known = catalogModel[new URL(model.baseUrl).origin];
    return known
      ? documentedServerTools({
          ...model,
          model: known,
          reportedServerTools: undefined,
        }).filter(({ tool }) => (serverToolProbeKinds as readonly string[]).includes(tool))
      : [];
  } catch {
    return [];
  }
}

export function serverToolCatalog(model: Model): ServerToolCapability[] {
  const documented = documentedServerTools(model);
  const tested = serverToolProbeCandidates(model)
    .filter(({ tool }) => Boolean(model.testedServerTools?.[tool as ServerToolProbeKind]))
    .map((entry): ServerToolCapability => ({ ...entry, source: 'tested' }));
  return [
    ...documented.filter(({ tool }) => !tested.some((entry) => entry.tool === tool)),
    ...tested,
  ];
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

export function canCombineServerAndLocalTools(model: Pick<Model, 'provider' | 'model'>) {
  return model.provider !== 'gemini' || !/^gemini-2\./.test(model.model);
}

export function preferredServerWebTools(
  model: Model & { providerId?: string },
  settings: Pick<ConversationSettings, 'serverTools' | 'remoteMcp'>,
  requested: readonly WebToolName[] = [],
) {
  if (!requested.length) return [];
  if (
    model.provider === 'gemini' &&
    selectedModelServerTools(model, settings.serverTools).some(({ tool }) => tool === 'file-search')
  )
    return [];
  if (
    !canCombineServerAndLocalTools(model) &&
    settings.remoteMcp?.some(({ executor }) => executor !== 'provider')
  )
    return [];
  return serverToolCatalog(model).filter(
    ({ tool }) =>
      (tool === 'web-search' && requested.includes('web_search')) ||
      (tool === 'web-fetch' && requested.includes('read_webpage')),
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
