import { pageI18n, registerTranslations } from '../../../platform/i18n/react';
import en from './en';
import zh from './zh-CN';

registerTranslations('notifications', { en, 'zh-CN': zh });
export const t = pageI18n.getFixedT(null, 'notifications');

export const notificationMessage = (key: keyof typeof en | '') => (key ? t(($) => $[key]) : '');
