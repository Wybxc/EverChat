import type { ProviderApiKind } from './types';

export const providerOptions: {
  value: ProviderApiKind;
  label: string;
  baseUrl: string;
}[] = [
  {
    value: 'openai-chat',
    label: 'OpenAI Chat Completions',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    value: 'anthropic',
    label: 'Anthropic Messages',
    baseUrl: 'https://api.anthropic.com/v1',
  },
  {
    value: 'openai-responses',
    label: 'OpenAI Responses',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    value: 'gemini',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
];
