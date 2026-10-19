import { useTranslation } from 'react-i18next';
import './locales';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useThemeMode } from '../platform/theme';

export function ThemeControl() {
  const { t } = useTranslation('app', { useSuspense: false });

  const [theme, choose] = useThemeMode();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t(($) => $.colorMode)}</legend>
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            { value: 'light', label: t(($) => $.light), icon: Sun },
            { value: 'dark', label: t(($) => $.dark), icon: Moon },
            { value: 'system', label: t(($) => $.system), icon: Monitor },
          ] as const
        ).map(({ value, label, icon: Icon }) => (
          <label key={value} className="relative cursor-pointer">
            <input
              type="radio"
              name="theme"
              value={value}
              className="peer sr-only"
              checked={theme === value}
              onChange={() => choose(value)}
            />
            <span className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-muted px-3 text-sm peer-checked:bg-accent peer-checked:text-accent-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
              <Icon className="size-4" />
              {label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
