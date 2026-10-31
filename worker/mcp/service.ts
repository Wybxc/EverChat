import type { McpPrincipal } from './keys';
import type { Env } from '../http/env';
import {
  decodeRef,
  encodeRef,
  fail,
  McpError,
  type ChatArguments,
  type GetArguments,
  type McpFailure,
  type RunResult,
  type ContextGetArguments,
  type ContextResult,
  type UsageGetArguments,
  type UsageResult,
} from './contracts';
import type { McpRecord } from './store';
import { readCompletion } from './completion';
import type { ContextSummary } from '../../shared/streaming/input-receipt';
import { mcpUsage } from '../../shared/usage/evidence';
import { formatAmount } from '../../shared/usage/pricing';
import { addGenerationUsage } from '../../shared/streaming/generation';
import { McpHistoryService } from './history-service';
import type {
  AttachmentsPrepareArguments,
  AttachmentsPutArguments,
  AttachmentsGetArguments,
  AttachmentsResult,
} from './attachment-contracts';

const unavailableContext: ContextSummary = {
  state: 'unavailable',
  receiptRef: null,
  steps: 0,
  estimatedInputTokens: null,
  estimateMethod: null,
  omittedMessages: null,
  summarizedMessages: null,
  includedItems: null,
  providerReceipt: 'not_proven',
};

function unwrap<T>(result: { value: T } | { error: McpFailure }): T {
  if ('error' in result) throw new McpError(result.error);
  return result.value;
}
export class McpChatService {
  readonly history: McpHistoryService;
  private readonly principal: string;
  private readonly library;
  constructor(
    private readonly env: Env,
    identity: McpPrincipal,
    private readonly signal?: AbortSignal,
  ) {
    this.principal = identity.keyId;
    this.history = new McpHistoryService(env, this.principal);
    this.library = env.LIBRARY.getByName('personal');
  }
  async models() {
    return unwrap(await this.library.mcpCatalog());
  }
  async filesPrepare(input: AttachmentsPrepareArguments) {
    return unwrap<AttachmentsResult>(await this.library.mcpFilesPrepare(this.principal, input));
  }
  async filesPut(input: AttachmentsPutArguments) {
    return unwrap<AttachmentsResult>(await this.library.mcpFilesPut(this.principal, input));
  }
  async filesGet(input: AttachmentsGetArguments) {
    return unwrap<AttachmentsResult>(await this.library.mcpFilesGet(this.principal, input));
  }
  async filesDelete(refs: string[]) {
    return unwrap(await this.library.mcpFilesDelete(this.principal, refs));
  }
  private ref(record: McpRecord) {
    return encodeRef('run1', [record.conversationId, record.requestId]);
  }
  private async owned(ref: string): Promise<McpRecord> {
    const [conversationId, requestId] = decodeRef('run1', ref, 2);
    const record = await this.library.mcpRequest(this.principal, requestId);
    if (!record || record.conversationId !== conversationId)
      fail(
        'RUN_NOT_FOUND',
        'This run is unavailable to the authenticated principal.',
        'authorization',
      );
    return record;
  }
  private async finish(
    record: McpRecord,
    result: NonNullable<McpRecord['submission']> | McpFailure,
  ): Promise<McpRecord> {
    return unwrap(await this.library.mcpFinish(this.principal, record.requestId, result));
  }
  private async reconcile(record: McpRecord): Promise<McpRecord> {
    if (!record.prepared) return record;
    const accepted = await this.env.CONVERSATIONS.getByName(record.conversationId).mcpSubmission(
      record.requestId,
    );
    if (!accepted) return record;
    if ('error' in accepted)
      return this.finish(record, {
        code: 'CANCELLED',
        message: 'Request cancelled before generation.',
        stage: 'cancellation',
        retryable: false,
      });
    return this.finish(record, {
      runId: accepted.runId,
      assistantId: accepted.assistantId,
      userId: accepted.userId,
    });
  }
  async chat(input: ChatArguments): Promise<RunResult> {
    let record: McpRecord = unwrap(await this.library.mcpPrepare(this.principal, input));
    if (!(await this.library.get(record.conversationId)))
      fail('CONVERSATION_UNAVAILABLE', 'This conversation was deleted.');
    if (record.prepared) {
      const conversation = this.env.CONVERSATIONS.getByName(record.conversationId);
      const prepared = record.prepared;
      // Duplicate acceptance is checked before any validation that could have changed since the first call.
      record = await this.reconcile(record);
      if (record.prepared) {
        const sourceId = prepared.input.continueOf ?? prepared.input.parentId;
        if (input.continuation && sourceId) {
          const parent = await conversation.mcpStatus(sourceId);
          if (
            !parent ||
            (prepared.input.continueOf
              ? parent.status === 'queued' || parent.status === 'running'
              : parent.status !== 'completed') ||
            !parent.hasContent
          ) {
            record = await this.finish(record, {
              code: 'PARENT_UNAVAILABLE',
              message: 'Wait for a completed or retained interrupted answer before continuing.',
              stage: 'admission',
              retryable: false,
            });
            return this.result(record, {
              runRef: this.ref(record),
              waitMs: 0,
              includeReasoning: false,
            });
          }
        }
        const accepted = await conversation.submit(
          record.conversationId,
          prepared.input,
          prepared.config,
          prepared.automaticTitle,
        );
        record = await this.finish(
          record,
          'error' in accepted
            ? {
                code: accepted.code ?? accepted.issue?.code ?? 'SUBMISSION_REJECTED',
                message:
                  accepted.issue?.code === 'CONVERSATION_BUSY'
                    ? 'This conversation already has an active generation.'
                    : accepted.error,
                stage: accepted.stage ?? 'admission',
                retryable: accepted.issue?.code === 'CONVERSATION_BUSY',
                httpStatus: accepted.status,
              }
            : { runId: accepted.runId, userId: accepted.userId, assistantId: accepted.assistantId },
        );
        await this.library.touch(record.conversationId);
      }
    }
    return this.result(record, {
      runRef: this.ref(record),
      waitMs: input.waitMs,
      includeReasoning: false,
    });
  }
  async get(input: GetArguments) {
    return this.result(await this.reconcile(await this.owned(input.runRef)), input);
  }
  async context(input: ContextGetArguments): Promise<ContextResult> {
    const record = await this.owned(input.runRef);
    const conversation = this.env.CONVERSATIONS.getByName(record.conversationId);
    const assistantId = record.submission?.assistantId;
    const state = assistantId ? await conversation.mcpStatus(assistantId) : null;
    const context = state?.context ?? unavailableContext;
    const base = {
      context: { ...context, receiptRef: context.steps ? input.runRef : null },
      receipt: null,
      items: [],
      exclusions: [],
      text: null,
      textUnit: null,
      hasMore: false,
      nextCursor: null,
    };
    if (!assistantId || !state || !context.steps) return base;
    let step = input.step,
      offset = 0;
    if (input.cursor) {
      const [requestId, view, stepValue, itemValue, offsetValue] = decodeRef(
        'context1',
        input.cursor,
        5,
      );
      step = Number(stepValue);
      offset = Number(offsetValue);
      if (
        requestId !== record.requestId ||
        view !== input.view ||
        itemValue !== String(input.item ?? '') ||
        !Number.isSafeInteger(step) ||
        step < 0 ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        fail(
          'INVALID_CURSOR',
          'This cursor does not belong to the requested input receipt.',
          'retrieval',
        );
    }
    const cursor = (at: number, round = step) =>
      encodeRef('context1', [
        record.requestId,
        input.view,
        String(round),
        String(input.item ?? ''),
        String(at),
      ]);
    if (input.view === 'metadata') {
      if (input.item === undefined) fail('INVALID_ARGUMENT', 'Specify item from a manifest page.');
      const page = await conversation.mcpContextMetadata(assistantId, step, input.item, offset);
      if (!page) fail('CONTEXT_NOT_FOUND', 'This input item is unavailable.', 'retrieval');
      if (page.state === 'invalid_cursor')
        fail('INVALID_CURSOR', 'This metadata cursor is outside the item.', 'retrieval');
      return {
        ...base,
        text: { state: page.state, text: page.text },
        textUnit: 'unicode_codepoints',
        hasMore: page.hasMore,
        nextCursor: page.hasMore ? cursor(page.nextOffset) : null,
      };
    }
    if (input.view === 'text') {
      if (input.item === undefined) fail('INVALID_ARGUMENT', 'Specify item from a manifest page.');
      const permissions = await this.library.mcpKeyPermissions(this.principal);
      const stored = await conversation.mcpContextText(
        assistantId,
        step,
        input.item,
        offset,
        permissions?.readSystemPrompts ?? false,
      );
      const result =
        stored?.state === 'document_snapshot'
          ? await this.library.documentInputPage(
              record.conversationId,
              stored.attachmentId,
              stored.documentSnapshot,
              offset,
            )
          : stored;
      if (
        permissions?.readSystemPrompts &&
        !(await this.library.mcpKeyPermissions(this.principal))?.readSystemPrompts
      )
        fail(
          'PERMISSIONS_CHANGED',
          'API key permissions changed. Retry this read.',
          'authorization',
        );
      if (!result) fail('CONTEXT_NOT_FOUND', 'This input item is unavailable.', 'retrieval');
      if (result.state === 'invalid_cursor')
        fail(
          'INVALID_CURSOR',
          'This cursor is outside the input or splits a character.',
          'retrieval',
        );
      return {
        ...base,
        text: { state: result.state, text: result.text },
        textUnit: stored?.state === 'document_snapshot' ? 'utf8_bytes' : 'utf16',
        hasMore: result.hasMore,
        nextCursor: result.hasMore ? cursor(result.nextOffset) : null,
      };
    }
    if (input.view === 'exclusions') {
      const rows = await conversation.mcpContextExclusions(assistantId, offset);
      if (!rows) fail('CONTEXT_NOT_FOUND', 'This input receipt is unavailable.', 'retrieval');
      const exclusions = rows.slice(0, 32);
      return {
        ...base,
        exclusions,
        hasMore: rows.length > 32,
        nextCursor: rows.length > 32 ? cursor(exclusions.at(-1)!.ordinal) : null,
      };
    }
    const result = await conversation.mcpContextPage(assistantId, step, offset);
    if (!result) fail('CONTEXT_NOT_FOUND', 'This input step is unavailable.', 'retrieval');
    if (!result.receipt || !result.items || result.nextOffset === undefined)
      fail('INVALID_CURSOR', 'Invalid input receipt cursor.', 'retrieval');
    const moreSteps = step + 1 < context.steps;
    return {
      ...base,
      receipt: result.receipt,
      items: result.items,
      hasMore: result.hasMore || moreSteps,
      nextCursor: result.hasMore
        ? cursor(result.nextOffset)
        : moreSteps
          ? cursor(0, step + 1)
          : null,
    };
  }
  async usage(input: UsageGetArguments): Promise<UsageResult> {
    const record = await this.owned(input.runRef);
    const assistantId = record.submission?.assistantId;
    const state = assistantId
      ? await this.env.CONVERSATIONS.getByName(record.conversationId).mcpStatus(assistantId)
      : null;
    const context = state?.context;
    const expectedAttempts =
      context && context.state !== 'unavailable'
        ? context.steps - (context.state === 'assembled' ? 1 : 0)
        : null;
    const base = {
      scope: 'answer_model_steps' as const,
      accounting: 'unavailable' as const,
      expectedAttempts,
      observedAttempts: null,
      costs: [],
      excludedCosts: [
        { kind: 'title' as const, reason: 'conversation_level_not_attributable' },
        { kind: 'summary' as const, reason: 'separate_summary_message_not_in_answer_model_steps' },
      ],
      attempts: [],
      hasMore: false,
      nextCursor: null,
    };
    if (!assistantId || !state || !this.env.USAGE) return base;
    if (input.view === 'costs') {
      let after: { kind: string; currency: string } | undefined, revision: string | undefined;
      if (input.cursor) {
        const [requestId, expected, kind, currency] = decodeRef('costs1', input.cursor, 4);
        if (requestId !== record.requestId)
          fail('INVALID_CURSOR', 'This cost cursor belongs to another run.', 'retrieval');
        after = { kind, currency };
        revision = expected;
      }
      const page = await this.env.USAGE.getByName('personal').mcpCosts(assistantId, after);
      if (revision !== undefined && revision !== page.revision)
        fail(
          'SNAPSHOT_CHANGED',
          'Accounting changed. Restart the cost summary without a cursor.',
          'retrieval',
        );
      const complete =
        expectedAttempts !== null && page.count === expectedAttempts && !page.pending;
      const last = page.records.at(-1);
      return {
        ...base,
        accounting: complete ? 'ready' : 'pending_accounting',
        observedAttempts: page.count,
        costs: page.records.map((row) => {
          const priced =
            row.priced === row.attempts && row.pending === 0 && (row.kind !== 'chat' || complete);
          return {
            kind: row.kind as 'chat' | 'web_search' | 'read_webpage',
            includedInAnswer: row.kind === 'chat',
            currency: row.currency || null,
            amount: priced ? formatAmount(row.amount, 12) : null,
            knownSubtotal: row.known ? formatAmount(row.amount, 12) : null,
            state: priced
              ? ('priced' as const)
              : row.known
                ? ('partial' as const)
                : ('unpriced' as const),
            attempts: row.attempts,
            pricedAttempts: row.priced,
            finalized: row.pending === 0 && state.status !== 'queued' && state.status !== 'running',
          };
        }),
        hasMore: page.hasMore,
        nextCursor:
          page.hasMore && last
            ? encodeRef('costs1', [record.requestId, page.revision, last.kind, last.currency])
            : null,
      };
    }
    let after: { startedAt: number; id: string } | undefined;
    if (input.cursor) {
      const [requestId, time, id] = decodeRef('usage1', input.cursor, 3);
      const startedAt = Number(time);
      if (requestId !== record.requestId || !Number.isSafeInteger(startedAt) || startedAt < 0)
        fail('INVALID_CURSOR', 'This cursor does not belong to the requested run.', 'retrieval');
      after = { startedAt, id };
    }
    const page = await this.env.USAGE.getByName('personal').mcpPage(assistantId, after);
    const last = page.records.at(-1);
    return {
      ...base,
      accounting:
        page.pending || (expectedAttempts !== null && page.count < expectedAttempts)
          ? 'pending_accounting'
          : 'ready',
      observedAttempts: page.count,
      attempts: page.records.map((attempt) => {
        const normalized = addGenerationUsage(undefined, {
          usage: attempt.usage,
          usageSources: attempt.usageSources,
          usageIsFinal: attempt.usageIsFinal,
        });
        return {
          id: attempt.id,
          stepId: attempt.taskId,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt,
          model: attempt.model,
          providerName: attempt.providerName,
          protocol: attempt.protocol,
          status: attempt.status,
          usage: mcpUsage(
            attempt.usage,
            attempt.usageSources,
            normalized.usageCoverage,
            1,
            attempt.usageIsFinal,
            attempt.status !== 'running',
            attempt.protocol,
          ),
          cost: {
            currency: attempt.cost.currency,
            amount: attempt.cost.amount === null ? null : formatAmount(attempt.cost.amount, 12),
            state: attempt.cost.state,
            source: attempt.price?.source ?? null,
            priceEffectiveAt: attempt.price?.effectiveFrom ?? null,
            priceId: attempt.price?.id ?? null,
          },
        };
      }),
      hasMore: page.hasMore,
      nextCursor:
        page.hasMore && last
          ? encodeRef('usage1', [record.requestId, String(last.startedAt), last.id])
          : null,
    };
  }
  async cancel(runRef: string) {
    let record = await this.owned(runRef);
    if (!record.failure) {
      const accepted = await this.env.CONVERSATIONS.getByName(
        record.conversationId,
      ).mcpCancelSubmission(record.requestId);
      record = await this.finish(
        record,
        'error' in accepted
          ? {
              code: 'CANCELLED',
              message: 'Request cancelled before generation.',
              stage: 'cancellation',
              retryable: false,
            }
          : { runId: accepted.runId, assistantId: accepted.assistantId, userId: accepted.userId },
      );
    }
    return this.result(record, { runRef, waitMs: 0, includeReasoning: false });
  }
  private async result(record: McpRecord, input: GetArguments): Promise<RunResult> {
    const url = new URL(`/c/${record.conversationId}`, this.env.APP_ORIGIN!);
    if (record.submission) url.searchParams.set('branch', record.submission.assistantId);
    const base = {
      runRef: this.ref(record),
      conversationId: record.conversationId,
      model: record.model,
      output: {
        text: '',
        hasMore: false,
        resumeCursor: null,
        contentFinal: false,
        consistency: 'durable' as const,
        persistedAt: null,
        revision: null,
      },
      completion: null,
      progress: null,
      context: unavailableContext,
      providerResponse: null,
      pollAfterMs: 2000,
      usage: mcpUsage({}, undefined, undefined, 0, false, false),
      url: url.href,
    };
    if (record.failure)
      return {
        ...base,
        status: record.failure.code === 'CANCELLED' ? 'cancelled' : 'failed',
        output: { ...base.output, contentFinal: true },
        completion: readCompletion(record.failure.code === 'CANCELLED' ? 'cancelled' : 'failed'),
        pollAfterMs: 0,
        usage: mcpUsage({}, undefined, undefined, 0, false, true),
        error: record.failure,
      };
    if (!record.submission)
      return {
        ...base,
        status: 'accepted',
        error: {
          code: 'SUBMISSION_UNCONFIRMED',
          message:
            'Acceptance is not yet confirmed. Retry everchat_chat with the original requestId and input; never create a new requestId for a transport retry.',
          stage: 'submission',
          retryable: true,
        },
      };
    const assistantId = record.submission.assistantId;
    const conversation = this.env.CONVERSATIONS.getByName(record.conversationId);
    const deadline = Date.now() + input.waitMs;
    let state = await conversation.mcpStatus(assistantId),
      delay = 1000;
    while (
      state &&
      (state.status === 'queued' || state.status === 'running') &&
      Date.now() < deadline &&
      !this.signal?.aborted
    ) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(delay, deadline - Date.now()));
        this.signal?.addEventListener('abort', done, { once: true });
      });
      state = await conversation.mcpStatus(assistantId);
      delay = Math.min(4000, delay * 2);
    }
    if (!state) fail('RUN_NOT_FOUND', 'The answer was deleted or is unavailable.', 'retrieval');
    const status =
      state.status === 'queued'
        ? 'accepted'
        : state.status === 'completed' && state.interrupted
          ? 'interrupted'
          : state.status;
    const pending = status === 'accepted' || status === 'running';
    const observedAt = Date.now();
    const page = async (channel: 'content' | 'reasoning', cursor?: string) => {
      let offset = 0;
      let epoch: number | undefined;
      if (cursor) {
        const [requestId, id, expectedChannel, epochValue, value] = decodeRef('page2', cursor, 5);
        offset = Number(value);
        epoch = Number(epochValue);
        if (
          requestId !== record.requestId ||
          id !== assistantId ||
          expectedChannel !== channel ||
          !Number.isSafeInteger(epoch) ||
          epoch < 0 ||
          !Number.isSafeInteger(offset) ||
          offset < 0
        )
          fail(
            'INVALID_CURSOR',
            'This cursor does not belong to the requested output.',
            'retrieval',
          );
      }
      const result = await conversation.mcpPage(assistantId, channel, offset, epoch);
      if (!result) fail('RUN_NOT_FOUND', 'The answer was deleted or is unavailable.', 'retrieval');
      if ('error' in result) {
        if (result.error === 'output_changed')
          fail(
            'OUTPUT_CHANGED',
            'The provider replaced earlier text in this channel. Read it again without a cursor.',
            'retrieval',
          );
        fail(
          'INVALID_CURSOR',
          'This cursor is beyond the persisted output or splits a character.',
          'retrieval',
        );
      }
      const resumeCursor = encodeRef('page2', [
        record.requestId,
        assistantId,
        channel,
        String(result.epoch),
        String(result.nextOffset),
      ]);
      return {
        text: result.text,
        hasMore: result.hasMore,
        resumeCursor,
        contentFinal: !pending,
        consistency: 'durable' as const,
        persistedAt: result.persistedAt,
        revision: result.revision,
        ...(result.hasMore ? { nextCursor: resumeCursor } : {}),
      };
    };
    return {
      ...base,
      status,
      assistantMessageId: assistantId,
      usage: state.usage,
      context: { ...state.context, receiptRef: state.context.steps ? this.ref(record) : null },
      providerResponse: state.providerResponse,
      completion: readCompletion(status, state),
      progress: state.progress
        ? {
            ...state.progress,
            observedAt,
            elapsedMs: Math.max(0, observedAt - state.progress.acceptedAt),
            phaseElapsedMs: Math.max(0, observedAt - state.progress.phaseStartedAt),
            stale: pending && observedAt - state.progress.lastProgressAt >= 60_000,
            staleAfterMs: 60_000,
          }
        : null,
      pollAfterMs: pending ? 2000 : 0,
      ...(state.finishReason ? { finishReason: state.finishReason } : {}),
      ...(state.continuedFrom ? { continuedFrom: state.continuedFrom } : {}),
      output: await page('content', input.outputCursor),
      ...(input.includeReasoning
        ? { reasoning: await page('reasoning', input.reasoningCursor) }
        : {}),
      ...(!pending && state.hasContent
        ? {
            continuation: encodeRef('continue1', [
              record.conversationId,
              record.requestId,
              assistantId,
            ]),
          }
        : {}),
      ...(state.failure
        ? {
            error: {
              code: 'PROVIDER_ERROR',
              message: 'Generation was interrupted by a provider error. Saved output is retained.',
              retryable: false,
              ...state.failure,
            },
          }
        : {}),
    };
  }
}
