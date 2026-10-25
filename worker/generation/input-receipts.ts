import type { ContextEstimate, ContextSelection } from '../../shared/conversation/context-budget';
import type { ProviderConfig } from '../../shared/providers/types';
import type {
  InputReceipt,
  InputReceiptItem,
  InputEvidenceBackup,
} from '../../shared/streaming/input-receipt';
import type { SubmittedInput } from '../providers/input-receipt';
import type { SqlQuery } from './metrics';

export const INPUT_RECEIPTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS input_selections (
  messageId TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(messageId,ordinal)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS input_receipts (
  stepId TEXT PRIMARY KEY, messageId TEXT NOT NULL, round INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS input_receipts_message ON input_receipts(messageId,round);
CREATE TABLE IF NOT EXISTS input_receipt_items (
  stepId TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(stepId,ordinal)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS input_receipt_texts (
  stepId TEXT NOT NULL, item INTEGER NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(stepId,item,ordinal)
) WITHOUT ROWID`;

type SelectionItem = { sourceId: string | null; reason: string };
export class InputReceipts {
  constructor(private readonly query: SqlQuery) {}
  select(messageId: string, selection: ContextSelection) {
    this.query('DELETE FROM input_selections WHERE messageId=?', messageId);
    // A sentinel distinguishes a new empty plan from a legacy request without evidence.
    const items: SelectionItem[] = [
      { sourceId: null, reason: 'selected' },
      ...selection.omitted.map(({ input, reason }) => ({
        sourceId: input.source?.messageId ?? null,
        reason,
      })),
      ...selection.summarized.map((sourceId) => ({ sourceId, reason: 'summary_covered' })),
    ];
    for (const [ordinal, item] of items.entries())
      this.query(
        'INSERT INTO input_selections VALUES(?,?,?)',
        messageId,
        ordinal,
        JSON.stringify(item),
      );
  }
  latest(messageId: string): InputReceipt | null {
    const row = this.query<{ payload: string }>(
      'SELECT payload FROM input_receipts WHERE messageId=? ORDER BY round DESC LIMIT 1',
      messageId,
    ).toArray()[0];
    return row ? JSON.parse(row.payload) : null;
  }
  summary(messageId: string, pending: boolean) {
    const receipt = this.latest(messageId);
    const selected =
      this.query('SELECT 1 FROM input_selections WHERE messageId=? LIMIT 1', messageId).toArray()
        .length > 0;
    return {
      state: receipt
        ? receipt.submissionAttemptedAt === null
          ? ('assembled' as const)
          : ('submission_attempted' as const)
        : selected && pending
          ? ('pending' as const)
          : ('unavailable' as const),
      receiptRef: null as string | null,
      steps: receipt ? receipt.round + 1 : 0,
      estimatedInputTokens: receipt?.estimatedInputTokens ?? null,
      estimateMethod: receipt?.estimateMethod ?? null,
      omittedMessages: receipt?.omittedMessages ?? null,
      summarizedMessages: receipt?.summarizedMessages ?? null,
      includedItems: receipt?.includedItems ?? null,
      providerReceipt: 'not_proven' as const,
    };
  }
  /** Called in the owner's synchronous transaction, then synced before fetch. */
  submit(
    stepId: string,
    messageId: string,
    round: number,
    config: ProviderConfig,
    evidence: SubmittedInput,
    estimate?: ContextEstimate,
  ) {
    if (this.query('SELECT 1 FROM input_receipts WHERE stepId=?', stepId).toArray().length)
      throw new Error('Input receipt already exists; a paid request cannot be replayed');
    const previous = this.latest(messageId);
    if ((previous && previous.round + 1 !== round) || (!previous && round !== 0))
      throw new Error('Input receipt step sequence mismatch');
    const selected = this.query<{ omitted: number; summarized: number }>(
      `SELECT COALESCE(SUM(json_extract(payload,'$.reason') IN ('context_budget','recent_messages','unavailable')),0) AS omitted,
        COALESCE(SUM(json_extract(payload,'$.reason')='summary_covered'),0) AS summarized
        FROM input_selections WHERE messageId=?`,
      messageId,
    ).one();
    const items = previous
      ? evidence.items.filter(({ item }) => item.kind === 'tool')
      : evidence.items;
    if (previous && !items.length)
      throw new Error('A continuation step is missing its new tool input evidence');
    const now = Date.now();
    const receipt: InputReceipt = {
      stepId,
      messageId,
      round,
      previousStepId: previous?.stepId ?? null,
      assembledAt: now,
      submissionAttemptedAt: null,
      requestSha256: evidence.requestSha256,
      requestBytes: evidence.requestBytes,
      protocol: config.provider,
      model: config.model,
      estimatedInputTokens: estimate?.totalTokens ?? null,
      estimateMethod: estimate?.method ?? null,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature ?? null,
      topP: config.topP ?? null,
      reasoningEffort: config.reasoningEffort ?? null,
      parameterEvidence: 'application_requested',
      tools: evidence.tools,
      toolDefinitionsSha256: evidence.toolDefinitionsSha256,
      includedItems: (previous?.includedItems ?? 0) + items.length,
      omittedMessages: selected.omitted,
      summarizedMessages: selected.summarized,
      originStepId: null,
    };
    this.query(
      'INSERT INTO input_receipts VALUES(?,?,?,?)',
      stepId,
      messageId,
      round,
      JSON.stringify(receipt),
    );
    for (const [ordinal, { item, snapshot }] of items.entries()) {
      this.query(
        'INSERT INTO input_receipt_items VALUES(?,?,?)',
        stepId,
        ordinal,
        JSON.stringify(item),
      );
      if (snapshot !== undefined)
        for (let start = 0, chunk = 0; start < snapshot.length; start += 4096, chunk++)
          this.query(
            'INSERT INTO input_receipt_texts VALUES(?,?,?,?)',
            stepId,
            ordinal,
            chunk,
            JSON.stringify(snapshot.slice(start, start + 4096)),
          );
    }
    return receipt;
  }
  attempt(stepId: string) {
    const row = this.query<{ payload: string }>(
      'SELECT payload FROM input_receipts WHERE stepId=?',
      stepId,
    ).one();
    const receipt = JSON.parse(row.payload) as InputReceipt;
    if (receipt.submissionAttemptedAt !== null)
      throw new Error('A supplier submission cannot be repeated');
    receipt.submissionAttemptedAt = Date.now();
    this.query(
      'UPDATE input_receipts SET payload=? WHERE stepId=?',
      JSON.stringify(receipt),
      stepId,
    );
  }
  page(messageId: string, round: number, offset: number) {
    if (!Number.isSafeInteger(round) || round < 0 || !Number.isSafeInteger(offset) || offset < 0)
      return { error: 'invalid_cursor' as const };
    const row = this.query<{ payload: string }>(
      'SELECT payload FROM input_receipts WHERE messageId=? AND round=?',
      messageId,
      round,
    ).toArray()[0];
    if (!row) return null;
    const receipt = JSON.parse(row.payload) as InputReceipt;
    const rows = this.query<{ ordinal: number; payload: string }>(
      'SELECT ordinal,payload FROM input_receipt_items WHERE stepId=? AND ordinal>=? ORDER BY ordinal LIMIT 9',
      receipt.stepId,
      offset,
    ).toArray();
    const items = rows
      .slice(0, 8)
      .map(({ ordinal, payload }) => ({ ordinal, ...(JSON.parse(payload) as InputReceiptItem) }));
    return { receipt, items, hasMore: rows.length > 8, nextOffset: offset + items.length };
  }
  exclusions(messageId: string, offset: number) {
    return this.query<{ ordinal: number; payload: string }>(
      'SELECT ordinal,payload FROM input_selections WHERE messageId=? AND ordinal>? ORDER BY ordinal LIMIT 33',
      messageId,
      offset,
    )
      .toArray()
      .map(({ ordinal, payload }) => ({ ordinal, ...(JSON.parse(payload) as SelectionItem) }));
  }
  text(
    messageId: string,
    round: number,
    ordinal: number,
    offset: number,
    source: (
      id: string,
      offset: number,
      limit: number,
    ) => { text: string; nextOffset: number; hasMore: boolean } | null,
  ) {
    const row = this.query<{ stepId: string; payload: string }>(
      `SELECT input_receipts.stepId,input_receipt_items.payload FROM input_receipts
       JOIN input_receipt_items USING(stepId) WHERE messageId=? AND round=? AND ordinal=?`,
      messageId,
      round,
      ordinal,
    ).toArray()[0];
    if (!row) return null;
    const item = JSON.parse(row.payload) as InputReceiptItem;
    if (item.content === 'redacted' || item.content === 'metadata_only')
      return { state: item.content, text: '', hasMore: false, nextOffset: offset };
    if (item.characters === null || offset > item.characters)
      return { state: 'invalid_cursor' as const, text: '', hasMore: false, nextOffset: offset };
    let text = '';
    if (item.content === 'reference' && item.sourceId) {
      const prefix = item.transform?.prefix ?? '',
        suffix = item.transform?.suffix ?? '';
      const sourceLength = item.characters - prefix.length - suffix.length;
      if (offset < prefix.length) text = prefix.slice(offset);
      const at = Math.max(offset, prefix.length);
      const result = source(item.sourceId, Math.min(sourceLength, at - prefix.length), 8194);
      if (!result)
        return {
          state: 'content_unavailable' as const,
          text: '',
          hasMore: false,
          nextOffset: offset,
        };
      if (at < prefix.length + sourceLength) text += result.text;
      if (!result.hasMore) text += suffix.slice(Math.max(0, offset - prefix.length - sourceLength));
    } else {
      text = this.query<{ payload: string }>(
        'SELECT payload FROM input_receipt_texts WHERE stepId=? AND item=? AND ordinal>=? AND ordinal<=? ORDER BY ordinal',
        row.stepId,
        ordinal,
        Math.floor(offset / 4096),
        Math.floor((offset + 8193) / 4096),
      )
        .toArray()
        .map(({ payload }) => JSON.parse(payload) as string)
        .join('')
        .slice(offset % 4096);
    }
    if (offset > 0 && /^[\uDC00-\uDFFF]/.test(text))
      return { state: 'invalid_cursor' as const, text: '', hasMore: false, nextOffset: offset };
    let end = Math.min(text.length, 8192);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    return {
      state: 'available' as const,
      text: text.slice(0, end),
      nextOffset: offset + end,
      hasMore: offset + end < item.characters,
    };
  }
  erase(messageId: string) {
    for (const table of ['input_receipt_items', 'input_receipt_texts'])
      this.query(
        `DELETE FROM ${table} WHERE stepId IN (SELECT stepId FROM input_receipts WHERE messageId=?)`,
        messageId,
      );
    this.query('DELETE FROM input_receipts WHERE messageId=?', messageId);
    this.query('DELETE FROM input_selections WHERE messageId=?', messageId);
  }
  export(messageId: string): InputEvidenceBackup | undefined {
    const steps = this.query<{ stepId: string; payload: string }>(
      'SELECT stepId,payload FROM input_receipts WHERE messageId=? ORDER BY round',
      messageId,
    )
      .toArray()
      .map((row) => ({
        receipt: JSON.parse(row.payload) as InputReceipt,
        items: this.query<{ ordinal: number; payload: string }>(
          'SELECT ordinal,payload FROM input_receipt_items WHERE stepId=? ORDER BY ordinal',
          row.stepId,
        )
          .toArray()
          .map((entry) => {
            const item = JSON.parse(entry.payload) as InputReceiptItem;
            const chunks = this.query<{ payload: string }>(
              'SELECT payload FROM input_receipt_texts WHERE stepId=? AND item=? ORDER BY ordinal',
              row.stepId,
              entry.ordinal,
            ).toArray();
            return {
              item,
              ...(item.content === 'snapshot'
                ? { snapshot: chunks.map(({ payload }) => JSON.parse(payload) as string).join('') }
                : {}),
            };
          }),
      }));
    if (!steps.length) return undefined;
    return {
      selection: this.query<{ payload: string }>(
        'SELECT payload FROM input_selections WHERE messageId=? ORDER BY ordinal',
        messageId,
      )
        .toArray()
        .map(({ payload }) => JSON.parse(payload) as SelectionItem),
      steps,
    };
  }
  restore(messageId: string, evidence: InputEvidenceBackup, ids: Map<string, string>) {
    const stepIds = new Map(
      evidence.steps.map(({ receipt }) => [receipt.stepId, crypto.randomUUID()]),
    );
    for (const [ordinal, item] of evidence.selection.entries())
      this.query(
        'INSERT INTO input_selections VALUES(?,?,?)',
        messageId,
        ordinal,
        JSON.stringify({
          ...item,
          sourceId: item.sourceId ? (ids.get(item.sourceId) ?? item.sourceId) : null,
        }),
      );
    for (const step of evidence.steps) {
      const receipt = {
        ...step.receipt,
        stepId: stepIds.get(step.receipt.stepId)!,
        messageId,
        previousStepId: step.receipt.previousStepId
          ? (stepIds.get(step.receipt.previousStepId) ?? null)
          : null,
        originStepId: step.receipt.originStepId ?? step.receipt.stepId,
      };
      this.query(
        'INSERT INTO input_receipts VALUES(?,?,?,?)',
        receipt.stepId,
        messageId,
        receipt.round,
        JSON.stringify(receipt),
      );
      for (const [ordinal, entry] of step.items.entries()) {
        const item = {
          ...entry.item,
          sourceId: entry.item.sourceId
            ? (ids.get(entry.item.sourceId) ?? entry.item.sourceId)
            : null,
        };
        this.query(
          'INSERT INTO input_receipt_items VALUES(?,?,?)',
          receipt.stepId,
          ordinal,
          JSON.stringify(item),
        );
        if (entry.snapshot !== undefined)
          for (let start = 0; start < entry.snapshot.length; start += 4096)
            this.query(
              'INSERT INTO input_receipt_texts VALUES(?,?,?,?)',
              receipt.stepId,
              ordinal,
              start / 4096,
              JSON.stringify(entry.snapshot.slice(start, start + 4096)),
            );
      }
    }
  }
}
