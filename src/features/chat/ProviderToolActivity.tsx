import { useTranslation } from 'react-i18next';
import { mergeServerToolActivity } from '../../../shared/tools/server-tools';
import type { Message } from '../../../shared/conversation/types';
import './locales';

const vendorNames = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
};

export function ProviderToolActivity({ message }: { message: Message }) {
  const { t } = useTranslation('chat', { useSuspense: false });
  const activities = mergeServerToolActivity(
    mergeServerToolActivity(
      message.continuation?.stages.flatMap((stage) => stage.generation?.serverTools ?? []),
      message.generation?.serverTools,
    ),
    message.streamState?.serverTools,
  );
  if (!activities?.length) return null;
  return (
    <details className="max-w-full rounded-md border px-3 py-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        {t(($) => $.providerTools)} · {activities.length}
      </summary>
      <ul className="mt-2 space-y-2">
        {activities.map((activity) => (
          <li key={activity.id}>
            <span className="font-medium">{t(($) => $.providerToolNames[activity.tool])}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {vendorNames[activity.vendor]} · {t(($) => $.providerToolStatuses[activity.status])}
              {activity.count ? ` · ${activity.count}` : ''}
            </span>
            {!!activity.sources.length && (
              <ul className="mt-1 space-y-1 text-xs break-all text-muted-foreground">
                {activity.sources.map(({ title, url }) => (
                  <li key={url ?? title}>
                    {url ? (
                      <a
                        href={url}
                        className="underline underline-offset-2"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {title}
                      </a>
                    ) : (
                      title
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
