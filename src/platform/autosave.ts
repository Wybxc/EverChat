import { setReloadBlocker } from './pwa/reload-guard';

type SaveState<T> = {
  settings: T;
  status: 'saved' | 'waiting' | 'saving' | 'error';
  error: string;
};

// Serialize requests and keep edits made while a response is in flight.
export class Autosave<T, Input = T> {
  private snapshot: SaveState<T>;
  private saved: T;
  private revision = 0;
  private savedRevision = 0;
  private pending: Promise<T> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(
    initial: T,
    private persist: (settings: Input) => Promise<T>,
    private onSaved: (settings: T) => void,
    private normalize: (saved: T, draft: T) => Input,
    private delay = 600,
  ) {
    this.saved = initial;
    this.snapshot = { settings: initial, status: 'saved', error: '' };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(snapshot: SaveState<T>) {
    this.snapshot = snapshot;
    if (!this.disposed)
      setReloadBlocker(
        this,
        snapshot.status === 'saved' ? null : '设置尚未保存，请保存或放弃修改后再更新',
      );
    this.listeners.forEach((listener) => listener());
  }
  update(settings: T) {
    this.disposed = false;
    this.revision++;
    this.emit({ settings, status: 'waiting', error: '' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, this.delay);
  }
  flush = (): Promise<T> => {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    if (this.savedRevision === this.revision) return Promise.resolve(this.saved);
    this.pending = this.save().finally(() => {
      this.pending = null;
    });
    return this.pending;
  };
  private async save(): Promise<T> {
    try {
      while (this.savedRevision !== this.revision) {
        const revision = this.revision;
        const input = this.normalize(this.saved, this.snapshot.settings);
        this.emit({ ...this.snapshot, status: 'saving', error: '' });
        const result = await this.persist(input);
        this.saved = result;
        this.savedRevision = revision;
        this.emit({
          settings: revision === this.revision ? result : this.snapshot.settings,
          status: revision === this.revision ? 'saved' : 'waiting',
          error: '',
        });
        this.onSaved(result);
      }
      return this.saved;
    } catch (error) {
      this.emit({
        ...this.snapshot,
        status: 'error',
        error: error instanceof Error ? error.message : '保存失败，请重试。',
      });
      throw error;
    }
  }
  async refresh(load: () => Promise<T>) {
    await this.flush();
    const revision = this.revision;
    const result = await load();
    if (revision !== this.revision) return;
    this.saved = result;
    this.emit({ settings: result, status: 'saved', error: '' });
    this.onSaved(result);
  }
  receive(settings: T) {
    if (this.pending || this.revision !== this.savedRevision) return;
    this.saved = settings;
    this.emit({ settings, status: 'saved', error: '' });
  }
  dispose() {
    clearTimeout(this.timer);
    this.disposed = true;
    setReloadBlocker(this, null);
  }
}
