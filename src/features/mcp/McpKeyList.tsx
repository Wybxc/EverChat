import { Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { McpKeyInfo } from '../../../shared/mcp/types';
import { formatDateTime } from '../../platform/i18n/format';

export function McpKeyList({
  keys,
  disabled,
  onRename,
  onDelete,
}: {
  keys: McpKeyInfo[];
  disabled: boolean;
  onRename: (key: McpKeyInfo) => void;
  onDelete: (key: McpKeyInfo) => void;
}) {
  const { t } = useTranslation('mcp');
  const date = (at: number | null) =>
    at === null ? t(($) => $.neverUsed) : formatDateTime(at, { dateStyle: 'medium' });
  const actions = (key: McpKeyInfo) => (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label={t(($) => $.renameKey, { name: key.name })}
        title={t(($) => $.rename)}
        onClick={() => onRename(key)}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label={t(($) => $.deleteKey, { name: key.name })}
        title={t(($) => $.delete)}
        onClick={() => onDelete(key)}
      >
        <Trash2 />
      </Button>
    </div>
  );
  if (!keys.length)
    return <p className="py-6 text-center text-sm text-muted-foreground">{t(($) => $.empty)}</p>;
  return (
    <section aria-label={t(($) => $.keys)}>
      <div className="hidden sm:block">
        <table className="w-full text-left text-sm" aria-label={t(($) => $.keys)}>
          <thead className="border-b border-border text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-3 font-normal">
                {t(($) => $.nameColumn)}
              </th>
              <th scope="col" className="py-2 pr-3 font-normal">
                {t(($) => $.keyColumn)}
              </th>
              <th scope="col" className="py-2 pr-3 font-normal">
                {t(($) => $.createdAt)}
              </th>
              <th scope="col" className="py-2 pr-2 font-normal">
                {t(($) => $.lastUsedAt)}
              </th>
              <th scope="col" className="py-2">
                <span className="sr-only">{t(($) => $.actions)}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className="border-b border-border/50 last:border-0">
                <th scope="row" className="max-w-48 break-words py-2 pr-3 font-normal">
                  {key.name}
                </th>
                <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs">{key.keyHint}</td>
                <td className="whitespace-nowrap py-2 pr-3 text-xs">{date(key.createdAt)}</td>
                <td className="whitespace-nowrap py-2 pr-2 text-xs">{date(key.lastUsedAt)}</td>
                <td className="w-0 py-2">{actions(key)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col divide-y divide-border sm:hidden">
        {keys.map((key) => (
          <li key={key.id} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 break-words text-sm font-medium">{key.name}</span>
              {actions(key)}
            </div>
            <span className="font-mono text-xs">{key.keyHint}</span>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <div className="flex flex-col gap-0.5">
                <dt>{t(($) => $.createdAt)}</dt>
                <dd>{date(key.createdAt)}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt>{t(($) => $.lastUsedAt)}</dt>
                <dd>{date(key.lastUsedAt)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
