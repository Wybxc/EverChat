import { oauthMetadataResponse } from '@modelcontextprotocol/server';
import type { AccessIdentity } from '../../shared/auth/types';
import type { Authenticator } from '../http/auth';
import type { Env } from '../http/env';
import { HttpError } from '../http/response';
import { discoverMcpClient, matchesRedirectUri } from './oauth-client';
import {
  mcpAuthorizationMetadataPath,
  mcpAuthorizePath,
  mcpOAuthConfig,
  mcpOAuthScope,
  mcpResourceMetadataPath,
  mcpTokenPath,
} from './oauth-config';
import { mcpConsentPage } from './oauth-consent';

type OAuthConfig = NonNullable<ReturnType<typeof mcpOAuthConfig>>;
const pkceChallenge = /^[A-Za-z0-9_-]{43}$/;
const pkceVerifier = /^[A-Za-z0-9._~-]{43,128}$/;
const transactionId = /^[0-9a-f-]{36}$/;
const maxRequestBytes = 8192;

const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function oauthError(error: string, status = 400, description?: string, allow?: string) {
  return Response.json(
    { error, ...(description ? { error_description: description } : {}) },
    { status, headers: { ...headers, ...(allow ? { Allow: allow } : {}) } },
  );
}

function unavailable(error: unknown) {
  console.error(
    'EverChat MCP OAuth request failed',
    error instanceof Error ? error.name : 'UnknownError',
  );
  return oauthError('temporarily_unavailable', 503);
}

const noDuplicates = (params: URLSearchParams) =>
  new Set(params.keys()).size === [...params].length;

async function readForm(request: Request) {
  if (
    request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/x-www-form-urlencoded' ||
    !request.body
  )
    return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0;
  let body = '';
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 10_000);
  try {
    while (true) {
      const next = await reader.read();
      if (timedOut) return null;
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxRequestBytes) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(next.value, { stream: true });
    }
    const params = new URLSearchParams(body + decoder.decode());
    return noDuplicates(params) ? params : null;
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

function cookieName(id: string, config: OAuthConfig) {
  return `${config.secure ? '__Host-' : ''}everchat-mcp-${id}`;
}

function consentCookie(id: string, config: OAuthConfig, proof: string, maxAge: number) {
  return `${cookieName(id, config)}=${proof}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
}

function redirectToClient(
  config: OAuthConfig,
  uri: string,
  state: string | undefined,
  result: Record<string, string>,
  cookie?: string,
) {
  const url = new URL(uri);
  url.searchParams.set('iss', config.issuer);
  if (state !== undefined) url.searchParams.set('state', state);
  for (const [key, value] of Object.entries(result)) url.searchParams.set(key, value);
  const responseHeaders = new Headers({ ...headers, Location: url.href });
  if (cookie) responseHeaders.set('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers: responseHeaders });
}

async function authorize(
  request: Request,
  env: Env,
  config: OAuthConfig,
  authenticate: Authenticator,
  localLogin?: string,
) {
  if (request.method !== 'GET' && request.method !== 'POST')
    return oauthError('invalid_request', 405, undefined, 'GET, POST');
  if (request.url.length > maxRequestBytes) return oauthError('invalid_request', 414);
  let owner: AccessIdentity;
  try {
    const { issuer, sub, email } = await authenticate(request, env);
    owner = { issuer, sub, email };
  } catch (error) {
    if (
      localLogin &&
      request.method === 'GET' &&
      error instanceof HttpError &&
      error.status === 401
    )
      return new Response(null, {
        status: 303,
        headers: {
          ...headers,
          Location: `${localLogin}?returnTo=${encodeURIComponent(mcpAuthorizePath + new URL(request.url).search)}`,
        },
      });
    if (error instanceof HttpError) return oauthError('access_denied', error.status);
    throw error;
  }
  const library = env.LIBRARY.getByName('personal');
  if (request.method === 'POST') {
    if (request.headers.get('Origin') !== config.issuer) return oauthError('access_denied', 403);
    const form = await readForm(request);
    const id = form?.get('transaction') ?? '';
    const decision = form?.get('decision');
    if (!transactionId.test(id) || (decision !== 'allow' && decision !== 'deny'))
      return oauthError('invalid_request');
    const prefix = `${cookieName(id, config)}=`;
    const proof = request.headers
      .get('Cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length);
    if (!proof || !pkceChallenge.test(proof)) return oauthError('invalid_request');
    const result = await library.mcpOAuthDecide(owner, id, proof, decision === 'allow');
    if (!result)
      return oauthError('invalid_request', 400, 'The authorization request has expired.');
    return redirectToClient(
      config,
      result.request.redirectUri,
      result.request.state,
      result.code ? { code: result.code } : { error: 'access_denied' },
      consentCookie(id, config, '', 0),
    );
  }

  const params = new URL(request.url).searchParams;
  if (!noDuplicates(params)) return oauthError('invalid_request');
  const clientId = params.get('client_id') ?? '';
  const state = params.get('state') ?? undefined;
  const redirectUri = params.get('redirect_uri') ?? '';
  const client = await discoverMcpClient(clientId, config.issuer);
  if (!client) return oauthError('invalid_client', 400, 'Client metadata could not be verified.');
  if (
    redirectUri.length > 2048 ||
    !client.redirect_uris.some((uri) =>
      matchesRedirectUri(redirectUri, uri, client.application_type === 'native'),
    )
  )
    return oauthError(
      'invalid_request',
      400,
      'The redirect URI is not registered for this client.',
    );

  const resource = params.get('resource') ?? config.resource;
  const challenge = params.get('code_challenge') ?? '';
  const scope = params.get('scope') ?? mcpOAuthScope;
  const error =
    params.get('response_type') !== 'code'
      ? 'unsupported_response_type'
      : resource !== config.resource
        ? 'invalid_target'
        : scope !== mcpOAuthScope
          ? 'invalid_scope'
          : params.get('code_challenge_method') !== 'S256' || !pkceChallenge.test(challenge)
            ? 'invalid_request'
            : undefined;
  if (error) return redirectToClient(config, redirectUri, state, { error });

  const authorization = {
    clientId,
    name: client.client_name,
    redirectUri,
    resource,
    state,
    challenge,
  };
  const pending = await library.mcpOAuthBegin(owner, authorization);
  return mcpConsentPage(
    authorization,
    pending.id,
    mcpAuthorizePath,
    consentCookie(pending.id, config, pending.proof, pending.maxAge),
    request.headers.get('Accept-Language'),
  );
}

async function token(request: Request, env: Env, config: OAuthConfig) {
  if (request.method !== 'POST') return oauthError('invalid_request', 405, undefined, 'POST');
  const form = await readForm(request);
  if (!form) return oauthError('invalid_request');
  if (
    request.headers.has('Authorization') ||
    form.has('client_secret') ||
    form.has('client_assertion')
  )
    return oauthError('invalid_client');
  const clientId = form.get('client_id');
  if (!clientId) return oauthError('invalid_request', 400, 'client_id is required.');
  const resource = form.get('resource') ?? config.resource;
  if (resource !== config.resource) return oauthError('invalid_target');
  if (form.has('scope') && form.get('scope') !== mcpOAuthScope) return oauthError('invalid_scope');
  const library = env.LIBRARY.getByName('personal');
  let tokens;
  switch (form.get('grant_type')) {
    case 'authorization_code': {
      const code = form.get('code');
      const verifier = form.get('code_verifier');
      const redirectUri = form.get('redirect_uri');
      if (!code || !verifier || !redirectUri) return oauthError('invalid_request');
      if (!pkceVerifier.test(verifier)) return oauthError('invalid_grant');
      tokens = await library.mcpOAuthExchange({ code, clientId, redirectUri, verifier, resource });
      break;
    }
    case 'refresh_token': {
      const refreshToken = form.get('refresh_token');
      if (!refreshToken) return oauthError('invalid_request');
      tokens = await library.mcpOAuthRefresh({ refreshToken, clientId, resource });
      break;
    }
    default:
      return oauthError(form.has('grant_type') ? 'unsupported_grant_type' : 'invalid_request');
  }
  return tokens
    ? Response.json(tokens, { headers: { ...headers, Pragma: 'no-cache' } })
    : oauthError('invalid_grant');
}

export function serveMcpOAuth(
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticator,
  localLogin?: string,
) {
  if (
    url.pathname !== mcpAuthorizePath &&
    url.pathname !== mcpTokenPath &&
    url.pathname !== mcpAuthorizationMetadataPath &&
    url.pathname !== mcpResourceMetadataPath
  )
    return undefined;
  const config = mcpOAuthConfig(env);
  if (!config || config.issuer !== url.origin) return oauthError('not_found', 404);
  if (url.pathname === mcpAuthorizePath)
    return authorize(request, env, config, authenticate, localLogin).catch(unavailable);
  if (url.pathname === mcpTokenPath) return token(request, env, config).catch(unavailable);
  const oauthMetadata = {
    issuer: config.issuer,
    authorization_endpoint: config.issuer + mcpAuthorizePath,
    token_endpoint: config.issuer + mcpTokenPath,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [mcpOAuthScope],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
  const metadata = oauthMetadataResponse(request, {
    oauthMetadata,
    resourceServerUrl: new URL(config.resource),
    scopesSupported: [mcpOAuthScope],
    dangerouslyAllowInsecureIssuerUrl: !config.secure,
  });
  metadata?.headers.set('Cache-Control', 'no-store');
  return metadata;
}
