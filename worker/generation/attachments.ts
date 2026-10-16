import type { DocumentPart } from '../../shared/attachments/documents';
import type { ImagePart } from '../../shared/attachments/images';
import type { Library } from '../library/durable-object';
import { ProviderError } from './errors';

type AttachmentSource = Pick<DurableObjectStub<Library>, 'attachmentResponse' | 'documentText'>;

export async function loadGenerationImage(library: AttachmentSource, conversationId: string, image: ImagePart) {
        const response = await library.attachmentResponse(conversationId, image.attachmentId, false);
        if (!response.ok) throw new ProviderError('图片不可用，回答未调用模型。');
        const data = new Uint8Array(await response.arrayBuffer());
        const digest = await crypto.subtle.digest('SHA-256', data);
        const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (sha256 !== image.sha256 || response.headers.get('Content-Type') !== image.mediaType) throw new ProviderError('图片完整性校验失败，回答未调用模型。');
        return data;

}

export async function loadGenerationDocument(library: AttachmentSource, conversationId: string, file: DocumentPart) {
        const result = await library.documentText(conversationId, file.attachmentId);
        if ('error' in result) throw new ProviderError(result.error);
        return result.value.text;

}
