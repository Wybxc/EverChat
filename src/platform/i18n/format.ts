import { getLocaleSnapshot } from './preference';

// UI formatting only. Dates in storage, accounting buckets and quotas keep their own rules.
const numbers = new Map<string, Intl.NumberFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();
function formatter<T>(cache: Map<string, T>, options: object, create: (locale: string) => T) {
  const locale = getLocaleSnapshot().formatLocale;
  const key = JSON.stringify([locale, options]);
  let result = cache.get(key);
  if (!result) {
    if (cache.size >= 64) cache.clear();
    result = create(locale);
    cache.set(key, result);
  }
  return result;
}
export function formatNumber(value: number | bigint, options: Intl.NumberFormatOptions = {}) {
  return formatter(numbers, options, (locale) => new Intl.NumberFormat(locale, options)).format(
    value,
  );
}
export function formatDateTime(value: Date | number, options: Intl.DateTimeFormatOptions = {}) {
  return formatter(dates, options, (locale) => new Intl.DateTimeFormat(locale, options)).format(
    value,
  );
}
