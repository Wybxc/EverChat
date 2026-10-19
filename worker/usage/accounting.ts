import type { ProviderConfig } from '../../shared/providers/types';
import type { UsageAttempt } from '../../shared/usage/types';
import type { Env } from '../http/env';
import type { SqlQuery } from '../generation/metrics';
import { UsageOutbox } from './outbox';
import { catalogPrice } from '../../shared/usage/catalog';

export type AttemptIdentity = Pick<
  UsageAttempt,
  'id' | 'taskId' | 'conversationId' | 'messageId' | 'kind' | 'answer'
>;
export function modelIdentity(config: ProviderConfig) {
  return {
    providerId: config.providerId ?? 'environment',
    providerName: config.providerName ?? config.provider,
    protocol: config.provider,
    model: config.model,
    modelName: config.modelName ?? config.model,
    baseUrl: config.baseUrl,
  };
}

/** Local durable delivery, never another supplier request. No per-token work. */
export class UsageAccounting extends UsageOutbox {
  constructor(
    query: SqlQuery,
    private readonly env: Pick<Env, 'USAGE'>,
    private readonly sync: () => Promise<void>,
    private readonly live = () => true,
  ) {
    super(query);
  }
  async start(
    identity: AttemptIdentity,
    model: Pick<
      UsageAttempt,
      'providerId' | 'providerName' | 'protocol' | 'model' | 'modelName'
    > & { baseUrl?: string },
  ) {
    if (!this.env.USAGE) return;
    const manualPrice = await this.env.USAGE.getByName('personal')
      .price(model.providerId, model.model)
      .catch(() => undefined);
    if (!this.live()) throw new DOMException('Request cancelled', 'AbortError');
    const { baseUrl, ...identityModel } = model;
    const price =
      manualPrice === undefined
        ? null
        : (manualPrice ?? (baseUrl ? catalogPrice(model.providerId, model.model, baseUrl) : null));
    this.begin({ ...identity, ...identityModel, startedAt: Date.now() }, price);
    // This fact must survive before the external side effect is possible.
    await this.sync();
  }
  async deliver() {
    if (!this.env.USAGE) return;
    await this.sync();
    await this.flush((attempt) => this.env.USAGE!.getByName('personal').record(attempt));
  }
}
