import { mergeProviderSettings } from '../shared/provider-settings';
import type { ProviderSettings, ProviderSettingsInput } from '../shared/types';

type SaveState = { settings: ProviderSettings; status: 'saved' | 'waiting' | 'saving' | 'error'; error: string };

// Serialize requests and keep edits made while a response is in flight.
export class SettingsAutosave {
  private snapshot: SaveState;
  private saved: ProviderSettings;
  private revision = 0;
  private savedRevision = 0;
  private pending: Promise<ProviderSettings> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  constructor(initial: ProviderSettings,
    private persist: (settings: ProviderSettingsInput) => Promise<ProviderSettings>,
    private onSaved: (settings: ProviderSettings) => void,
    private delay = 600,
  ) {
    this.saved = initial;
    this.snapshot = { settings: initial, status: 'saved', error: '' };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(snapshot: SaveState) { this.snapshot = snapshot; this.listeners.forEach((listener) => listener()); }
  update(settings: ProviderSettings) {
    this.revision++;
    this.emit({ settings, status: 'waiting', error: '' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, this.delay);
  }
  flush = (): Promise<ProviderSettings> => {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    if (this.savedRevision === this.revision) return Promise.resolve(this.saved);
    this.pending = this.save().finally(() => { this.pending = null; });
    return this.pending;
  };
  private async save(): Promise<ProviderSettings> {
    try {
      while (this.savedRevision !== this.revision) {
        const revision = this.revision;
        const input = mergeProviderSettings(this.saved, this.snapshot.settings);
        this.emit({ ...this.snapshot, status: 'saving', error: '' });
        const result = await this.persist(input);
        this.saved = result; this.savedRevision = revision;
        this.emit({ settings: revision === this.revision ? result : this.snapshot.settings,
          status: revision === this.revision ? 'saved' : 'waiting', error: '' });
        this.onSaved(result);
      }
      return this.saved;
    } catch (error) {
      this.emit({ ...this.snapshot, status: 'error', error: error instanceof Error ? error.message : '保存失败，请重试。' });
      throw error;
    }
  }
  async refresh(load: () => Promise<ProviderSettings>) {
    await this.flush();
    const revision = this.revision;
    const result = await load();
    if (revision !== this.revision) return;
    this.saved = result;
    this.emit({ settings: result, status: 'saved', error: '' });
    this.onSaved(result);
  }
  dispose() { clearTimeout(this.timer); }
}
