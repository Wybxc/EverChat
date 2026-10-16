import type { ProviderFailure } from '../../shared/providers/failure';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly details?: ProviderFailure,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
export class GenerationCancelled extends Error {}
