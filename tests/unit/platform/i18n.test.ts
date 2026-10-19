import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  localePreference,
  matchLocale,
  resolveLocale,
  resolveFormatLocale,
} from '../../../shared/i18n/locale';
import { createI18n } from '../../../src/platform/i18n/runtime';
import appEn from '../../../src/app/locales/en';
import appZh from '../../../src/app/locales/zh-CN';

test('locale matching respects preference order, regional English and Chinese scripts', () => {
  assert.equal(resolveLocale('system', ['fr-FR', 'en-GB', 'zh-CN']), 'en');
  assert.equal(resolveLocale('system', ['zh-SG', 'en-US']), 'zh-CN');
  assert.equal(resolveLocale('system', ['zh-Hant', 'zh-TW', 'zh-HK']), 'en');
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLocale('system', ['invalid--tag', 'zh-Hans']), 'zh-CN');
  assert.equal(resolveLocale('system', []), 'en');
  assert.equal(matchLocale('zh-Hant-CN'), undefined);
  assert.equal(resolveFormatLocale('system', ['en-GB']), 'en-GB');
  assert.equal(resolveFormatLocale('zh-CN', ['en-GB']), 'zh-CN');
  for (const value of [null, 'fr', 'zh-TW', {}, 'SYSTEM'])
    assert.equal(localePreference(value), 'system');
});

test('separate runtimes preserve language, interpolate data literally and register lazy resources', async () => {
  const first = createI18n('en', { en: { app: appEn }, 'zh-CN': { app: appZh } });
  const second = createI18n('zh-CN', { en: { app: appEn }, 'zh-CN': { app: appZh } });
  assert.equal(first.isInitialized, true);
  assert.equal(
    first.getFixedT(null, 'app')(($) => $.newChat),
    'New chat',
  );
  assert.equal(
    second.getFixedT(null, 'app')(($) => $.newChat),
    '开启新对话',
  );
  assert.equal(
    first.getFixedT(null, 'app')(($) => $.sendFailedDetail, {
      error: '<script>{{private}}</script>',
    }),
    'Send failed: <script>{{private}}</script>',
  );
  await first.changeLanguage('zh-CN');
  assert.equal(
    first.getFixedT(null, 'app')(($) => $.newChat),
    '开启新对话',
  );
  await second.changeLanguage('en');
  assert.equal(first.language, 'zh-CN');
  assert.equal(second.language, 'en');
  const lazy = createI18n('zh-CN', {});
  lazy.addResourceBundle('en', 'app', appEn);
  assert.equal(
    lazy.getFixedT(null, 'app')(($) => $.newChat),
    'New chat',
  );
});

function flatten(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof entry === 'string') return [[path, entry]];
      assert.ok(
        entry && typeof entry === 'object' && !Array.isArray(entry),
        `${path}: invalid resource`,
      );
      return Object.entries(flatten(entry as Record<string, unknown>, path));
    }),
  );
}
const plural = /_(zero|one|two|few|many|other)$/;
const placeholders = (value: string) =>
  [...value.matchAll(/{{-?\s*([^},\s]+)/g)].map((match) => match[1]).sort();

test('every shipped translation covers the same semantic keys, placeholders and locale plural categories', async () => {
  const files = globSync('src/**/locales/**/en/*.ts').concat(globSync('src/**/locales/en.ts'));
  assert.ok(files.length >= 3, 'Expected core and feature catalogs');
  for (const file of files) {
    const counterpart = file.replace('/en/', '/zh-CN/').replace('/en.ts', '/zh-CN.ts');
    const read = async (name: string) =>
      flatten((await import(pathToFileURL(resolve(name)).href)).default);
    const [en, zh] = await Promise.all([read(file), read(counterpart)]);
    const semantic = (catalog: Record<string, string>) =>
      [...new Set(Object.keys(catalog).map((key) => key.replace(plural, '')))].sort();
    assert.deepEqual(semantic(zh), semantic(en), file);
    for (const [locale, catalog] of [
      ['en', en],
      ['zh-CN', zh],
    ] as const) {
      for (const [key, value] of Object.entries(catalog)) {
        assert.ok(value.trim(), `${file}: ${key} is empty in ${locale}`);
        const base = key.replace(plural, '');
        const baseline = en[key] ?? en[`${base}_other`];
        assert.ok(baseline, `${file}: unknown key ${key}`);
        assert.deepEqual(placeholders(value), placeholders(baseline), `${file}: ${locale}.${key}`);
        if (!plural.test(key)) continue;
        const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
        // _zero is an optional explicit override even where it is not a grammatical category.
        assert.ok(
          categories.includes(key.match(plural)![1] as Intl.LDMLPluralRule) ||
            key.endsWith('_zero'),
        );
        for (const category of categories)
          assert.ok(
            catalog[`${base}_${category}`],
            `${file}: missing ${locale}.${base}_${category}`,
          );
      }
    }
  }
});

// These checks are compiled by the existing tooling config, never executed.
function translationTypes() {
  const instance = createI18n('en', {});
  const t = instance.getFixedT(null, 'app');
  t(($) => $.sendFailedDetail, { error: 'example' });
  // @ts-expect-error Unknown translation keys must not compile.
  t(($) => $.missingKey);
  // @ts-expect-error Provided interpolation options must include the message arguments.
  t(($) => $.sendFailedDetail, { unrelated: 'invalid' });
}
void translationTypes;
