import * as v from 'valibot';
import { readJsonStream } from '../http/response';
import { isLoopback } from './oauth-config';

const maxClientId = 2048;
const publicHostname = /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i;
const redirectUri = v.pipe(v.string(), v.maxLength(2048));
const clientMetadata = v.object({
  client_id: v.string(),
  client_name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  redirect_uris: v.pipe(v.array(redirectUri), v.minLength(1), v.maxLength(32)),
  token_endpoint_auth_methods_supported: v.optional(v.array(v.string())),
  token_endpoint_auth_method: v.optional(v.string()),
  application_type: v.optional(v.string()),
});

export function validRedirectUri(value: string) {
  if (!/^https?:\/\//.test(value) || /[\s\\#]/u.test(value)) return null;
  const url = URL.parse(value);
  if (
    !url ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) ||
    ['code', 'error', 'error_description', 'state', 'iss'].some((key) => url.searchParams.has(key))
  )
    return null;
  return url;
}

export function matchesRedirectUri(requested: string, registered: string, native: boolean) {
  const requestUrl = validRedirectUri(requested);
  const registeredUrl = validRedirectUri(registered);
  if (!requestUrl || !registeredUrl) return false;
  if (requested === registered) return true;
  if (
    registeredUrl.protocol !== 'http:' ||
    !isLoopback(registeredUrl.hostname) ||
    (registeredUrl.hostname === 'localhost' && !native) ||
    requestUrl.protocol !== registeredUrl.protocol ||
    requestUrl.hostname !== registeredUrl.hostname
  )
    return false;
  // Native clients allocate a loopback port when opening the browser.
  registeredUrl.port = requestUrl.port;
  return requested === registeredUrl.href;
}

export async function discoverMcpClient(clientId: string, issuer: string) {
  if (clientId.length > maxClientId || !/^https:\/\//.test(clientId) || /[\s\\#]/u.test(clientId))
    return null;
  const url = URL.parse(clientId);
  if (
    !url ||
    url.origin === issuer ||
    !publicHostname.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname === '/' ||
    /\/(?:\.|%2e){1,2}(?=\/|\?|$)/i.test(clientId)
  )
    return null;

  try {
    // The Worker uses global_fetch_strictly_public, so discovery follows the public network.
    const response = await fetch(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const parsed = v.safeParse(
      clientMetadata,
      await readJsonStream(response.body, 16 * 1024, 'Client metadata is too large.'),
    );
    if (!parsed.success || parsed.output.client_id !== clientId) return null;
    const methods = parsed.output.token_endpoint_auth_methods_supported;
    if (
      methods
        ? !methods.includes('none')
        : (parsed.output.token_endpoint_auth_method ?? 'none') !== 'none'
    )
      return null;
    return parsed.output;
  } catch {
    return null;
  }
}
