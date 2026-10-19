import { type ConversationInfo } from '../../../shared/conversation/types';
import { t } from './locales';
import { formatDateTime } from '../../platform/i18n/format';

export function conversationGroup(item: ConversationInfo) {
  if (item.pinned) return 'pinned';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(item.updatedAt);
  if (date >= today) return 'today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date >= yesterday) return 'yesterday';
  const week = new Date(today);
  week.setDate(week.getDate() - 7);
  if (date >= week) return 'last7days';
  return `month:${date.getFullYear()}-${date.getMonth()}`;
}

export function conversationGroupLabel(group: string) {
  if (group === 'pinned') return t(($) => $.pinnedGroup);
  if (group === 'today') return t(($) => $.today);
  if (group === 'yesterday') return t(($) => $.yesterday);
  if (group === 'last7days') return t(($) => $.last7days);
  const [year, month] = group.slice('month:'.length).split('-').map(Number);
  return formatDateTime(new Date(year, month, 1), { year: 'numeric', month: 'long' });
}
