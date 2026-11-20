import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { identityKey, type AccessIdentity } from '../../shared/auth/types';
import type { McpOAuthConnection } from '../../shared/mcp/types';
import type { Env } from '../http/env';
import { mcpOAuthConfig, mcpOAuthScope } from './oauth-config';
import { oauthPrincipalPrefix } from './principal';

const namespace = 'mcp:oauth:v1:';
const grants = `${namespace}grant:`;
const consent = `${namespace}consent:`;
const spent = `${namespace}spent:`;
const expirations = `${namespace}expires:`;
const consentDuration = 10 * 60 * 1000;
const codeDuration = 5 * 60 * 1000;
const accessDuration = 15 * 60 * 1000;
const grantDuration = 30 * 24 * 60 * 60 * 1000;
const lastUsedInterval = 60 * 60 * 1000;

export interface McpAuthorizationRequest {
  clientId: string;
  name: string;
  redirectUri: string;
  resource: string;
  state?: string;
  challenge: string;
}

type Consent = {
  owner: AccessIdentity;
  request: McpAuthorizationRequest;
  secretHash: string;
  expiresAt: number;
};

type Credential = { hash: string; expiresAt: number };

type Grant = {
  owner: AccessIdentity;
  request: Omit<McpAuthorizationRequest, 'state'>;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  code: Credential;
  access?: Credential;
  refreshHash?: string;
};

type CodeExchange = {
  code: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  verifier: string;
};

type RefreshExchange = {
  refreshToken: string;
  clientId: string;
  resource: string;
};

const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equals = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const credential = (kind: 'code' | 'access' | 'refresh', id: string) =>
  `ec_oauth_${kind}_${id}_${secret()}`;
const credentials = /^ec_oauth_(code|access|refresh)_([0-9a-f-]{36})_[A-Za-z0-9_-]{43}$/;
const expiresKey = (key: string, at: number) =>
  `${expirations}${String(at).padStart(13, '0')}:${key.slice(namespace.length)}`;
const expirationOf = (key: string) =>
  Number(key.slice(expirations.length, expirations.length + 13));

export function isOAuthAccessToken(token: string) {
  return token.startsWith('ec_oauth_access_') && credentials.test(token);
}

export class McpOAuthStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: Env,
  ) {}

  private get kv() {
    return this.storage.kv;
  }

  private putExpiring<T>(key: string, value: T, at: number) {
    this.kv.put(key, value);
    this.kv.put(expiresKey(key, at), key);
  }

  private allowed(owner: AccessIdentity, resource: string) {
    const config = mcpOAuthConfig(this.env);
    if (resource !== config?.resource) return false;
    // Loopback workers use a separately injected, signed Access identity.
    if (!config.secure) return true;
    const domain = this.env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
    return (
      Boolean(domain) &&
      owner.issuer === `https://${domain}` &&
      (this.env.ACCESS_ALLOWED_EMAILS ?? '')
        .split(',')
        .some((email) => email.trim().toLowerCase() === owner.email)
    );
  }

  begin(owner: AccessIdentity, request: McpAuthorizationRequest) {
    const id = crypto.randomUUID();
    const proof = secret();
    const expiresAt = Date.now() + consentDuration;
    this.storage.transactionSync(() =>
      this.putExpiring<Consent>(
        consent + id,
        { owner, request, secretHash: hash(proof), expiresAt },
        expiresAt,
      ),
    );
    return { id, proof, maxAge: consentDuration / 1000 };
  }

  decide(owner: AccessIdentity, id: string, proof: string, approve: boolean) {
    return this.storage.transactionSync(() => {
      const key = consent + id;
      const pending = this.kv.get<Consent>(key);
      const now = Date.now();
      if (
        !pending ||
        pending.expiresAt <= now ||
        identityKey(owner) !== identityKey(pending.owner) ||
        !equals(pending.secretHash, hash(proof)) ||
        !this.allowed(owner, pending.request.resource)
      )
        return null;
      this.kv.delete(key);
      this.kv.delete(expiresKey(key, pending.expiresAt));
      if (!approve) return { request: pending.request, code: null };

      const grantId = crypto.randomUUID();
      const code = credential('code', grantId);
      const codeExpiresAt = now + codeDuration;
      const { state: _state, ...request } = pending.request;
      this.putExpiring<Grant>(
        grants + grantId,
        {
          owner,
          request,
          createdAt: now,
          expiresAt: now + grantDuration,
          lastUsedAt: null,
          code: { hash: hash(code), expiresAt: codeExpiresAt },
        },
        codeExpiresAt,
      );
      return { request: pending.request, code };
    });
  }

  private live(grant: Grant | undefined, now: number): grant is Grant {
    return Boolean(
      grant && grant.expiresAt > now && this.allowed(grant.owner, grant.request.resource),
    );
  }

  private issue(id: string, grant: Grant, now: number) {
    const access = credential('access', id);
    const refresh = credential('refresh', id);
    const expiresAt = Math.min(now + accessDuration, grant.expiresAt);
    this.kv.put<Grant>(grants + id, {
      ...grant,
      access: { hash: hash(access), expiresAt },
      refreshHash: hash(refresh),
    });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      scope: mcpOAuthScope,
      expires_in: Math.ceil((expiresAt - now) / 1000),
    };
  }

  exchange(input: CodeExchange) {
    const match = credentials.exec(input.code);
    if (match?.[1] !== 'code') return null;
    const id = match[2];
    return this.storage.transactionSync(() => {
      const key = grants + id;
      const grant = this.kv.get<Grant>(key);
      const now = Date.now();
      if (
        !this.live(grant, now) ||
        grant.code.expiresAt <= now ||
        grant.request.clientId !== input.clientId ||
        grant.request.redirectUri !== input.redirectUri ||
        grant.request.resource !== input.resource ||
        !equals(grant.code.hash, hash(input.code)) ||
        !equals(
          grant.request.challenge,
          createHash('sha256').update(input.verifier).digest('base64url'),
        )
      )
        return null;
      if (grant.access) {
        this.remove(id, grant);
        return null;
      }
      this.kv.delete(expiresKey(key, grant.code.expiresAt));
      this.kv.put(expiresKey(key, grant.expiresAt), key);
      return this.issue(id, grant, now);
    });
  }

  refresh(input: RefreshExchange) {
    const match = credentials.exec(input.refreshToken);
    if (match?.[1] !== 'refresh') return null;
    const id = match[2];
    return this.storage.transactionSync(() => {
      const grant = this.kv.get<Grant>(grants + id);
      const now = Date.now();
      if (
        !this.live(grant, now) ||
        !grant.refreshHash ||
        grant.request.clientId !== input.clientId ||
        grant.request.resource !== input.resource
      )
        return null;
      const digest = hash(input.refreshToken);
      const spentKey = `${spent}${id}:${digest}`;
      if (!equals(digest, grant.refreshHash)) {
        if (this.kv.get(spentKey)) this.remove(id, grant);
        return null;
      }
      this.putExpiring(spentKey, true, grant.expiresAt);
      return this.issue(id, grant, now);
    });
  }

  authenticate(token: string) {
    const match = credentials.exec(token);
    if (match?.[1] !== 'access') return null;
    const id = match[2];
    const key = grants + id;
    const grant = this.kv.get<Grant>(key);
    const now = Date.now();
    if (
      !this.live(grant, now) ||
      !grant.access ||
      grant.access.expiresAt <= now ||
      !equals(grant.access.hash, hash(token))
    )
      return null;
    if (grant.lastUsedAt === null || now - grant.lastUsedAt >= lastUsedInterval)
      this.kv.put(key, { ...grant, lastUsedAt: now });
    return { id: oauthPrincipalPrefix + id };
  }

  active(id: string) {
    const grant = this.kv.get<Grant>(grants + id);
    return this.live(grant, Date.now()) && Boolean(grant.access);
  }

  list(owner: AccessIdentity): McpOAuthConnection[] {
    const connections: McpOAuthConnection[] = [];
    const now = Date.now();
    for (const [key, grant] of this.kv.list<Grant>({ prefix: grants })) {
      if (
        !this.live(grant, now) ||
        !grant.access ||
        identityKey(grant.owner) !== identityKey(owner)
      )
        continue;
      connections.push({
        id: key.slice(grants.length),
        name: grant.request.name,
        redirectOrigin: new URL(grant.request.redirectUri).origin,
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt,
        lastUsedAt: grant.lastUsedAt,
      });
    }
    return connections.sort((a, b) => b.createdAt - a.createdAt);
  }

  revoke(owner: AccessIdentity, id: string) {
    this.storage.transactionSync(() => {
      const grant = this.kv.get<Grant>(grants + id);
      if (grant && identityKey(grant.owner) === identityKey(owner)) this.remove(id, grant);
    });
  }

  private remove(id: string, grant: Grant) {
    const key = grants + id;
    this.kv.delete(key);
    this.kv.delete(expiresKey(key, grant.access ? grant.expiresAt : grant.code.expiresAt));
    this.storage.sql.exec(
      'DELETE FROM mcp_conversation_grants WHERE principal=?',
      oauthPrincipalPrefix + id,
    );
  }

  nextCleanup() {
    for (const [key] of this.kv.list({ prefix: expirations, limit: 1 })) return expirationOf(key);
    return Infinity;
  }

  cleanup() {
    const now = Date.now();
    this.storage.transactionSync(() => {
      const entries = [...this.kv.list<string>({ prefix: expirations, limit: 64 })];
      for (const [index, key] of entries) {
        if (expirationOf(index) > now) break;
        const grant = key.startsWith(grants) ? this.kv.get<Grant>(key) : undefined;
        if (grant) this.remove(key.slice(grants.length), grant);
        else this.kv.delete(key);
        this.kv.delete(index);
      }
    });
  }
}
