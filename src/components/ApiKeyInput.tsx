import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

export function ApiKeyInput({
  visible,
  onToggle,
  loading = false,
  showLabel,
  hideLabel,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & {
  visible: boolean;
  onToggle: () => void;
  loading?: boolean;
  showLabel?: string;
  hideLabel?: string;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="field-control flex min-w-0 w-full items-center gap-2 border-input pr-1">
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        maxLength={4096}
        className="min-w-0 flex-1"
      />
      <Button
        variant="ghost"
        size="icon"
        type="button"
        disabled={props.disabled || loading}
        aria-label={
          visible ? (hideLabel ?? t(($) => $.hideApiKey)) : (showLabel ?? t(($) => $.showApiKey))
        }
        aria-pressed={visible}
        aria-busy={loading || undefined}
        onClick={onToggle}
      >
        {loading ? (
          <Spinner />
        ) : visible ? (
          <EyeOff className="h-[1.0625rem] w-[1.0625rem]" />
        ) : (
          <Eye className="h-[1.0625rem] w-[1.0625rem]" />
        )}
      </Button>
    </div>
  );
}
