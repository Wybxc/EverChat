import * as v from 'valibot';
import { fileMediaType, MAX_ATTACHMENT_BYTES } from '../../../shared/attachments/files';
import { imageDimensions, imageMediaTypeSchema } from '../../../shared/attachments/images';
import { UiError, uiMessage } from '../../platform/i18n/messages';

export async function prepareChatImage(file: File, signal: AbortSignal): Promise<File> {
  const type = v.safeParse(imageMediaTypeSchema, file.type || fileMediaType(file.name));
  if (!type.success || !file.size || file.size > MAX_ATTACHMENT_BYTES)
    throw new UiError(uiMessage('attachments', 'invalidImage'));
  // Inspect headers without decoding a full bitmap or recompressing the original.
  imageDimensions(new Uint8Array(await file.arrayBuffer()), type.output);
  signal.throwIfAborted();
  return file.type === type.output ? file : new File([file], file.name, { type: type.output });
}
