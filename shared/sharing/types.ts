export const shareIdPattern = /^[A-Za-z0-9_-]{22}$/;
export const sharePath = (id: string) => `/s/${id}`;
export const isSharePage = (path: string) => path === '/share.html' || /^\/s(?:\/|$)/.test(path);
export interface ShareBlock {
  message: number;
  role: 'user' | 'assistant';
  modelName?: string;
  channel: 'text' | 'reasoning';
  text: string;
  omittedAttachments: number;
}
export interface PublicShare {
  id: string;
  title: string;
  createdAt: number;
  expiresAt: number | null;
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
export interface SharedSnapshot {
  share: PublicShare;
  page: { blocks: ShareBlock[]; cursor: null };
}
export interface SharePreview {
  share: ManagedShare;
  page: SharePage;
}
