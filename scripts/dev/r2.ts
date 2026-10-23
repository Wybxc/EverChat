// Local-only S3 adapter. Production never imports these credentials or routes.
import { AwsClient } from 'aws4fetch';
import { createUploadSigner } from '../../worker/attachments/signing';
import type { Env } from '../../worker/http/env';
import { Library as ProductionLibrary } from '../../worker/library/durable-object';

const accessKeyId = 'everchat-local-r2';
const secretAccessKey = 'development-only-not-a-cloudflare-credential';
const bucket = 'local-attachments';
const prefix = `/__dev/r2/${bucket}/`;

export class Library extends ProductionLibrary {
  protected override attachmentUploadSigner() {
    return createUploadSigner({
      endpoint: `${this.env.APP_ORIGIN}/__dev/r2`,
      bucket,
      accessKeyId,
      secretAccessKey,
    });
  }
}

export async function localR2Upload(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/__dev/r2/')) return null;
  if (!url.pathname.startsWith(prefix) || request.method !== 'PUT' || !request.body)
    return new Response(null, { status: 403 });
  const datetime = url.searchParams.get('X-Amz-Date') ?? '';
  const expires = Number(url.searchParams.get('X-Amz-Expires'));
  const iso = datetime.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    '$1-$2-$3T$4:$5:$6Z',
  );
  const start = Date.parse(iso);
  if (
    !Number.isFinite(start) ||
    !(expires > 0 && expires <= 300) ||
    Date.now() < start - 1000 ||
    Date.now() >= start + expires * 1000
  )
    return new Response(null, { status: 403 });
  if (
    url.searchParams.get('X-Amz-SignedHeaders') !== 'content-type;host;if-none-match' ||
    request.headers.get('If-None-Match') !== '*'
  )
    return new Response(null, { status: 403 });
  const signature = url.searchParams.get('X-Amz-Signature');
  url.searchParams.delete('X-Amz-Signature');
  const client = new AwsClient({ accessKeyId, secretAccessKey, region: 'auto', service: 's3' });
  const signed = await client.sign(url, {
    method: 'PUT',
    headers: { 'Content-Type': request.headers.get('Content-Type') ?? '', 'If-None-Match': '*' },
    aws: { signQuery: true, allHeaders: true, datetime },
  });
  if (!signature || new URL(signed.url).searchParams.get('X-Amz-Signature') !== signature)
    return new Response(null, { status: 403 });
  if (!env.ATTACHMENTS) return new Response(null, { status: 503 });
  const object = await env.ATTACHMENTS.put(
    decodeURIComponent(url.pathname.slice(prefix.length)),
    request.body,
    {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: request.headers.get('Content-Type')! },
    },
  );
  return new Response(null, {
    status: object ? 200 : 412,
    headers: object ? { ETag: object.httpEtag } : {},
  });
}
