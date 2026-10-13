import type { ChatModel, ProviderApiKind, ProviderModel, ProviderSettings, ProviderSettingsInput, ReasoningEffort } from './types';

export const effortLabels: Record<ReasoningEffort, string> = {
  none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高',
};

// Model directories do not advertise reasoning support. Unknown IDs can be explicitly enabled in settings.
export function modelReasoning(provider: ProviderApiKind, model: ProviderModel) {
  const id = model.id.toLowerCase();
  let known = false;
  let efforts: ReasoningEffort[] = ['low', 'medium', 'high'];
  if (provider.startsWith('openai-')) {
    known = /^(o[134](?:-|$)|gpt-[5-9](?:[.-]|$)|deepseek-(?:reasoner|flash|v4))/.test(id) && !/-(?:chat|nano)(?:-|$)/.test(id);
    efforts = known ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high'];
    if (/^o[134](?:-|$)/.test(id)) efforts = ['low', 'medium', 'high'];
    if (/^gpt-6(?:\.\d+)?-(?:sol|luna)$/.test(id)) efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    else if (/^gpt-6/.test(id)) efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (/^gpt-5(?:\.1)?(?:-|$)/.test(id)) efforts = ['none', 'minimal', 'low', 'medium', 'high'];
    if (/^gpt-5-pro(?:-|$)/.test(id)) efforts = ['high'];
    if (/^deepseek-/.test(id)) efforts = ['none', 'low', 'high', 'max'];
  } else if (provider === 'anthropic') {
    known = /^claude-(?:3-7|(?:sonnet|opus|haiku)-[4-9])/.test(id);
  } else {
    known = /^gemini-(?:2\.5|[3-9])/.test(id);
    if (/^gemini-[3-9](?:\.\d+)?-pro/.test(id)) efforts = ['low', 'high'];
    else if (/^gemini-[3-9]/.test(id)) efforts = ['minimal', 'low', 'medium', 'high'];
  }
  const supported = model.reasoningSupport === 'supported' || (model.reasoningSupport !== 'unsupported' && known);
  return { supported, efforts };
}

export function chatModels(settings: ProviderSettings | ProviderSettingsInput): ChatModel[] {
  return settings.providers.flatMap((profile) => profile.apiKey || ('hasApiKey' in profile && profile.hasApiKey)
    ? profile.models.filter((model) => model.enabled).map((model) => ({
      providerId: profile.id, providerName: profile.name, model: model.id, name: model.name || model.id,
      reasoningSupported: modelReasoning(profile.provider, model).supported,
      reasoningEfforts: modelReasoning(profile.provider, model).efforts,
    })) : []);
}

export const modelSelectionKey = (selection: { providerId: string; model: string }) => JSON.stringify([selection.providerId, selection.model]);
