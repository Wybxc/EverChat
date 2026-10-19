import { useSyncExternalStore } from 'react';
import { initReactI18next } from 'react-i18next';
import type { Locale } from '../../../shared/i18n/locale';
import commonEn from './locales/en/common';
import errorsEn from './locales/en/errors';
import systemEn from './locales/en/system';
import commonZh from './locales/zh-CN/common';
import errorsZh from './locales/zh-CN/errors';
import systemZh from './locales/zh-CN/system';
import { getLocaleSnapshot, subscribeLocale } from './preference';
import { createI18n } from './runtime';

export const pageI18n = createI18n(
  getLocaleSnapshot().locale,
  {
    en: { common: commonEn, system: systemEn, errors: errorsEn },
    'zh-CN': { common: commonZh, system: systemZh, errors: errorsZh },
  },
  [initReactI18next],
);
subscribeLocale(() => {
  void pageI18n.changeLanguage(getLocaleSnapshot().locale);
});

/** Called by a feature's resource module before rendering that feature. */
export function registerTranslations(
  namespace: string,
  resources: Record<Locale, Record<string, unknown>>,
) {
  for (const [locale, resource] of Object.entries(resources)) {
    if (!pageI18n.hasResourceBundle(locale, namespace))
      pageI18n.addResourceBundle(locale, namespace, resource);
  }
}
export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
}
