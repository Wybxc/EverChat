import { useQuery } from '@tanstack/react-query';
import type { WebToolServiceSettings } from '../../../shared/web-tools/service';
import { api } from '../../platform/api';
import { read, storageEpoch, write } from '../../platform/storage';

export const WEB_TOOL_SETTINGS_KEY = ['web-tool-settings'] as const;
export async function loadWebToolSettings(signal?: AbortSignal) {
  const epoch = storageEpoch();
  const settings = await api<WebToolServiceSettings>('/settings/web-tools', 'GET', undefined, signal);
  if (storageEpoch() === epoch) write('web-tool-settings', settings);
  return settings;
}
export function useWebToolSettings(enabled: boolean) {
  return useQuery({ queryKey: WEB_TOOL_SETTINGS_KEY, queryFn: ({ signal }) => loadWebToolSettings(signal), enabled,
    initialData: () => read<WebToolServiceSettings | undefined>('web-tool-settings', undefined), staleTime: 30_000 });
}
