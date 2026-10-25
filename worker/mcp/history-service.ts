import type { Env } from '../http/env';
import { decodeRef, encodeRef, fail, McpError, type ConversationReadArguments } from './contracts';
import { markdownRecords, type HistoryPosition, type HistorySnapshot } from './history';

export class McpHistoryService {
  private readonly library;
  constructor(
    private readonly env: Env,
    private readonly principal: string,
  ) {
    this.library = env.LIBRARY.getByName('personal');
  }
  private async allowed(ref: string) {
    const [id] = decodeRef('conversation1', ref, 1);
    if (!(await this.library.mcpConversationAllowed(this.principal, id)))
      fail(
        'CONVERSATION_UNAVAILABLE',
        'This conversation is not authorized for this API key.',
        'authorization',
      );
    return id;
  }
  async list(cursor?: string) {
    let after: { createdAt: number; id: string } | undefined;
    if (cursor) {
      const [principal, at, id] = decodeRef('conversations1', cursor, 3);
      const createdAt = Number(at);
      if (principal !== this.principal || !Number.isSafeInteger(createdAt) || createdAt < 0)
        fail('INVALID_CURSOR', 'Invalid conversation cursor.', 'retrieval');
      after = { createdAt, id };
    }
    const rows = await this.library.mcpConversations(this.principal, after),
      page = rows.slice(0, 16),
      last = page.at(-1);
    return {
      conversations: page.map((row) => ({ ...row, ref: encodeRef('conversation1', [row.id]) })),
      hasMore: rows.length > 16,
      nextCursor:
        rows.length > 16 && last
          ? encodeRef('conversations1', [this.principal, String(last.createdAt), last.id])
          : null,
    };
  }
  async read(input: ConversationReadArguments) {
    const id = await this.allowed(input.conversationRef),
      conversation = this.env.CONVERSATIONS.getByName(id);
    if (
      input.fromRound !== undefined &&
      input.toRound !== undefined &&
      input.toRound < input.fromRound
    )
      fail('INVALID_ARGUMENT', 'toRound must not precede fromRound.');
    const base = {
      conversationRef: input.conversationRef,
      headId: input.headId ?? null,
      revision: null,
      epoch: null,
      partial: false,
      heads: [],
      records: [],
      hasMore: false,
      nextCursor: null,
    };
    if (input.view === 'branches') {
      let after = 0;
      if (input.cursor) {
        const [conversationId, value] = decodeRef('branches1', input.cursor, 2);
        after = Number(value);
        if (conversationId !== id || !Number.isSafeInteger(after) || after < 0)
          fail('INVALID_CURSOR', 'Invalid branch cursor.', 'retrieval');
      }
      const page = await conversation.mcpBranches(after);
      if (!page) fail('CONVERSATION_UNAVAILABLE', 'This conversation was deleted.', 'retrieval');
      await this.allowed(input.conversationRef);
      return {
        ...base,
        heads: page.heads.map(({ ordinal: _, ...head }) => head),
        hasMore: page.hasMore,
        nextCursor: page.hasMore
          ? encodeRef('branches1', [id, String(page.heads.at(-1)!.ordinal)])
          : null,
      };
    }
    if (!input.headId) fail('INVALID_ARGUMENT', 'Specify headId, discovered using view=branches.');
    const options = {
      includeReasoning: input.includeReasoning,
      includeTools: input.includeTools,
      includeActive: input.includeActive,
      fromRound: input.fromRound,
      toRound: input.toRound,
    };
    const signature = JSON.stringify(options);
    let snapshot: HistorySnapshot | undefined, position: HistoryPosition | undefined;
    if (input.cursor) {
      const [conversationId, headId, expected, seq, epoch, part] = decodeRef(
        'history1',
        input.cursor,
        6,
      );
      if (conversationId !== id || headId !== input.headId || expected !== signature)
        fail(
          'INVALID_CURSOR',
          'Use this cursor with the same branch and read options.',
          'retrieval',
        );
      try {
        const value = JSON.parse(part) as HistoryPosition;
        if (
          !Number.isSafeInteger(Number(seq)) ||
          Number(seq) < 0 ||
          !Number.isSafeInteger(value.index) ||
          value.index < 0 ||
          !Number.isSafeInteger(value.offset) ||
          value.offset < 0 ||
          (value.item !== undefined && (!Number.isSafeInteger(value.item) || value.item < 0)) ||
          !['metadata', 'content', 'reasoning', 'attachments', 'summary', 'tools'].includes(
            value.section,
          )
        )
          throw new Error();
        snapshot = { seq: Number(seq), epoch };
        position = value;
      } catch {
        fail('INVALID_CURSOR', 'Invalid branch position.', 'retrieval');
      }
    }
    const result = await conversation.mcpHistory(id, input.headId, {
      ...options,
      snapshot,
      position,
    });
    if (!result) fail('CONVERSATION_UNAVAILABLE', 'This conversation was deleted.', 'retrieval');
    if (result.error) throw new McpError(result.error);
    await this.allowed(input.conversationRef);
    const page = result.value;
    return {
      ...base,
      headId: input.headId,
      revision: page.snapshot.seq,
      epoch: page.snapshot.epoch,
      partial: page.partial,
      records: page.records,
      hasMore: page.position !== null,
      nextCursor: page.position
        ? encodeRef('history1', [
            id,
            input.headId,
            signature,
            String(page.snapshot.seq),
            page.snapshot.epoch,
            JSON.stringify(page.position),
          ])
        : null,
    };
  }
  async export(input: ConversationReadArguments) {
    if (input.view !== 'branch')
      fail('INVALID_ARGUMENT', 'Markdown export requires a branch head.');
    const page = await this.read(input);
    return {
      conversationRef: page.conversationRef,
      headId: input.headId!,
      revision: page.revision!,
      epoch: page.epoch!,
      partial: page.partial,
      format: 'markdown' as const,
      text:
        (!input.cursor
          ? `# EverChat discussion\n\n${JSON.stringify({ conversationRef: page.conversationRef, headId: input.headId, revision: page.revision, epoch: page.epoch, partial: page.partial })}\n`
          : '') + markdownRecords(page.records),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }
}
