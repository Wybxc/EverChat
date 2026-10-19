import { pageI18n, registerTranslations } from '../../../platform/i18n/react';
import en from './en';
import zh from './zh-CN';

registerTranslations('chat', { en, 'zh-CN': zh });
export const t = pageI18n.getFixedT(null, 'chat');
