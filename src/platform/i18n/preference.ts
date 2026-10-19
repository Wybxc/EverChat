import {
  localePreference,
  resolveFormatLocale,
  resolveLocale,
  type LocalePreference,
} from '../../../shared/i18n/locale';

export const LOCALE_KEY = 'everchat:locale';
const listeners = new Set<() => void>();
function readPreference(): LocalePreference {
  try {
    return localePreference(localStorage.getItem(LOCALE_KEY));
  } catch {
    return 'system';
  }
}
let preference = readPreference();
const languages = () => (typeof navigator === 'undefined' ? [] : navigator.languages);
const snapshot = () => ({
  preference,
  locale: resolveLocale(preference, languages()),
  formatLocale: resolveFormatLocale(preference, languages()),
});
let current = snapshot();
function update() {
  const next = snapshot();
  if (
    next.preference === current.preference &&
    next.locale === current.locale &&
    next.formatLocale === current.formatLocale
  )
    return;
  current = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next.locale;
  for (const listener of listeners) listener();
}
export function chooseLocale(value: LocalePreference) {
  preference = localePreference(value);
  try {
    localStorage.setItem(LOCALE_KEY, preference);
  } catch {
    // The current session remains usable with unavailable or full storage.
  }
  update();
}
export const getLocaleSnapshot = () => current;
export const subscribeLocale = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
if (typeof window !== 'undefined') {
  document.documentElement.lang = current.locale;
  window.addEventListener('storage', (event) => {
    if (event.key !== LOCALE_KEY && event.key !== null) return;
    preference = localePreference(event.key === null ? null : event.newValue);
    update();
  });
  window.addEventListener('languagechange', update);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') update();
  });
}
