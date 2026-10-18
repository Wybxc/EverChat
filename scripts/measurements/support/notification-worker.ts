// Temporary platform measurement only. No production data, DOs, R2 or real push gateways.
import * as v from 'valibot';
import { notificationDeviceSchema, completionSchema } from '../../../shared/notifications/protocol';
import { sendWebPush } from '../../../worker/notifications/push';
import type { Env } from '../../../worker/http/env';

type ValidationEnv = Env & { VALIDATION_SECRET?: string };
type Capture = { authorization: string; encoding: string; ttl: string; body: string };
const captures = new Map<string, Capture>();
const endpoint = (value: string) => {
  const url = new URL(value);
  return (
    ['web.push.apple.com', 'fcm.googleapis.com'].includes(url.hostname) &&
    /^\/everchat-notifications-validation\/[\da-f-]{36}$/.test(url.pathname) &&
    url.protocol === 'https:' &&
    !url.search &&
    !url.port
  );
};
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (!endpoint(request.url) || request.method !== 'POST')
    throw new Error('External requests disabled');
  const body = new Uint8Array(await request.arrayBuffer());
  captures.set(request.url, {
    authorization: request.headers.get('Authorization') ?? '',
    encoding: request.headers.get('Content-Encoding') ?? '',
    ttl: request.headers.get('TTL') ?? '',
    body: btoa(String.fromCharCode(...body)),
  });
  return new Response(null, { status: 201 });
};
const schema = v.strictObject({ device: notificationDeviceSchema, completion: completionSchema });
export default {
  async fetch(request, env) {
    if (!env.VALIDATION_SECRET) return new Response('Unconfigured', { status: 503 });
    if (request.headers.get('Authorization') !== `Bearer ${env.VALIDATION_SECRET}`)
      return new Response('Unauthorized', { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === '/api/__validation/notifications/identity')
      return Response.json({ kind: 'everchat-notifications-validation', mockGateway: true });
    if (path === '/api/__validation/notifications/noop') return Response.json({ ok: true });
    if (path !== '/api/__validation/notifications/encrypt' || request.method !== 'POST')
      return new Response('Not found', { status: 404 });
    if (Number(request.headers.get('Content-Length') ?? 0) > 8192)
      return new Response('Too large', { status: 413 });
    const parsed = v.safeParse(schema, await request.json());
    if (
      !parsed.success ||
      !parsed.output.device.subscription ||
      !endpoint(parsed.output.device.subscription.endpoint)
    )
      return new Response('Invalid fixture', { status: 400 });
    const { device, completion } = parsed.output;
    const started = performance.now();
    let result;
    try {
      result = await sendWebPush(env, device, completion);
    } catch (error) {
      // Test fixtures only. Never return key-like strings, subscriptions or headers.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
      return Response.json(
        { error: detail.replace(/[\w-]{22,}/g, '[redacted]').slice(0, 300) },
        { status: 500 },
      );
    }
    const capture = captures.get(device.subscription!.endpoint);
    captures.delete(device.subscription!.endpoint);
    return Response.json({
      status: result.status,
      elapsedMs: performance.now() - started,
      capture,
    });
  },
} satisfies ExportedHandler<ValidationEnv>;
