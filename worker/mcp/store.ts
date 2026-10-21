import { createHash } from 'node:crypto';
import { conversationSettingsDefaults } from '../../shared/conversation/settings';
import type {
  ConversationSettings,
  Submission,
  SubmitInput,
} from '../../shared/conversation/types';
import { chatModels } from '../../shared/models/selection';
import type { ModelSelection } from '../../shared/models/types';
import type { PromptPreset } from '../../shared/presets/types';
import type { ProviderConfig } from '../../shared/providers/types';
import type { Env } from '../http/env';
import type { ProviderSettingsStore } from '../providers/store';
import {
  decodeRef,
  encodeRef,
  fail,
  type ChatArguments,
  type McpFailure,
  type McpModel,
  type ModelsResult,
} from './contracts';

export interface McpRecord {
  conversationId: string;
  requestId: string;
  model: McpModel;
  settings: ConversationSettings;
  prepared?: { input: SubmitInput; config: ProviderConfig; automaticTitle: ProviderConfig | null };
  submission?: Pick<Submission, 'runId' | 'userId' | 'assistantId'>;
  failure?: McpFailure;
}

// One compact business index; no MCP sessions, token events or duplicated answer bodies.
export class McpRequests {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly providers: ProviderSettingsStore,
    private readonly presets: () => PromptPreset[],
    private readonly env: Env,
    private readonly create: (
      id: string,
      title: string,
    ) => { error: string; status: number } | unknown,
    private readonly exists: (id: string) => boolean,
    private readonly webTools: () => ProviderConfig['webTools'],
  ) {}
  catalog(): ModelsResult {
    let allowed: string[] | undefined;
    if (this.env.MCP_ALLOWED_MODELS) {
      try {
        const value: unknown = JSON.parse(this.env.MCP_ALLOWED_MODELS);
        if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
          throw new Error();
        allowed = value;
      } catch {
        fail('CONFIGURATION_ERROR', 'Invalid MCP model allowlist.', 'configuration');
      }
    }
    const models = chatModels(this.providers.providerSettingsData())
      .map((model) => ({
        ref: encodeRef('model1', [model.providerId, model.model]),
        id: model.model,
        name: model.name,
        providerName: model.providerName,
        reasoning: model.reasoningSupported,
        reasoningEfforts: model.reasoningEfforts,
        contextWindow: model.metadata.contextWindow || null,
        maxOutputTokens: model.metadata.maxOutputTokens || null,
      }))
      .filter((model) => !allowed || allowed.includes(model.ref));
    const defaultModelRef = this.env.MCP_DEFAULT_MODEL;
    return {
      models,
      presets: this.presets().map(({ id, name }) => ({ id, name })),
      ...(defaultModelRef && models.some(({ ref }) => ref === defaultModelRef)
        ? { defaultModelRef }
        : {}),
    };
  }
  get(principal: string, requestId: string): McpRecord | undefined {
    const row = this.storage.sql
      .exec<{ payload: string }>(
        'SELECT payload FROM mcp_requests WHERE principal=? AND requestId=?',
        principal,
        requestId,
      )
      .toArray()[0];
    return row ? JSON.parse(row.payload) : undefined;
  }
  prepare(principal: string, input: ChatArguments): McpRecord {
    const original = Object.fromEntries(
      Object.entries(input)
        .filter(([key]) => key !== 'waitMs')
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const fingerprint = createHash('sha256').update(JSON.stringify(original)).digest('hex');
    return this.storage.transactionSync(() => {
      const previous = this.storage.sql
        .exec<{ fingerprint: string; payload: string }>(
          'SELECT fingerprint,payload FROM mcp_requests WHERE principal=? AND requestId=?',
          principal,
          input.requestId,
        )
        .toArray()[0];
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          fail('IDEMPOTENCY_CONFLICT', 'This requestId was already used with different input.');
        return JSON.parse(previous.payload) as McpRecord;
      }
      if (input.presetId && input.systemPrompt !== undefined)
        fail('INVALID_ARGUMENT', 'presetId and systemPrompt are mutually exclusive.');
      let parent: McpRecord | undefined;
      if (input.continuation) {
        const [conversationId, requestId, assistantId] = decodeRef(
          'continue1',
          input.continuation,
          3,
        );
        parent = this.get(principal, requestId);
        if (
          !parent ||
          parent.conversationId !== conversationId ||
          parent.submission?.assistantId !== assistantId ||
          !this.exists(conversationId)
        )
          fail(
            'PARENT_UNAVAILABLE',
            'This continuation is unavailable to the authenticated principal.',
          );
      }
      const catalog = this.catalog();
      const ref = input.modelRef ?? parent?.model.ref ?? catalog.defaultModelRef;
      const model = catalog.models.find((item) => item.ref === ref);
      if (!model)
        fail('MODEL_UNAVAILABLE', 'Choose an enabled modelRef from everchat_models_list.');
      const [providerId, modelId] = decodeRef('model1', model.ref, 2);
      const selection: ModelSelection = { providerId, model: modelId };
      const config = this.providers.providerConfig(selection, input.reasoningEffort);
      if (!config) fail('MODEL_UNAVAILABLE', 'The selected model is unavailable.');
      if (input.reasoningEffort && !model.reasoningEfforts.includes(input.reasoningEffort))
        fail(
          'UNSUPPORTED_PARAMETER',
          'This model does not support the requested reasoning effort.',
        );
      const settings = conversationSettingsDefaults(parent?.settings);
      if (input.presetId) {
        const preset = this.presets().find(({ id }) => id === input.presetId);
        if (!preset) fail('PRESET_UNAVAILABLE', 'The selected preset is unavailable.');
        settings.systemPrompt = preset.systemPrompt;
      }
      if (input.systemPrompt !== undefined) settings.systemPrompt = input.systemPrompt;
      for (const key of ['temperature', 'topP', 'contextBudget', 'recentMessages'] as const)
        if (input[key] !== undefined) settings[key] = input[key];
      if (input.maxOutputTokens !== undefined) {
        settings.maxOutputTokens = input.maxOutputTokens;
        settings.useGlobalMaxOutputTokens = false;
      }
      const tools =
        input.webSearch === undefined
          ? settings.tools
          : input.webSearch
            ? (['web_search', 'read_webpage'] as const)
            : [];
      settings.tools = [...tools];
      if (tools.length) config.webTools = this.webTools();
      const conversationId = parent?.conversationId ?? crypto.randomUUID();
      if (!parent) {
        const created = this.create(conversationId, input.prompt.trim().slice(0, 80));
        if (created && typeof created === 'object' && 'error' in created)
          fail(
            'CONVERSATION_UNAVAILABLE',
            'Unable to create a conversation. Check workspace capacity.',
          );
      }
      const record: McpRecord = {
        conversationId,
        requestId: input.requestId,
        model: { ref: model.ref, id: model.id, name: model.name, providerName: model.providerName },
        settings,
        prepared: {
          input: {
            requestId: input.requestId,
            content: input.prompt,
            parentId: parent?.submission?.assistantId ?? null,
            selection,
            settings,
            ...(tools.length ? { tools: [...tools] } : {}),
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          },
          config,
          automaticTitle: this.providers.titleConfig(true),
        },
      };
      this.storage.sql.exec(
        'INSERT INTO mcp_requests VALUES (?,?,?,?,?)',
        principal,
        input.requestId,
        fingerprint,
        conversationId,
        JSON.stringify(record),
      );
      return record;
    });
  }
  finish(
    principal: string,
    requestId: string,
    outcome: NonNullable<McpRecord['submission']> | McpFailure,
  ): McpRecord {
    return this.storage.transactionSync(() => {
      const record = this.get(principal, requestId);
      if (!record) fail('RUN_NOT_FOUND', 'This run is unavailable.');
      if (record.submission || record.failure) return record;
      delete record.prepared;
      if ('runId' in outcome) record.submission = outcome;
      else record.failure = outcome as McpFailure;
      this.storage.sql.exec(
        'UPDATE mcp_requests SET payload=? WHERE principal=? AND requestId=?',
        JSON.stringify(record),
        principal,
        requestId,
      );
      return record;
    });
  }
}
