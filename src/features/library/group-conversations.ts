import { type ConversationInfo } from '../../../shared/conversation/types';

export function conversationGroup(item: ConversationInfo) {
  if (item.pinned) return '置顶';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(item.updatedAt);
  if (date >= today) return '今天';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date >= yesterday) return '昨天';
  const week = new Date(today);
  week.setDate(week.getDate() - 7);
  if (date >= week) return '过去 7 天';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(date);
}
