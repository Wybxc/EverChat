import { localePreference, resolveLocale } from '../../../shared/i18n/locale';
import { createI18n } from '../i18n/runtime';
import en from '../i18n/locales/en/system';
import zh from '../i18n/locales/zh-CN/system';

// The Service Worker owns this small runtime. No React, page storage or feature dictionaries.
const runtime = createI18n('en', { en: { system: en }, 'zh-CN': { system: zh } });
export function notificationText(
  preference: unknown,
  languages: readonly string[],
  completion: boolean,
) {
  const t = runtime.getFixedT(resolveLocale(localePreference(preference), languages), 'system');
  return completion ? t(($) => $.answerCompleted) : t(($) => $.notificationsEnabled);
}
