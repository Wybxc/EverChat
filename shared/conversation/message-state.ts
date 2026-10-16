import type { Message } from './types';
export const isActive = (message: Pick<Message, 'status'>) => message.status === 'queued' || message.status === 'running';
