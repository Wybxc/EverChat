import { createInstance, type Resource, type ThirdPartyModule } from 'i18next';
import type {} from './i18next';
import { fallbackLocale, supportedLocales, type Locale } from '../../../shared/i18n/locale';

/** Each JavaScript runtime owns its instance; no browser or Worker globals here. */
export function createI18n(locale: Locale, resources: Resource, plugins: ThirdPartyModule[] = []) {
  const instance = createInstance();
  for (const plugin of plugins) instance.use(plugin);
  // All initial resources are local modules. Initialization completes synchronously.
  void instance.init({
    resources,
    lng: locale,
    supportedLngs: [...supportedLocales],
    fallbackLng: fallbackLocale,
    load: 'currentOnly',
    defaultNS: 'common',
    initAsync: false,
    returnNull: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
  });
  return instance;
}
