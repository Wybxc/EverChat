import type { Snapshot } from '../../../shared/streaming/protocol';

// The caller only supplies durable snapshots. Previews never enter browser storage.
export class SnapshotWriter {
  private latest?: Snapshot;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly write: (snapshot: Snapshot) => void, private readonly interval = 2000) {}
  schedule(snapshot: Snapshot, immediate = false) {
    this.latest = snapshot;
    if (immediate) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.interval);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.latest) return;
    const latest = this.latest;
    this.latest = undefined;
    this.write(latest);
  }
}
