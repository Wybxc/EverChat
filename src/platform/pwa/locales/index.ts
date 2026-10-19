import { pageI18n, registerTranslations } from '../../../platform/i18n/react';
import en from './en';
import zh from './zh-CN';

registerTranslations('pwa', { en, 'zh-CN': zh });
export const t = pageI18n.getFixedT(null, 'pwa');

export const pwaMessage = (key: import('../protocol').ReloadReason | '') =>
  key ? t(($) => $[key]) : '';
