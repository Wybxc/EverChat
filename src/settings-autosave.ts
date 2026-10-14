import { mergeProviderSettings } from '../shared/provider-settings';
import type { ProviderSettings, ProviderSettingsInput } from '../shared/types';
import { Autosave } from './autosave';

export class SettingsAutosave extends Autosave<ProviderSettings, ProviderSettingsInput> {
  constructor(initial: ProviderSettings, persist: (settings: ProviderSettingsInput) => Promise<ProviderSettings>,
    onSaved: (settings: ProviderSettings) => void, delay = 600) {
    super(initial, persist, onSaved, mergeProviderSettings, delay);
  }
}
