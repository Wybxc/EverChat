export interface PromptPreset {
  id: string;
  name: string;
  systemPrompt: string;
  updatedAt: number;
}

export type PromptPresetInput = Pick<PromptPreset, 'name' | 'systemPrompt'>;
export const DEFAULT_PROMPT_PRESET_ID = '00000000-0000-4000-8000-000000000000';
export const DEFAULT_PROMPT_PRESET_NAME = '默认预设';
