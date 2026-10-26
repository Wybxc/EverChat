import { createI18n } from '../../src/platform/i18n/runtime';
import en from '../../src/features/sharing/locales/en';
import zh from '../../src/features/sharing/locales/zh-CN';
import commonEn from '../../src/platform/i18n/locales/en/common';
import commonZh from '../../src/platform/i18n/locales/zh-CN/common';
import type { Locale } from '../i18n/locale';

// Immutable language-specific instances: no request mutates a global language.
const instances = {
  en: createI18n('en', { en: { sharing: en, common: commonEn } }),
  'zh-CN': createI18n('zh-CN', { 'zh-CN': { sharing: zh, common: commonZh } }),
};
export function shareLabels(locale: Locale, count = 0) {
  const t = instances[locale].getFixedT(locale, 'sharing');
  const common = instances[locale].getFixedT(locale, 'common');
  return {
    unavailable: t(($) => $.unavailable),
    connectionFailed: t(($) => $.connectionFailed),
    readFailed: t(($) => $.readFailed),
    theme: t(($) => $.theme),
    system: t(($) => $.system),
    light: t(($) => $.light),
    dark: t(($) => $.dark),
    count: t(($) => $.snapshotCount, { count }),
    noAttachments: t(($) => $.noAttachments),
    reload: t(($) => $.reload),
    question: t(($) => $.question),
    reasoning: t(($) => $.reasoning),
    omitted: t(($) => $.omitted, { count }),
    language: common(($) => $.language),
    expand: common(($) => $.expandMessage),
    collapse: common(($) => $.collapseMessage),
    loadImage: common(($) => $.loadImage),
    imageOmitted: common(($) => $.imageOmitted),
    copy: common(($) => $.copy),
    copied: t(($) => $.copied),
    copyFailed: common(($) => $.copyFailed),
  };
}
export type ShareLabel = keyof ReturnType<typeof shareLabels>;
