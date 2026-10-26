import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';
import type { ComponentProps } from 'react';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import { createMathPlugin } from '@streamdown/math';
import remarkBreaks from 'remark-breaks';
import { Brain, Infinity as InfinityIcon } from 'lucide-react';
import { Message, MessageContent, MessageHeader } from '../../src/components/ui/message';
import { Bubble, BubbleContent } from '../../src/components/ui/bubble';
import { NativeSelect } from '../../src/components/ui/native-select';
import { TraceDetails } from '../../src/components/ui/trace';
import { normalizeMathMarkdown } from '../../src/features/chat/rendering/math';
import { shareLabels, type ShareLabel } from '../../shared/sharing/labels';
import type { PublicShare, ShareBlock } from '../../shared/sharing/types';
import type { Locale } from '../../shared/i18n/locale';

export function Label({ name, count = 0 }: { name: ShareLabel; count?: number }) {
  return (
    <>
      {(['en', 'zh-CN'] as const).map((locale) => (
        <span key={locale} data-share-label="" lang={locale}>
          {shareLabels(locale, count)[name]}
        </span>
      ))}
    </>
  );
}
const math = createMathPlugin({ singleDollarTextMath: false });
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];
const components: ComponentProps<typeof Streamdown>['components'] = {
  a: ({ href, children }) =>
    typeof href === 'string' && /^(?:https?:\/\/|mailto:)/i.test(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        referrerPolicy="no-referrer"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Remote images stay opt-in. Never emit an img/preload that contacts a third party.
  img: ({ src, alt }) => {
    let safe = false;
    try {
      safe = new URL(typeof src === 'string' ? src : '').protocol === 'https:';
    } catch {
      /* Omitted. */
    }
    return safe ? (
      <button
        type="button"
        className="share-image"
        data-share-image={src}
        data-image-alt={alt ?? ''}
      >
        <Label name="loadImage" />
        {alt ? `: ${alt}` : ''}
      </button>
    ) : (
      <span className="text-muted-foreground">
        <Label name="imageOmitted" />
      </span>
    );
  },
  table: ({ node: _node, ...props }) => <table {...props} />,
};
function Markdown({ text }: { text: string }) {
  return (
    <Streamdown
      className="markdown flex flex-col gap-3"
      mode="static"
      controls={false}
      remarkPlugins={remarkPlugins}
      plugins={{ math }}
      components={components}
    >
      {normalizeMathMarkdown(text)}
    </Streamdown>
  );
}
export interface ShareMessage {
  index: number;
  role: 'user' | 'assistant';
  modelName?: string;
  text: string;
  reasoning: string;
  omitted: number;
}
// Reassemble complete Markdown messages; transport blocks can split a fence or formula.
export function* shareMessages(payloads: Iterable<string>): Generator<ShareMessage> {
  let current: ShareMessage | undefined;
  for (const payload of payloads) {
    const block = JSON.parse(payload) as ShareBlock;
    if (current?.index !== block.message) {
      if (current) yield current;
      current = {
        index: block.message,
        role: block.role,
        modelName: block.modelName,
        text: '',
        reasoning: '',
        omitted: 0,
      };
    }
    current[block.channel] += block.text;
    current.omitted += block.omittedAttachments;
  }
  if (current) yield current;
}
function SharedMessage({ message }: { message: ShareMessage }) {
  const user = message.role === 'user';
  return (
    <article
      data-testid={`${message.role}-message`}
      className={user ? 'ml-auto w-fit min-w-0 max-w-[90%] sm:max-w-[82%]' : 'min-w-0'}
    >
      <Message align={user ? 'end' : 'start'}>
        <MessageContent>
          {user ? (
            <>
              <h2 className="sr-only">
                <Label name="question" />
              </h2>
              <Bubble variant="user" align="end" className="max-w-full">
                <BubbleContent>
                  <div data-share-user-text="">{message.text}</div>
                  <button hidden type="button" className="share-expand" aria-expanded="false">
                    <Label name="expand" />
                  </button>
                </BubbleContent>
              </Bubble>
            </>
          ) : (
            <>
              <MessageHeader className="px-0">
                <h2 className="flex items-center gap-2 font-semibold text-foreground">
                  <InfinityIcon className="size-4 shrink-0" aria-hidden="true" strokeWidth={1.7} />
                  <span className="min-w-0 break-words">{message.modelName || 'EverChat'}</span>
                </h2>
              </MessageHeader>
              {message.reasoning && (
                <TraceDetails
                  title={<Label name="reasoning" />}
                  icon={<Brain />}
                  data-testid="share-reasoning"
                >
                  <Markdown text={message.reasoning} />
                </TraceDetails>
              )}
              <Bubble variant="ghost" className="w-full">
                <BubbleContent className="w-full">
                  <Markdown text={message.text} />
                </BubbleContent>
              </Bubble>
            </>
          )}
          {message.omitted > 0 && (
            <p className="text-xs text-muted-foreground">
              <Label name="omitted" count={message.omitted} />
            </p>
          )}
        </MessageContent>
      </Message>
    </article>
  );
}
// SQL rows remain small even when one rendered message is very large.
export function* renderShareMessages(payloads: Iterable<string>): Generator<string> {
  for (const message of shareMessages(payloads)) {
    const html = renderToStaticMarkup(<SharedMessage message={message} />);
    for (let start = 0; start < html.length;) {
      let end = Math.min(start + 16_384, html.length);
      if (end < html.length && /[\uD800-\uDBFF]/.test(html[end - 1])) end--;
      yield html.slice(start, end);
      start = end;
    }
  }
}
export function renderShareChrome(
  share: PublicShare | undefined,
  locale: Locale,
  error?: 'unavailable' | 'readFailed',
) {
  const labels = shareLabels(locale);
  return renderToStaticMarkup(
    <>
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 bg-background/95 px-4 py-3 backdrop-blur">
        <span className="font-semibold">EverChat</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label>
            <span className="sr-only">
              <Label name="language" />
            </span>
            <NativeSelect data-share-language="" defaultValue="system" aria-label={labels.language}>
              <option value="system">{labels.system}</option>
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
            </NativeSelect>
          </label>
          <label>
            <span className="sr-only">
              <Label name="theme" />
            </span>
            <NativeSelect data-share-theme="" defaultValue="system" aria-label={labels.theme}>
              <option value="system">{labels.system}</option>
              <option value="light">{labels.light}</option>
              <option value="dark">{labels.dark}</option>
            </NativeSelect>
          </label>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[49rem] flex-col gap-6 px-4 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {share ? (
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-semibold break-words">{share.title}</h1>
            <p className="text-xs text-muted-foreground">
              <Label name="count" count={share.messageCount} />
              {share.omittedAttachments > 0 && <Label name="noAttachments" />}
            </p>
          </div>
        ) : (
          <div role="alert">
            <Label name={error ?? 'unavailable'} />
            <p>
              <a href="" className="underline">
                <Label name="reload" />
              </a>
            </p>
          </div>
        )}
        {share && (
          <div
            id="share-messages"
            className="flex flex-col gap-6"
            dangerouslySetInnerHTML={{ __html: '<!--EVERCHAT_MESSAGES-->' }}
          />
        )}
      </main>
    </>,
  );
}
