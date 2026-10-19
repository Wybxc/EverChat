import * as v from 'valibot';

export const shareIdPattern = /^[A-Za-z0-9_-]{22}$/;
export const shareSecretPattern = /^[A-Za-z0-9_-]{43}$/;
export const sharePath = (id: string) => `/s/${id}`;
export const isSharePage = (path: string) => /^\/s(?:\/|$)/.test(path);
export const shareExpirySchema = v.nullable(v.picklist([1, 7, 30]));
export type ShareExpiry = v.InferOutput<typeof shareExpirySchema>;
export interface ShareBlock {
  message: number;
  role: 'user' | 'assistant';
  channel: 'text' | 'reasoning';
  text: string;
  omittedAttachments: number;
}
export interface PublicShare {
  id: string;
  title: string;
  createdAt: number;
  expiresAt: number | null;
  includeReasoning: boolean;
  messageCount: number;
  omittedAttachments: number;
  hash: string;
}
export interface ManagedShare extends PublicShare {
  conversationId: string;
  headId: string;
  status: 'draft' | 'active' | 'revoked' | 'expired';
  updatedAt: number;
}
export interface SharePage {
  blocks: ShareBlock[];
  cursor: number | null;
}
export interface SharePreview {
  share: ManagedShare;
  page: SharePage;
}
