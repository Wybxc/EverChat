import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../http/env';
import { initializeStorageSchema } from '../platform/storage-schema';
import type { UsageAttempt, UsageFilter, UsagePriceInput } from '../../shared/usage/types';
import { UsageLedger } from './store';
import { USAGE_SCHEMA } from './schema';
import { json } from '../http/response';

export class UsageStore extends DurableObject<Env> {
  private readonly ledger: UsageLedger;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      initializeStorageSchema(ctx.storage.sql.exec.bind(ctx.storage.sql), 1);
      ctx.storage.sql.exec(USAGE_SCHEMA);
    });
    this.ledger = new UsageLedger(ctx.storage.sql.exec.bind(ctx.storage.sql));
  }
  price(providerId: string, model: string) {
    return this.ledger.price(providerId, model);
  }
  prices() {
    return this.ledger.prices();
  }
  dimensions() {
    return this.ledger.dimensions();
  }
  answer(messageId: string) {
    return this.ledger.answer(messageId);
  }
  savePrice(input: UsagePriceInput) {
    return this.ctx.storage.transactionSync(() => this.ledger.savePrice(input));
  }
  record(attempt: UsageAttempt) {
    this.ctx.storage.transactionSync(() => this.ledger.record(attempt));
  }
  page(filter: UsageFilter) {
    return json(this.ledger.page(filter));
  }
  report(filter: UsageFilter, timeZone: string, hourly: boolean) {
    return json(this.ledger.report(filter, timeZone, hourly));
  }
  correct(id: string, amount: string, reason: string) {
    return this.ctx.storage.transactionSync(() => this.ledger.correct(id, amount, reason));
  }
  reprice(id: string) {
    return this.ctx.storage.transactionSync(() => this.ledger.reprice(id));
  }
}
