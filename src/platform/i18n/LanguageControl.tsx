import { useTranslation } from 'react-i18next';
import { NativeSelect } from '@/components/ui/native-select';
import { chooseLocale } from './preference';
import { useLocale } from './react';
import { localePreference } from '../../../shared/i18n/locale';

export function LanguageControl() {
  const { t } = useTranslation('common');
  const { preference } = useLocale();
  return (
    <label className="block space-y-2 text-sm font-medium">
      <span>{t(($) => $.language)}</span>
      <NativeSelect
        aria-label={t(($) => $.language)}
        value={preference}
        onChange={(event) => chooseLocale(localePreference(event.target.value))}
      >
        <option value="system">{t(($) => $.system)}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </NativeSelect>
    </label>
  );
}
