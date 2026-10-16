import { accessAuthenticator, type Authenticator } from '../../../worker/http/auth';
import type { Env } from '../../../worker/http/env';

export const authenticateValidation: Authenticator = async (request, env) => {
  const ids = (
    (env as Env & { VALIDATION_ACCESS_SERVICE_IDS?: string }).VALIDATION_ACCESS_SERVICE_IDS ?? ''
  )
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return accessAuthenticator(env, ids)(request, env);
};
