import * as v from 'valibot';
import { branchPath } from '../conversation/branch-path';
import { messagePartsSchema, messageText } from '../conversation/content';
import { MAX_SYSTEM_PROMPT_LENGTH } from '../conversation/limits';
import { conversationSettingsSchema } from '../conversation/settings';
import {
  MAX_SUMMARIES,
  MAX_SUMMARY_CHARACTERS,
  summaryCoverageSchema,
} from '../conversation/summaries';
import { titleSettingsSchema, type TitleSettings } from '../conversation/titles';
import type { ConversationSettings, Message } from '../conversation/types';
import { AppError, problem } from '../errors/descriptor';
import { MAX_MODEL_TOKENS } from '../models/metadata';
import type { ProviderModel } from '../models/types';
import { promptPresetListSchema } from '../presets/schema';
import type { PromptPreset } from '../presets/types';
import { MAX_PROVIDER_MODELS } from '../providers/limits';
import { modelSchema } from '../providers/settings';
import type { ProviderApiKind } from '../providers/types';
import { addGenerationUsage, generationSchema } from '../streaming/generation';
import { publicToolTaskSchema, validReasoningBreaks } from '../web-tools/tasks';

export const BACKUP_FORMAT = 'everchat-backup';
export const BACKUP_VERSION = 1 as const;
export const MAX_BACKUP_BYTES = 12 * 1024 * 1024;
const MAX_BACKUP_MESSAGES = 1000;

interface BackupProvider {
  id: string;
  name: string;
  provider: ProviderApiKind;
  baseUrl: string;
  models: ProviderModel[];
}
export interface BackupSettings {
  title?: TitleSettings;
  providers: BackupProvider[];
  activeProviderId: string | null;
  activeModel: string;
  systemPrompt: string;
  maxOutputTokens: number | null;
  promptPresets: PromptPreset[];
}
export interface BackupMessage {
  id: string;
  role: Message['role'];
  parts: Message['parts'];
  status: Message['status'];
  createdAt: number;
  parentId: string | null;
  revisionOf: string | null;
  error: string | null;
  providerId: string | null;
  model: string | null;
  modelName: string | null;
  generation?: Message['generation'];
  summary?: Message['summary'];
  tools?: Message['tools'];
  deletedAt?: number | null;
}
export interface ConversationBackup {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: BackupMessage[];
  settings?: ConversationSettings;
}
export interface EverChatBackup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: number;
  conversation: ConversationBackup;
  settings: BackupSettings;
}

export function backupMessage(message: Message): BackupMessage {
  const partial = message.status === 'queued' || message.status === 'running';
  const generation =
    partial && message.streamState
      ? {
          ...message.generation,
          ...addGenerationUsage(message.tools?.round ? message.generation : undefined, {
            usage: message.streamState.usage,
            usageIsFinal: false,
          }),
        }
      : message.generation;
  return {
    id: message.id,
    role: message.role,
    parts: message.deletedAt ? [] : message.parts,
    status: partial ? 'failed' : message.status,
    createdAt: message.createdAt,
    parentId: message.parentId,
    revisionOf: message.revisionOf,
    error: message.deletedAt
      ? null
      : partial
        ? (message.error ?? '生成尚未完成，已保留已保存的部分内容。')
        : message.error,
    providerId: message.providerId ?? null,
    model: message.model ?? null,
    modelName: message.modelName ?? null,
    ...(!message.deletedAt && message.role === 'assistant' && generation ? { generation } : {}),
    ...(message.summary ? { summary: message.summary } : {}),
    ...(!message.deletedAt && message.tools
      ? {
          tools: partial
            ? {
                ...message.tools,
                status: 'failed' as const,
                calls: message.tools.calls.map((item) =>
                  ['queued', 'running'].includes(item.state)
                    ? { ...item, state: 'cancelled' as const }
                    : item,
                ),
              }
            : message.tools,
        }
      : {}),
    ...(message.deletedAt ? { deletedAt: message.deletedAt } : {}),
  };
}

const isString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
const nullableString = (value: unknown, max: number) => value === null || isString(value, max);
const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

export function validateBackup(value: unknown): EverChatBackup {
  if (!value || typeof value !== 'object')
    throw new AppError(problem('BACKUP_INVALID'), '备份文件格式无效。');
  const input = value as Record<string, unknown>,
    conversation = input.conversation as Record<string, unknown>;
  if (
    input.format !== BACKUP_FORMAT ||
    input.version !== BACKUP_VERSION ||
    !conversation ||
    typeof conversation !== 'object'
  )
    throw new AppError(problem('BACKUP_INVALID'), '备份文件版本不受支持。');
  if (!Number.isSafeInteger(input.exportedAt))
    throw new AppError(problem('BACKUP_INVALID'), '备份导出时间无效。');
  if (
    !isUuid(conversation.id) ||
    !isString(conversation.title, 80) ||
    !conversation.title.trim() ||
    !Number.isSafeInteger(conversation.createdAt) ||
    !Number.isSafeInteger(conversation.updatedAt)
  )
    throw new AppError(problem('BACKUP_INVALID'), '备份中的对话信息无效。');
  if (!Array.isArray(conversation.messages) || conversation.messages.length > MAX_BACKUP_MESSAGES)
    throw new AppError(problem('BACKUP_INVALID'), '备份中的消息数量无效。');
  const conversationSettings =
    conversation.settings === undefined
      ? undefined
      : v.safeParse(conversationSettingsSchema, conversation.settings);
  if (conversationSettings && !conversationSettings.success)
    throw new AppError(problem('BACKUP_INVALID'), '备份中的会话参数无效。');
  const messages = conversation.messages.map((raw) => {
    if (!raw || typeof raw !== 'object')
      throw new AppError(problem('BACKUP_INVALID'), '备份中的消息无效。');
    const message = raw as Record<string, unknown>;
    const parts = v.safeParse(messagePartsSchema, message.parts);
    const summary =
      message.summary === undefined
        ? undefined
        : v.safeParse(summaryCoverageSchema, message.summary);
    if (summary && (!summary.success || message.role !== 'assistant'))
      throw new AppError(problem('BACKUP_INVALID'), '备份中的摘要覆盖范围无效。');
    if (
      !isUuid(message.id) ||
      !['user', 'assistant'].includes(String(message.role)) ||
      !parts.success ||
      (message.role === 'user' && parts.output.some((part) => part.type === 'reasoning')) ||
      (message.role === 'assistant' &&
        parts.output.some((part) => part.type === 'image' || part.type === 'file')) ||
      'content' in message ||
      'reasoning' in message ||
      !['completed', 'failed', 'cancelled'].includes(String(message.status)) ||
      !Number.isSafeInteger(message.createdAt) ||
      !nullableString(message.parentId, 64) ||
      !nullableString(message.revisionOf, 64) ||
      !nullableString(message.error, 4096) ||
      !nullableString(message.providerId, 64) ||
      !nullableString(message.model, 200) ||
      !nullableString(message.modelName, 200) ||
      !(
        message.deletedAt === undefined ||
        message.deletedAt === null ||
        (Number.isSafeInteger(message.deletedAt) && Number(message.deletedAt) > 0)
      )
    )
      throw new AppError(problem('BACKUP_INVALID'), '备份中的消息字段无效。');
    const fields = {
      id: message.id,
      role: message.role,
      parts: parts.output,
      status: message.status,
      createdAt: message.createdAt,
      parentId: message.parentId,
      revisionOf: message.revisionOf,
      error: message.error,
      providerId: message.providerId,
      model: message.model,
      modelName: message.modelName,
      ...(message.deletedAt ? { deletedAt: message.deletedAt } : {}),
      ...(summary?.success ? { summary: summary.output } : {}),
    } as BackupMessage;
    const rawGeneration = message.generation;
    if (message.deletedAt) return { ...fields, parts: [], error: null };
    const generation =
      rawGeneration === undefined ? undefined : v.safeParse(generationSchema, rawGeneration);
    if (generation && (!generation.success || message.role !== 'assistant'))
      throw new AppError(problem('BACKUP_INVALID'), '备份中的生成元数据无效。');
    const retained = generation?.success && generation.output.interrupted;
    if (
      retained &&
      (message.status !== 'completed' || summary || !messageText({ parts: parts.output }).trim())
    )
      throw new AppError(problem('BACKUP_INVALID'), '备份中的保留回答无效。');
    const tools =
      message.tools === undefined ? undefined : v.safeParse(publicToolTaskSchema, message.tools);
    if (
      tools &&
      (!tools.success ||
        message.role !== 'assistant' ||
        (tools.output.status !== message.status &&
          !(retained && tools.output.status === 'failed')) ||
        !validReasoningBreaks(tools.output, messageText({ parts: parts.output }, 'reasoning')))
    )
      throw new AppError(problem('BACKUP_INVALID'), '备份中的工具过程无效。');
    return {
      ...fields,
      ...(generation?.success ? { generation: generation.output } : {}),
      ...(tools?.success ? { tools: tools.output } : {}),
    } as unknown as BackupMessage;
  });
  if (messages.filter((message) => message.summary && !message.deletedAt).length > MAX_SUMMARIES)
    throw new AppError(problem('BACKUP_INVALID'), '备份中的摘要数量超过上限。');
  for (const message of messages)
    if (message.summary) {
      let path;
      try {
        path = branchPath(messages as Message[], message.summary.throughId);
      } catch {
        throw new AppError(problem('BACKUP_INVALID'), '备份中的摘要父链无效。');
      }
      if (
        message.parentId !== message.summary.throughId ||
        path.at(-1)?.role !== 'assistant' ||
        path.at(-1)?.status !== 'completed' ||
        path.some((source) => source.summary) ||
        path.length !== message.summary.sourceIds.length ||
        !path.every((source, index) => source.id === message.summary!.sourceIds[index])
      )
        throw new AppError(problem('BACKUP_INVALID'), '备份中的摘要父链无效。');
      if (
        !message.deletedAt &&
        message.status === 'completed' &&
        (!message.parts.some((part) => part.type === 'text' && part.text.trim()) ||
          message.parts.some(
            (part) => part.type === 'text' && part.text.length > MAX_SUMMARY_CHARACTERS,
          ) ||
          message.generation?.finishReason === 'length')
      )
        throw new AppError(problem('BACKUP_INVALID'), '备份中的已完成摘要无效。');
    }
  const settings = input.settings as Record<string, unknown>;
  const titleSettings = v.safeParse(v.optional(titleSettingsSchema), settings?.title);
  if (!titleSettings.success)
    throw new AppError(problem('BACKUP_INVALID'), '备份中的标题模型配置无效。');
  const promptPresets = v.safeParse(promptPresetListSchema, settings?.promptPresets);
  if (!promptPresets.success)
    throw new AppError(problem('BACKUP_INVALID'), '备份中的提示词预设无效。');
  if (
    !settings ||
    typeof settings !== 'object' ||
    !Array.isArray(settings.providers) ||
    settings.providers.length > 50 ||
    !nullableString(settings.activeProviderId, 64) ||
    !isString(settings.activeModel, 200) ||
    !isString(settings.systemPrompt, MAX_SYSTEM_PROMPT_LENGTH) ||
    !(
      settings.maxOutputTokens === null ||
      (Number.isSafeInteger(settings.maxOutputTokens) &&
        Number(settings.maxOutputTokens) > 0 &&
        Number(settings.maxOutputTokens) <= MAX_MODEL_TOKENS)
    )
  )
    throw new AppError(problem('BACKUP_INVALID'), '备份中的配置无效。');
  const providers = settings.providers.map((raw) => {
    if (!raw || typeof raw !== 'object')
      throw new AppError(problem('BACKUP_INVALID'), '备份中的供应商配置无效。');
    const provider = raw as Record<string, unknown>;
    if (
      !isUuid(provider.id) ||
      !isString(provider.name, 100) ||
      !['openai-chat', 'anthropic', 'openai-responses', 'gemini'].includes(
        String(provider.provider),
      ) ||
      !isString(provider.baseUrl, 2048) ||
      !Array.isArray(provider.models) ||
      provider.models.length > MAX_PROVIDER_MODELS
    )
      throw new AppError(problem('BACKUP_INVALID'), '备份中的供应商配置无效。');
    const models = provider.models.map((model) => {
      if (!model || typeof model !== 'object')
        throw new AppError(problem('BACKUP_INVALID'), '备份中的模型配置无效。');
      const candidate = v.safeParse(modelSchema, model);
      if (!candidate.success)
        throw new AppError(problem('BACKUP_INVALID'), '备份中的模型配置无效。');
      return candidate.output;
    });
    return {
      id: provider.id,
      name: provider.name,
      provider: provider.provider as ProviderApiKind,
      baseUrl: provider.baseUrl,
      models,
    };
  });
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Number(input.exportedAt),
    conversation: {
      id: conversation.id,
      title: conversation.title,
      createdAt: Number(conversation.createdAt),
      updatedAt: Number(conversation.updatedAt),
      messages,
      ...(conversationSettings?.success ? { settings: conversationSettings.output } : {}),
    },
    settings: {
      ...(titleSettings.output ? { title: titleSettings.output } : {}),
      providers,
      activeProviderId: settings.activeProviderId as string | null,
      activeModel: settings.activeModel,
      systemPrompt: settings.systemPrompt,
      maxOutputTokens: settings.maxOutputTokens as number | null,
      promptPresets: promptPresets.output,
    },
  };
}
