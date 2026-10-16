export interface PromptPreset {
  id: string;
  name: string;
  systemPrompt: string;
  updatedAt: number;
}

export type PromptPresetInput = Pick<PromptPreset, 'name' | 'systemPrompt'>;
