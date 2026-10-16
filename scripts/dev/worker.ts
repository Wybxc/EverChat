// Local entry only; the production entry never imports this adapter or its trust source.
import { createLocalJWKSet, type JWK } from 'jose';
import { createAccessVerifier, type Authenticator } from '../../worker/http/auth';
import { HttpError } from '../../worker/http/response';
import { createWorker } from '../../worker/http/worker';
export { Conversation } from '../../worker/conversation/durable-object';
export { Library } from '../../worker/library/durable-object';
export { WebToolWorkflow } from '../../worker/web-tools/workflow';

const verifiers = new Map<string, Authenticator>();
export const authenticateLocal: Authenticator = async (request, env) => {
  const local = env as typeof env & { DEV_ACCESS_PUBLIC_JWK?: string; DEV_ACCESS_ORIGIN?: string };
  const key = JSON.stringify([local.DEV_ACCESS_ORIGIN, local.DEV_ACCESS_PUBLIC_JWK]);
  if (!local.DEV_ACCESS_PUBLIC_JWK || !local.DEV_ACCESS_ORIGIN)
    throw new HttpError(503, '本地签名身份尚未初始化。', 'AUTH_CONFIGURATION');
  let verify = verifiers.get(key);
  if (!verify) {
    verify = createAccessVerifier({
      issuer: 'http://everchat.local.invalid',
      audience: 'everchat-local',
      origin: local.DEV_ACCESS_ORIGIN,
      emails: ['developer@everchat.local'],
      jwks: createLocalJWKSet({ keys: [JSON.parse(local.DEV_ACCESS_PUBLIC_JWK) as JWK] }),
    });
    verifiers.set(key, verify);
  }
  const headers = new Headers(request.headers);
  // Always overwrite client assertions: this isolated entry only trusts locally signed cookies.
  headers.delete('Cf-Access-Jwt-Assertion');
  const token = headers
    .get('Cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('everchat_dev_access='))
    ?.slice('everchat_dev_access='.length);
  if (token) headers.set('Cf-Access-Jwt-Assertion', token);
  return verify(new Request(request.url, { headers }), env);
};
export const localWorker = createWorker(authenticateLocal, '/__dev/access/login');
export default localWorker;
