import type { ProviderApiKind } from './types';

export const providerOptions: {
  value: ProviderApiKind;
  label: string;
  baseUrl: string;
  modelPlaceholder: string;
}[] = [
  {
    value: 'openai-chat',
    label: 'OpenAI Chat Completions',
    baseUrl: 'https://api.openai.com/v1',
    modelPlaceholder: '输入模型 ID',
  },
  {
    value: 'anthropic',
    label: 'Anthropic Messages',
    baseUrl: 'https://api.anthropic.com/v1',
    modelPlaceholder: '输入 Claude 模型 ID',
  },
  {
    value: 'openai-responses',
    label: 'OpenAI Responses',
    baseUrl: 'https://api.openai.com/v1',
    modelPlaceholder: '输入模型 ID',
  },
  {
    value: 'gemini',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    modelPlaceholder: '输入 Gemini 模型 ID',
  },
];
