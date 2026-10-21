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
} from './contracts';
import type { McpRecord } from './store';

function unwrap<T>(result: { value: T } | { error: McpFailure }): T {
  if ('error' in result) throw new McpError(result.error);
  return result.value;
}
export class McpChatService {
  private readonly principal: string;
  private readonly library;
  constructor(
    private readonly env: Env,
    identity: McpPrincipal,
    private readonly signal?: AbortSignal,
  ) {
    this.principal = identity.keyId;
    this.library = env.LIBRARY.getByName('personal');
  }
  async models() {
    return unwrap(await this.library.mcpCatalog());
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
        if (input.continuation && prepared.input.parentId) {
          const parent = await conversation.mcpStatus(prepared.input.parentId);
          if (!parent || parent.status !== 'completed' || !parent.hasContent) {
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
                    : 'The request was rejected. Check model capabilities, parameters and workspace capacity.',
                stage: accepted.stage ?? 'admission',
                retryable: false,
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
      output: { text: '', hasMore: false },
      usage: { isFinal: false },
      url: url.href,
    };
    if (record.failure)
      return {
        ...base,
        status: record.failure.code === 'CANCELLED' ? 'cancelled' : 'failed',
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
    const page = async (channel: 'content' | 'reasoning', cursor?: string) => {
      let offset = 0;
      if (cursor) {
        const [id, expectedChannel, value] = decodeRef('page1', cursor, 3);
        offset = Number(value);
        if (
          id !== assistantId ||
          expectedChannel !== channel ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > 768 * 1024
        )
          fail(
            'INVALID_CURSOR',
            'This cursor does not belong to the requested output.',
            'retrieval',
          );
      }
      const result = await conversation.mcpPage(assistantId, channel, offset);
      if (!result) fail('RUN_NOT_FOUND', 'The answer was deleted or is unavailable.', 'retrieval');
      return {
        text: result.text,
        hasMore: result.hasMore,
        ...(result.hasMore
          ? { nextCursor: encodeRef('page1', [assistantId, channel, String(result.nextOffset)]) }
          : {}),
      };
    };
    return {
      ...base,
      status,
      assistantMessageId: assistantId,
      usage: state.usage,
      ...(state.finishReason ? { finishReason: state.finishReason } : {}),
      ...(pending ? {} : { output: await page('content', input.outputCursor) }),
      ...(!pending && input.includeReasoning
        ? { reasoning: await page('reasoning', input.reasoningCursor) }
        : {}),
      ...((status === 'completed' || status === 'interrupted') && state.hasContent
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
