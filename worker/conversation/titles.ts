import { cleanTitle } from '../../shared/conversation/titles';
import { problem } from '../../shared/errors/descriptor';
import type { ChatInput, ProviderConfig } from '../../shared/providers/types';
import { ProviderStream, type StreamState } from '../../shared/streaming/provider-stream';
import type { SqlQuery } from '../generation/metrics';

export const TITLE_JOBS_SCHEMA = `CREATE TABLE IF NOT EXISTS title_automatic (
  id INTEGER PRIMARY KEY CHECK(id=1), config TEXT, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS title_jobs (
  id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, automatic INTEGER NOT NULL,
  config TEXT, input TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, expectedVersion INTEGER NOT NULL DEFAULT 0,
  result TEXT, error TEXT, nextAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);`;
export type TitleJob = {
  id: string;
  conversationId: string;
  automatic: number;
  config: string | null;
  input: string;
  state: string;
  version: number;
  expectedVersion: number;
  result: string | null;
  error: string | null;
  nextAt: number;
  attempts: number;
} & Record<string, SqlStorageValue>;
type TitleLibrary = {
  reserveTitle(
    id: string,
    taskId: string,
    automatic: boolean,
    expectedVersion: number,
  ): Promise<{ version: number } | { rejected: string }>;
  startTitle(id: string, taskId: string, version: number): Promise<boolean>;
  finishTitle(
    id: string,
    taskId: string,
    version: number,
    title: string | null,
    error?: string,
  ): Promise<boolean>;
};
const terminal = ['completed', 'failed', 'superseded'];

/** One auxiliary request at a time. Only delivery of its saved result may retry. */
export class ConversationTitles {
  private working?: Promise<void>;
  private abort?: AbortController;
  constructor(
    private readonly query: SqlQuery,
    private readonly live: () => boolean,
    private readonly now = Date.now,
    private readonly observe?: {
      start: (job: TitleJob, config: ProviderConfig) => Promise<void>;
      finish: (
        job: TitleJob,
        state: StreamState,
        status: 'completed' | 'failed' | 'cancelled',
      ) => void;
    },
  ) {}
  initialize(config: ProviderConfig | null) {
    this.query(
      'INSERT OR IGNORE INTO title_automatic(id,config) VALUES (1,?)',
      config ? JSON.stringify(config) : null,
    );
  }
  recover() {
    this.query(
      "UPDATE title_jobs SET state='delivering',config=NULL,error=?,nextAt=? WHERE state='running'",
      '标题生成因后台中断而停止，为避免重复计费，请主动重试。',
      this.now(),
    );
  }
  private active() {
    return this.query<TitleJob>(
      "SELECT * FROM title_jobs WHERE state NOT IN ('completed','failed','superseded') LIMIT 1",
    ).toArray()[0];
  }
  get(id: string) {
    return this.query<TitleJob>('SELECT * FROM title_jobs WHERE id=?', id).toArray()[0];
  }
  enqueue(
    conversationId: string,
    id: string,
    config: ProviderConfig,
    question: string,
    answer: string,
    automatic = false,
    expectedVersion = 0,
  ) {
    if (this.get(id)) return { id };
    if (this.active())
      return { error: '标题正在生成，请稍后重试。', issue: problem('TITLE_FAILED'), status: 409 };
    const input: ChatInput[] = [
      {
        role: 'user',
        content: JSON.stringify({
          question: question.slice(0, 2000),
          answer: answer.slice(0, 4000),
        }),
      },
    ];
    this.query(
      'INSERT INTO title_jobs(id,conversationId,automatic,config,input,state,nextAt,expectedVersion) VALUES (?,?,?,?,?,?,?,?)',
      id,
      conversationId,
      Number(automatic),
      JSON.stringify(config),
      JSON.stringify(input),
      'queued',
      this.now(),
      expectedVersion,
    );
    return { id };
  }
  offerAutomatic(conversationId: string, question: string, answer: string) {
    const row = this.query<{ config: string | null; consumed: number }>(
      'SELECT config,consumed FROM title_automatic WHERE id=1',
    ).toArray()[0];
    if (!row || row.consumed) return;
    this.query('UPDATE title_automatic SET consumed=1,config=NULL WHERE id=1');
    if (row.config && !this.active())
      this.enqueue(
        conversationId,
        crypto.randomUUID(),
        JSON.parse(row.config),
        question,
        answer,
        true,
      );
  }
  nextAlarm(): number | null {
    const row = this.query<{ nextAt: number | null }>(
      "SELECT MIN(nextAt) AS nextAt FROM title_jobs WHERE state NOT IN ('completed','failed','superseded')",
    ).one();
    return row.nextAt;
  }
  cancel() {
    this.abort?.abort();
  }
  step(
    library: TitleLibrary,
    sync: () => Promise<void>,
    open: (
      config: ProviderConfig,
      input: ChatInput[],
      signal: AbortSignal,
      beforeRequest?: () => Promise<void>,
    ) => Promise<ReadableStream<Uint8Array>>,
    chatBusy: () => boolean,
  ) {
    if (this.working) return this.working;
    const operation = this.advance(library, sync, open, chatBusy).finally(() => {
      if (this.working === operation) this.working = undefined;
    });
    this.working = operation;
    return operation;
  }
  private async advance(
    library: TitleLibrary,
    sync: () => Promise<void>,
    open: (
      config: ProviderConfig,
      input: ChatInput[],
      signal: AbortSignal,
      beforeRequest?: () => Promise<void>,
    ) => Promise<ReadableStream<Uint8Array>>,
    chatBusy: () => boolean,
  ) {
    if (!this.live()) return;
    let job = this.active();
    if (!job || job.nextAt > this.now()) return;
    try {
      if (job.state === 'queued') {
        if (chatBusy()) {
          this.defer(job, 1000);
          return;
        }
        if (!job.version) {
          const reservation = await library.reserveTitle(
            job.conversationId,
            job.id,
            Boolean(job.automatic),
            job.expectedVersion,
          );
          if (!this.live()) return;
          if ('rejected' in reservation) {
            this.complete(job, 'superseded');
            return;
          }
          this.query('UPDATE title_jobs SET version=? WHERE id=?', reservation.version, job.id);
          job = { ...job, version: reservation.version };
        }
        if (chatBusy()) {
          this.defer(job, 1000);
          return;
        }
        if (!(await library.startTitle(job.conversationId, job.id, job.version))) {
          if (this.live()) this.complete(job, 'superseded');
          return;
        }
        if (!this.live()) return;
        this.query(
          "UPDATE title_jobs SET state='running',nextAt=? WHERE id=?",
          this.now() + 31_000,
          job.id,
        );
        // Persist the paid-call boundary before opening the supplier connection.
        await sync();
        if (!this.live()) return;
        const abort = new AbortController();
        this.abort = abort;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error('timeout'));
          }, 30_000);
        });
        try {
          const result = await Promise.race([this.generate(job, open, abort.signal), timedOut]);
          if (!this.live()) return;
          this.query(
            "UPDATE title_jobs SET state='delivering',config=NULL,result=?,error=NULL,nextAt=? WHERE id=?",
            result,
            this.now(),
            job.id,
          );
        } catch {
          if (!this.live()) return;
          this.query(
            "UPDATE title_jobs SET state='delivering',config=NULL,error=?,nextAt=? WHERE id=?",
            '标题生成失败，已保留原题。请主动重试。',
            this.now(),
            job.id,
          );
        } finally {
          clearTimeout(timer);
          abort.abort();
          if (this.abort === abort) this.abort = undefined;
        }
        job = this.get(job.id)!;
      }
      if (job.state === 'delivering') {
        const applied = await library.finishTitle(
          job.conversationId,
          job.id,
          job.version,
          job.result,
          job.error ?? undefined,
        );
        if (this.live())
          this.complete(job, applied ? (job.result ? 'completed' : 'failed') : 'superseded');
      }
    } catch {
      if (!this.live()) return;
      const current = this.get(job.id)!;
      // An uncertain local commit after marking running must never reopen the supplier.
      if (current.state === 'running') this.recover();
      const pending = this.get(job.id)!;
      if (!terminal.includes(pending.state)) {
        this.query('UPDATE title_jobs SET attempts=attempts+1 WHERE id=?', job.id);
        this.defer(pending, Math.min(30_000, 1000 * 2 ** Math.min(pending.attempts, 5)));
      }
    }
  }
  private async generate(
    job: TitleJob,
    open: (
      config: ProviderConfig,
      input: ChatInput[],
      signal: AbortSignal,
      beforeRequest?: () => Promise<void>,
    ) => Promise<ReadableStream<Uint8Array>>,
    signal: AbortSignal,
  ) {
    const config = JSON.parse(job.config!) as ProviderConfig;
    const parser = new ProviderStream(config.provider, false);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let status: 'completed' | 'failed' | 'cancelled' = 'failed';
    try {
      reader = (
        await open(
          config,
          JSON.parse(job.input),
          signal,
          () => this.observe?.start(job, config) ?? Promise.resolve(),
        )
      ).getReader();
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(value);
        if (parser.content.length > 1024) throw new Error('Title too long');
      }
      parser.assertComplete();
      if (parser.checkpoint().finishReason === 'length') throw new Error('Incomplete title');
      const title = cleanTitle(parser.content);
      status = 'completed';
      return title;
    } finally {
      this.observe?.finish(job, parser.checkpoint(), signal.aborted ? 'cancelled' : status);
      void reader?.cancel().catch(() => {});
    }
  }
  private defer(job: TitleJob, delay: number) {
    this.query('UPDATE title_jobs SET nextAt=? WHERE id=?', this.now() + delay, job.id);
  }
  private complete(job: TitleJob, state: string) {
    this.query(
      "UPDATE title_jobs SET state=?,config=NULL,input='[]',result=NULL WHERE id=?",
      state,
      job.id,
    );
  }
}
