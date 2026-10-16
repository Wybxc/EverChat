import { resolveModelMetadata } from '../../../shared/models/metadata';
import type { ProviderConfig } from '../../../shared/providers/types';
import type { SqlQuery } from '../../../worker/generation/metrics';
import { collectProviderToolTurn } from '../../../worker/providers/tool-turn';
import { ToolTaskJournal, type StartToolTask } from '../../../worker/web-tools/task-journal';
import { fragmentedToolBody, toolStream } from '../providers/tool-streams';

export type ToolJournalControl =
  | { action: 'start'; input: StartToolTask; rollback?: boolean }
  | { action: 'model'; id: string; runId: string }
  | { action: 'turn'; id: string; runId: string; final?: boolean; large?: boolean }
  | { action: 'tool' | 'result'; id: string; callId: string }
  | { action: 'next'; id: string; runId: string; messageId: string; rollback?: boolean }
  | { action: 'status' | 'stop' | 'expire' | 'reset' | 'ack'; id: string };

const settings: ProviderConfig = {
  provider: 'anthropic',
  baseUrl: 'https://provider.example/v1',
  apiKey: 'private-journal-fixture-key',
  model: 'journal-fixture',
  systemPrompt: 'private-journal-fixture-prompt',
  maxOutputTokens: null,
  showReasoning: false,
  modelMetadata: resolveModelMetadata('anthropic', {
    id: 'journal-fixture',
    name: 'Fixture',
    enabled: true,
    metadataOverrides: { toolCalls: true },
  }),
};
const enabled = ['web_search', 'read_webpage'] as const;

// Native SQLite/DO lifecycle lab only. It is absent from the production Worker.
export class ToolJournalFixture {
  private readonly query: SqlQuery;
  private readonly journal: ToolTaskJournal;
  constructor(private readonly storage: DurableObjectStorage) {
    this.query = (statement, ...bindings) => storage.sql.exec(statement, ...bindings);
    this.journal = new ToolTaskJournal(this.query);
    storage.transactionSync(() => this.journal.recover());
  }
  async control(input: ToolJournalControl) {
    const id = input.action === 'start' ? input.input.id : input.id;
    let changed: boolean | null = null;
    // Decode fixture SSE before opening the storage transaction. No network call.
    const value =
      input.action === 'turn'
        ? await collectProviderToolTurn(
            settings,
            enabled,
            fragmentedToolBody(
              input.final
                ? 'data: {"type":"message_start","message":{"id":"final","type":"message","role":"assistant","model":"journal-fixture","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n' +
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"最终回答🙂"}}\n\n' +
                    'data: {"type":"content_block_stop","index":0}\n\n' +
                    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
                    'data: {"type":"message_stop"}\n\n'
                : toolStream('anthropic', {
                    count: 2,
                    signature: input.large ? Array(6).fill('s'.repeat(100_000)) : undefined,
                  }),
              16_384,
            ),
            new AbortController().signal,
          )
        : undefined;
    try {
      this.storage.transactionSync(() => {
        const journal = this.journal;
        switch (input.action) {
          case 'start':
            journal.create(input.input, settings);
            break;
          case 'model':
            changed = journal.claimModel(input.runId);
            break;
          case 'turn':
            changed = journal.saveTurn(input.runId, value!, settings);
            break;
          case 'tool':
            changed = journal.claimTool(id, input.callId);
            break;
          case 'result':
            changed = journal.finishTool(id, input.callId, {
              id: input.callId,
              name: 'web_search',
              status: 'completed',
              sources: [
                {
                  title: '文档',
                  url: 'https://developers.cloudflare.com/',
                  content: '本地模拟资料🙂',
                },
              ],
            });
            break;
          case 'next':
            changed = journal.queueModel(id, 1, input.runId, input.messageId, settings);
            break;
          case 'stop':
            changed = journal.stop(id, 'cancelled');
            break;
          case 'expire':
            this.query('UPDATE web_tool_tasks SET deadline = 0 WHERE id = ?', id);
            journal.expire();
            break;
          case 'ack':
            for (const item of journal.notifications())
              journal.acknowledge(item.rootId, item.round);
            break;
        }
        if ('rollback' in input && input.rollback)
          throw new Error('Injected tool transaction rollback');
      });
    } catch (error) {
      if (
        'rollback' in input &&
        input.rollback &&
        error instanceof Error &&
        error.message === 'Injected tool transaction rollback'
      ) {
        return {
          rolledBack: true,
          roots: this.query<{ count: number }>('SELECT COUNT(*) AS count FROM web_tool_tasks').one()
            .count,
        };
      }
      throw error;
    }
    const state = this.journal.state(id),
      privatePayloads = this.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM web_tool_models WHERE turn IS NOT NULL',
      ).one().count;
    return {
      changed,
      state,
      calls: this.journal.publicCalls(state.runId),
      privatePayloads,
      privateBytes: this.query<{ size: number }>(
        'SELECT COALESCE(SUM(length(turn)), 0) AS size FROM web_tool_models',
      ).one().size,
      notifications: this.journal.notifications(),
      nextAlarm: this.journal.nextAlarm(),
    };
  }
}
