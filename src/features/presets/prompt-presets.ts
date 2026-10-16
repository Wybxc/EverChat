import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { PromptPreset } from '../../../shared/presets/types';
import { api } from '../../platform/api';
import { read, storageEpoch, write } from '../../platform/storage';

export const PRESET_QUERY = ['prompt-presets'] as const;
export function usePromptPresets(enabled: boolean) {
  return useQuery({
    queryKey: PRESET_QUERY,
    enabled,
    initialData: () => read<PromptPreset[] | undefined>('prompt-presets', undefined),
    queryFn: async ({ signal }) => {
      const epoch = storageEpoch();
      const presets = await api<PromptPreset[]>('/settings/presets', 'GET', undefined, signal);
      if (signal.aborted) throw signal.reason;
      if (epoch !== storageEpoch()) throw new Error('登录状态已改变。');
      write('prompt-presets', presets);
      return presets;
    },
    refetchInterval: enabled ? 10_000 : false,
  });
}
export function publishPresets(queryClient: QueryClient, presets: PromptPreset[], epoch: number) {
  if (epoch !== storageEpoch()) return;
  queryClient.setQueryData(PRESET_QUERY, presets);
  write('prompt-presets', presets);
}
export const presetDrafts = () => read<Record<string, PromptPreset>>('prompt-preset-drafts', {});
export function savePresetDraft(preset: PromptPreset) {
  write('prompt-preset-drafts', { ...presetDrafts(), [preset.id]: preset });
}
export function discardPresetDraft(id: string) {
  const drafts = { ...presetDrafts() };
  delete drafts[id];
  write('prompt-preset-drafts', drafts);
}
