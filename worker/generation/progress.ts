import type { GenerationPhase, GenerationProgress } from '../../shared/streaming/progress';
import type { SqlQuery } from './metrics';

export const GENERATION_PROGRESS_SCHEMA = `CREATE TABLE IF NOT EXISTS generation_progress (
  messageId TEXT PRIMARY KEY, payload TEXT NOT NULL
)`;

// A small current-state receipt, not a stream event log. Reads never write or
// renew progress; semantic updates share the existing checkpoint transaction.
export class GenerationProgressStore {
  constructor(
    private readonly query: SqlQuery,
    private readonly now = Date.now,
  ) {}
  get(messageId: string): GenerationProgress | null {
    const row = this.query<{ payload: string }>(
      'SELECT payload FROM generation_progress WHERE messageId=?',
      messageId,
    ).toArray()[0];
    return row ? JSON.parse(row.payload) : null;
  }
  begin(messageId: string, acceptedAt: number) {
    this.query(
      'INSERT INTO generation_progress VALUES(?,?)',
      messageId,
      JSON.stringify({
        phase: 'queued',
        acceptedAt,
        phaseStartedAt: acceptedAt,
        providerRequestedAt: null,
        firstContentAt: null,
        lastProgressAt: acceptedAt,
        lastContentAt: null,
        persistedAt: acceptedAt,
        revision: 0,
        content: { length: 0, epoch: 0 },
        reasoning: { length: 0, epoch: 0 },
      } satisfies GenerationProgress),
    );
  }
  private save(messageId: string, value: GenerationProgress) {
    value.persistedAt = this.now();
    value.lastProgressAt = value.persistedAt;
    value.revision++;
    this.query(
      'UPDATE generation_progress SET payload=? WHERE messageId=?',
      JSON.stringify(value),
      messageId,
    );
  }
  phase(messageId: string, phase: GenerationPhase | null, submitted = false) {
    const value = this.get(messageId);
    if (!value || (value.phase === phase && !submitted)) return;
    const now = this.now();
    value.phase = phase;
    value.phaseStartedAt = now;
    if (submitted) value.providerRequestedAt = now;
    this.save(messageId, value);
  }
  advance(messageId: string) {
    const value = this.get(messageId);
    if (value) this.save(messageId, value);
  }
  content(
    messageId: string,
    change: {
      content: { length: number; replaced: boolean };
      reasoning: { length: number; replaced: boolean };
    },
  ) {
    const value = this.get(messageId);
    if (!value) return;
    const changed = (['content', 'reasoning'] as const).some(
      (channel) => value[channel].length !== change[channel].length || change[channel].replaced,
    );
    if (!changed) return;
    for (const channel of ['content', 'reasoning'] as const) {
      value[channel].length = change[channel].length;
      if (change[channel].replaced) value[channel].epoch++;
    }
    const now = this.now();
    value.firstContentAt ??= now;
    value.lastContentAt = now;
    if (value.phase !== 'generating') {
      value.phase = 'generating';
      value.phaseStartedAt = now;
    }
    this.save(messageId, value);
  }
  erase(messageId: string) {
    this.query('DELETE FROM generation_progress WHERE messageId=?', messageId);
  }
}
