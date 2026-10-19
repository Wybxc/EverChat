export const supportedLocales = ['en', 'zh-CN'] as const;
export type Locale = (typeof supportedLocales)[number];
export type LocalePreference = Locale | 'system';
export const fallbackLocale: Locale = 'en';

export function localePreference(value: unknown): LocalePreference {
  return supportedLocales.includes(value as Locale) ? (value as Locale) : 'system';
}

/** A script-specific translation must never silently stand in for another script. */
export function matchLocale(language: string): Locale | undefined {
  try {
    const tag = new Intl.Locale(language);
    if (tag.language === 'en') return 'en';
    if (tag.language === 'zh' && tag.maximize().script === 'Hans') return 'zh-CN';
  } catch {
    // Invalid browser or persisted values fall through to the next preferred language.
  }
  return undefined;
}

export function resolveLocale(preference: LocalePreference, languages: readonly string[]): Locale {
  if (preference !== 'system') return preference;
  for (const language of languages) {
    const match = matchLocale(language);
    if (match) return match;
  }
  return fallbackLocale;
}

export function resolveFormatLocale(
  preference: LocalePreference,
  languages: readonly string[],
): string {
  const resolved = resolveLocale(preference, languages);
  if (preference === 'system') {
    const match = languages.find((language) => matchLocale(language) === resolved);
    if (match) return new Intl.Locale(match).toString();
  }
  return resolved;
}
