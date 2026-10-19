import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../http/env';
import { HttpError, json } from '../http/response';
import { initializeStorageSchema } from '../platform/storage-schema';
import type { ShareBlock, ShareExpiry, SharePreview } from '../../shared/sharing/types';
import { decryptToken, encryptToken, randomShareSecret, tokenHash } from './crypto';
import { ShareRepository, publicShare, snapshotHasher, unavailable, type ShareRow } from './store';
import { SHARING_SCHEMA } from './schema';

interface PrepareInput {
  operationId: string;
  conversationId: string;
  headId: string;
  includeReasoning: boolean;
  title: string;
}

export class ShareStore extends DurableObject<Env> {
  private readonly repository: ShareRepository;
  private readonly pendingPreviews = new Map<
    string,
    { identity: string; promise: Promise<SharePreview> }
  >();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      initializeStorageSchema(ctx.storage.sql.exec.bind(ctx.storage.sql), 1);
      ctx.storage.sql.exec(SHARING_SCHEMA);
    });
    this.repository = new ShareRepository(ctx.storage.sql.exec.bind(ctx.storage.sql));
  }
  private async respond(action: () => unknown | Promise<unknown>) {
    try {
      return json(await action());
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Share operation failed', error instanceof Error ? error.name : 'UnknownError');
      return json({ error: '分享服务暂时不可用。' }, 503);
    }
  }
  private owner(id: string) {
    const row = this.repository.get(id);
    if (!row) throw unavailable();
    return row;
  }
  private secret() {
    const secret = this.env.SHARE_LINK_KEY;
    if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret))
      throw new HttpError(503, '分享链接密钥尚未配置。');
    return secret;
  }
  private async credentials(id: string) {
    const token = randomShareSecret();
    return { hash: tokenHash(token), cipher: await encryptToken(token, this.secret(), id) };
  }
  private async ownerResult(row: ShareRow) {
    return {
      share: this.repository.managed(row),
      secret: await decryptToken(row.tokenCipher!, this.secret(), row.id),
    };
  }
  private async scheduleCleanup() {
    const at = this.repository.nextCleanup();
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }
  prepare(input: PrepareInput) {
    return this.respond(async () => {
      const identity = JSON.stringify([input.conversationId, input.headId, input.includeReasoning]);
      const pending = this.pendingPreviews.get(input.operationId);
      if (pending) {
        if (pending.identity !== identity) throw new HttpError(409, '预览操作已改变，请重新预览。');
        return pending.promise;
      }
      const promise = this.prepareSnapshot(input).finally(() => {
        this.pendingPreviews.delete(input.operationId);
      });
      this.pendingPreviews.set(input.operationId, { identity, promise });
      return promise;
    });
  }
  private async prepareSnapshot(input: PrepareInput): Promise<SharePreview> {
    this.secret();
    const row = this.repository.begin(input);
    // Schedule even failed transfers, so an incomplete draft cannot live forever.
    await this.scheduleCleanup();
    if (!row.hash) {
      const source = await this.env.CONVERSATIONS.getByName(
        input.conversationId,
      ).shareSourceResponse(input.headId, input.includeReasoning);
      if (!source.ok || !source.body) {
        await source.body?.cancel();
        throw new HttpError(
          source.status === 404 ? 404 : 409,
          '当前分支无法分享，请等待回答完成后重新预览。',
        );
      }
      this.repository.resetDraft(row.id);
      const reader = source.body.getReader(),
        decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }),
        hash = snapshotHasher();
      let buffer = '',
        header: { version: string; messageCount: number; omittedAttachments: number } | undefined,
        seq = 0,
        complete = false;
      const seen = new Set<number>();
      const line = (value: string) => {
        if (!header) {
          header = JSON.parse(value) as {
            version: string;
            messageCount: number;
            omittedAttachments: number;
          };
          if (
            !header ||
            typeof header.version !== 'string' ||
            !Number.isSafeInteger(header.messageCount) ||
            header.messageCount <= 0
          )
            throw new Error('Invalid snapshot header');
        } else {
          const marker = JSON.parse(value) as { complete?: boolean; blockCount?: number };
          if (complete) throw new Error('Unexpected snapshot tail');
          if (marker.complete === true) {
            if (marker.blockCount !== seq || seen.size !== header.messageCount)
              throw new Error('Incomplete snapshot blocks');
            complete = true;
            return;
          }
          const block = JSON.parse(value) as ShareBlock;
          if (
            !Number.isSafeInteger(block.message) ||
            block.message < 0 ||
            block.message >= header.messageCount ||
            !['user', 'assistant'].includes(block.role) ||
            !['text', 'reasoning'].includes(block.channel) ||
            typeof block.text !== 'string' ||
            block.text.length > 16_384 ||
            (!input.includeReasoning && block.channel === 'reasoning')
          )
            throw new Error('Invalid share block');
          hash.update(value + '\n');
          seen.add(block.message);
          this.repository.append(row.id, seq++, block);
        }
      };
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          const current = this.repository.get(row.id);
          if (
            !current ||
            current.status !== 'draft' ||
            current.draftUntil <= Date.now() ||
            this.repository.deleted(input.conversationId)
          )
            throw new HttpError(410, '预览已失效，请重新预览。');
          buffer += decoder.decode(result.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            line(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
          }
          if (buffer.length > 200_000) throw new Error('Oversized snapshot line');
        }
        buffer += decoder.decode();
        if (buffer || !header || !seq || !complete) throw new Error('Incomplete snapshot');
        this.repository.finishDraft(
          row.id,
          header.version,
          header.messageCount,
          seq,
          header.omittedAttachments,
          hash.digest('hex'),
        );
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    await this.scheduleCleanup();
    const ready = this.owner(row.id);
    return { share: this.repository.managed(ready), page: this.repository.page(ready) };
  }
  preview(id: string, cursor: number) {
    return this.respond(() => {
      const row = this.owner(id);
      if (row.status !== 'draft' || row.draftUntil <= Date.now()) throw unavailable();
      return this.repository.page(row, cursor);
    });
  }
  publish(id: string, input: { hash: string; title: string; expiry: ShareExpiry }) {
    return this.respond(async () => {
      const before = this.owner(id);
      if (before.status === 'active') return this.ownerResult(before);
      if (
        (await this.env.CONVERSATIONS.getByName(before.conversationId).shareSourceVersion()) !==
        before.sourceVersion
      )
        throw new HttpError(409, '对话已变化，请重新预览后分享。');
      const token = await this.credentials(id);
      const row = this.ctx.storage.transactionSync(() =>
        this.repository.publish(
          id,
          input.hash,
          input.title,
          input.expiry,
          token.hash,
          token.cipher,
        ),
      );
      await this.scheduleCleanup();
      return this.ownerResult(row);
    });
  }
  list(cursor?: { createdAt: number; id: string }) {
    return this.respond(() => this.repository.list(cursor));
  }
  link(id: string) {
    return this.respond(async () => {
      const row = this.owner(id);
      if (this.repository.managed(row).status !== 'active') throw unavailable();
      return this.ownerResult(row);
    });
  }
  update(id: string, input: { expiry?: ShareExpiry; rotate?: boolean }) {
    return this.respond(async () => {
      const rotate = input.rotate ? await this.credentials(id) : undefined;
      const row = this.ctx.storage.transactionSync(() =>
        this.repository.update(id, { expiry: input.expiry, rotate }),
      );
      await this.scheduleCleanup();
      return this.ownerResult(row);
    });
  }
  revoke(id: string) {
    return this.respond(async () => {
      const result = this.ctx.storage.transactionSync(() => this.repository.revoke(id));
      await this.scheduleCleanup();
      return result;
    });
  }
  purge(id: string) {
    return this.respond(() => {
      this.ctx.storage.transactionSync(() => this.repository.purge(id));
      return { deleted: true };
    });
  }
  revokeConversation(conversationId: string) {
    this.ctx.storage.transactionSync(() => this.repository.revokeConversation(conversationId));
    this.ctx.waitUntil(this.scheduleCleanup());
  }
  read(id: string, token: string, cursor?: number) {
    return this.respond(() => {
      const row = this.repository.authorize(id, token);
      return cursor === undefined
        ? { share: publicShare(row), page: this.repository.page(row) }
        : this.repository.page(row, cursor);
    });
  }
  async alarm() {
    this.ctx.storage.transactionSync(() => this.repository.cleanup());
    await this.scheduleCleanup();
  }
}
