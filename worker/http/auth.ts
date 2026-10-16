import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AccessIdentity } from '../../shared/auth/types';
import type { Env } from './env';
import { HttpError } from './response';

export interface AccessPrincipal extends AccessIdentity {
  expires: number;
}
export type Authenticator = (request: Request, env: Env) => Promise<AccessPrincipal>;
export interface AccessTrust {
  issuer: string;
  audience: string;
  origin: string;
  emails: string[];
  jwks: JWTVerifyGetKey;
  serviceIds?: string[];
}
export function createAccessVerifier(trust: AccessTrust): Authenticator {
  const verified = new WeakMap<Request, Promise<AccessPrincipal>>();
  return (request) => {
    const previous = verified.get(request);
    if (previous) return previous;
    const result = (async () => {
      if (new URL(request.url).origin !== trust.origin)
        throw new HttpError(403, '此应用地址未获准访问。', 'ACCESS_DENIED');
      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token) throw new HttpError(401, '请重新登录。', 'AUTH_REQUIRED');
      let payload;
      try {
        ({ payload } = await jwtVerify(token, trust.jwks, {
          issuer: trust.issuer,
          audience: trust.audience,
          algorithms: ['RS256'],
          requiredClaims: ['exp', 'iat', 'iss', 'aud', 'type'],
        }));
      } catch (error) {
        if (
          error instanceof errors.JOSEError &&
          !(error instanceof errors.JWKSTimeout) &&
          !(error instanceof errors.JWKSInvalid) &&
          !(error instanceof errors.JWKInvalid)
        )
          throw new HttpError(401, '请重新登录。', 'AUTH_REQUIRED');
        throw new HttpError(503, '暂时无法验证访问身份，请稍后重试。', 'AUTH_UNAVAILABLE');
      }
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
      const service = typeof payload.common_name === 'string' ? payload.common_name : '';
      if (payload.type !== 'app')
        throw new HttpError(403, '此身份无法访问这个空间。', 'ACCESS_DENIED');
      if (service && trust.serviceIds?.includes(service))
        return {
          issuer: trust.issuer,
          sub: `service:${service}`,
          email: '',
          expires: payload.exp!,
        };
      if (!payload.sub || !email || !trust.emails.includes(email))
        throw new HttpError(403, '此身份无法访问这个空间。', 'ACCESS_DENIED');
      return { issuer: trust.issuer, sub: payload.sub, email, expires: payload.exp! };
    })();
    verified.set(request, result);
    return result;
  };
}
const verifiers = new Map<string, Authenticator>();
export function accessAuthenticator(env: Env, serviceIds?: string[]): Authenticator {
  const domain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  const emails = (env.ACCESS_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  let origin: string;
  try {
    const url = new URL(env.APP_ORIGIN ?? '');
    if (url.protocol !== 'https:' || url.href !== `${url.origin}/`) throw new Error();
    origin = url.origin;
  } catch {
    throw new HttpError(503, '请配置 Access 应用地址。', 'AUTH_CONFIGURATION');
  }
  if (
    !domain ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(domain) ||
    !env.ACCESS_AUD ||
    (!emails.length && !serviceIds?.length)
  )
    throw new HttpError(503, '请配置 Access 团队域名、AUD 和允许的身份。', 'AUTH_CONFIGURATION');
  const key = JSON.stringify([domain, env.ACCESS_AUD, origin, emails, serviceIds]);
  let verifier = verifiers.get(key);
  if (!verifier) {
    const issuer = `https://${domain}`;
    verifier = createAccessVerifier({
      issuer,
      origin,
      audience: env.ACCESS_AUD,
      emails,
      serviceIds,
      jwks: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
        timeoutDuration: 5000,
      }),
    });
    if (verifiers.size >= 8) verifiers.clear();
    verifiers.set(key, verifier);
  }
  return verifier;
}
export const authenticateAccess: Authenticator = async (request, env) =>
  accessAuthenticator(env)(request, env);
