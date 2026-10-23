import { AwsClient } from 'aws4fetch';
import type { AttachmentUpload } from '../../shared/attachments/files';
import { problem } from '../../shared/errors/descriptor';
import type { Env } from '../http/env';
import { HttpError } from '../http/response';

export type UploadSigner = (
  key: string,
  mediaType: string,
  expiresAt: number,
) => Promise<NonNullable<AttachmentUpload['upload']>>;

export function createUploadSigner({
  endpoint,
  bucket,
  accessKeyId,
  secretAccessKey,
}: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): UploadSigner {
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  return async (key, mediaType, expiresAt) => {
    const seconds = Math.floor((expiresAt - Date.now()) / 1000);
    if (seconds < 1)
      throw new HttpError(
        410,
        '上传地址已过期，请重新选择文件。',
        undefined,
        problem('ATTACHMENT_INVALID'),
      );
    const url = new URL(
      `${endpoint}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`,
    );
    url.searchParams.set('X-Amz-Expires', String(seconds));
    const headers = { 'Content-Type': mediaType, 'If-None-Match': '*' };
    const signed = await client.sign(url, {
      method: 'PUT',
      headers,
      aws: { signQuery: true, allHeaders: true },
    });
    return { method: 'PUT', url: signed.url, headers, expiresAt };
  };
}

export function r2UploadSigner(env: Env): UploadSigner {
  const {
    R2_ACCOUNT_ID: account,
    R2_BUCKET_NAME: bucket,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
  } = env;
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !bucket || !accessKeyId || !secretAccessKey)
    throw new HttpError(
      503,
      'R2 直传签名未配置，请先配置专用 S3 凭据。',
      undefined,
      problem('ATTACHMENT_STORAGE_REQUIRED'),
    );
  return createUploadSigner({
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    bucket,
    accessKeyId,
    secretAccessKey,
  });
}
