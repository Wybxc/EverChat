import {
  matchLocale,
  localePreference,
  resolveLocale,
  supportedLocales,
  fallbackLocale,
} from '../../../shared/i18n/locale';
import en from './locales/en/system';
import zh from './locales/zh-CN/system';

export const startupMessages = { en, 'zh-CN': zh };
export function startupFailureText() {
  let stored: unknown;
  try {
    stored = localStorage.getItem('everchat:locale');
  } catch {
    /* Memory-only environment. */
  }
  return startupMessages[resolveLocale(localePreference(stored), navigator.languages)].loadFailed;
}

/** Build-time inline bootstrap: shared matching functions and messages, no network request. */
export function startupLocaleScript() {
  const messages = Object.fromEntries(
    Object.entries(startupMessages).map(([locale, text]) => [
      locale,
      { starting: text.starting, startingLabel: text.startingLabel },
    ]),
  );
  return `(()=>{const supportedLocales=${JSON.stringify(supportedLocales)};const fallbackLocale=${JSON.stringify(fallbackLocale)};const localePreference=${localePreference.toString()};const matchLocale=${matchLocale.toString()};const resolveLocale=${resolveLocale.toString()};const messages=${JSON.stringify(messages)};let preference;try{preference=localStorage.getItem('everchat:locale')}catch{}const locale=resolveLocale(localePreference(preference),navigator.languages);document.documentElement.lang=locale;const root=document.querySelector('.startup');if(root){root.setAttribute('aria-label',messages[locale].startingLabel);root.querySelector('.startup-content').textContent=messages[locale].starting}})();`;
}
