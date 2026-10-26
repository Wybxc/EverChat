import { shareLabels } from '../../../shared/sharing/labels';
import { shareIdPattern } from '../../../shared/sharing/types';
import { chooseLocale, getLocaleSnapshot, subscribeLocale } from '../../platform/i18n/preference';
import { localePreference } from '../../../shared/i18n/locale';

/** Enhance the server document without fetching its initial message body again. */
export function enhancePublicShare() {
  const root = document.getElementById('root')!;
  const id = root.dataset.shareId ?? '';
  const labels = () => shareLabels(getLocaleSnapshot().locale);
  const language = document.querySelector<HTMLSelectElement>('[data-share-language]');
  const theme = document.querySelector<HTMLSelectElement>('[data-share-theme]');
  const media = matchMedia('(prefers-color-scheme: dark)');
  let appearance = 'system';
  try {
    appearance = localStorage.getItem('everchat:theme') ?? 'system';
  } catch {
    /* System. */
  }
  const applyTheme = () => {
    const dark = appearance === 'dark' || (appearance !== 'light' && media.matches);
    document.documentElement.dataset.theme = appearance;
    document.documentElement.classList.toggle('dark', dark);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? '#151517' : '#ffffff');
    if (theme) theme.value = appearance;
  };
  const applyLanguage = () => {
    document.documentElement.lang = getLocaleSnapshot().locale;
    if (language) {
      language.value = getLocaleSnapshot().preference;
      language.setAttribute('aria-label', labels().language);
      language.options[0].textContent = labels().system;
    }
    if (theme) {
      theme.setAttribute('aria-label', labels().theme);
      for (const option of theme.options)
        option.textContent = labels()[option.value as 'system' | 'light' | 'dark'];
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('.share-expand'))
      button.textContent =
        button.getAttribute('aria-expanded') === 'true' ? labels().collapse : labels().expand;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-share-copy]'))
      button.textContent = labels().copy;
  };
  applyTheme();
  applyLanguage();
  subscribeLocale(applyLanguage);
  language?.addEventListener('change', () => chooseLocale(localePreference(language.value)));
  theme?.addEventListener('change', () => {
    appearance = theme.value;
    try {
      localStorage.setItem('everchat:theme', appearance);
    } catch {
      /* Session only. */
    }
    applyTheme();
  });
  media.addEventListener('change', applyTheme);
  window.addEventListener('storage', (event) => {
    if (event.key === 'everchat:theme' || event.key === null) {
      appearance = event.newValue ?? 'system';
      applyTheme();
    }
  });
  const unavailable = (connection = false) => {
    const main = document.createElement('main');
    main.className = 'mx-auto w-full max-w-[49rem] px-4 py-6';
    main.setAttribute('role', 'alert');
    main.textContent = connection ? labels().connectionFailed : labels().unavailable;
    const retry = document.createElement('a');
    retry.href = location.href;
    retry.className = 'ml-2 underline';
    retry.textContent = labels().reload;
    main.append(retry);
    root.replaceChildren(main);
    document.title = 'EverChat';
  };
  if (!shareIdPattern.test(id)) {
    if (!root.querySelector('[role="alert"]')) unavailable();
    return;
  }
  let cleared = false;
  let expiryTimer: ReturnType<typeof setTimeout>;
  const expiresAt = Number(root.dataset.shareExpiry) || null;
  const expire = () => {
    if (!expiresAt || cleared) return;
    const remaining = expiresAt - Date.now();
    if (remaining > 0) expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    else {
      cleared = true;
      unavailable();
    }
  };
  expire();
  let checking = false;
  const check = async () => {
    if (cleared || checking || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const response = await fetch(`/public/shares/${id}/status`, {
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        cleared = true;
        clearTimeout(expiryTimer);
        unavailable(response.status !== 404);
      }
      await response.body?.cancel();
    } catch {
      cleared = true;
      clearTimeout(expiryTimer);
      unavailable(true);
    } finally {
      checking = false;
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) void check();
  });
  const measureUsers = () => {
    for (const content of document.querySelectorAll<HTMLElement>('[data-share-user-text]')) {
      const button = content.nextElementSibling as HTMLButtonElement;
      if (button.getAttribute('aria-expanded') === 'true') continue;
      const long = content.scrollHeight > parseFloat(getComputedStyle(content).lineHeight) * 10 + 1;
      content.classList.toggle('share-user-collapsed', long);
      button.hidden = !long;
      button.onclick = () => {
        const expanded = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(expanded));
        content.classList.toggle('share-user-collapsed', !expanded);
        button.textContent = expanded ? labels().collapse : labels().expand;
      };
    }
  };
  measureUsers();
  new ResizeObserver(measureUsers).observe(root);
  document.addEventListener('click', (event) => {
    const imageButton =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-share-image]')
        : null;
    if (!imageButton) return;
    const url = new URL(imageButton.dataset.shareImage!);
    if (url.protocol !== 'https:' || url.origin === location.origin) return;
    const image = document.createElement('img');
    image.src = url.href;
    image.alt = imageButton.dataset.imageAlt ?? '';
    image.referrerPolicy = 'no-referrer';
    image.crossOrigin = 'anonymous';
    image.loading = 'lazy';
    imageButton.replaceWith(image);
  });
  for (const block of document.querySelectorAll<HTMLElement>('[data-streamdown="code-block"]')) {
    const code = block.querySelector('code');
    if (!code) continue;
    const lines = [...code.children];
    const source = lines.length
      ? lines.map((line) => line.textContent).join('\n')
      : (code.textContent ?? '');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.dataset.shareCopy = '';
    copy.className = 'ml-auto rounded px-2 py-1 text-xs hover:bg-muted';
    copy.textContent = labels().copy;
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(source);
        copy.textContent = labels().copied;
      } catch {
        copy.textContent = labels().copyFailed;
      }
    };
    block.querySelector('[data-streamdown="code-block-header"]')?.append(copy);
    if (block.dataset.language === 'mermaid') {
      void Promise.all([
        import('react'),
        import('react-dom/client'),
        import('../chat/rendering/MarkdownContent'),
        import('react-i18next'),
        import('../../platform/i18n/react'),
      ])
        .then(([react, dom, { MarkdownContent }, { I18nextProvider }, { pageI18n }]) => {
          if (!block.isConnected) return;
          const island = document.createElement('div');
          block.replaceWith(island);
          dom.createRoot(island).render(
            react.createElement(
              I18nextProvider,
              { i18n: pageI18n },
              react.createElement(MarkdownContent, {
                content: `\`\`\`mermaid\n${source}\n\`\`\``,
                streaming: false,
                publicContent: true,
              }),
            ),
          );
        })
        .catch(() => {
          /* Keep readable source. */
        });
    } else if (block.dataset.language) {
      void import('@streamdown/code')
        .then(({ code: plugin }) => {
          const language = block.dataset.language as Parameters<
            typeof plugin.highlight
          >[0]['language'];
          if (!plugin.supportsLanguage(language)) return;
          const apply = (result: NonNullable<ReturnType<typeof plugin.highlight>>) => {
            if (!code.isConnected) return;
            const fragment = document.createDocumentFragment();
            for (const line of result.tokens) {
              const row = document.createElement('span');
              row.className = 'block';
              for (const token of line) {
                const span = document.createElement('span');
                span.textContent = token.content;
                span.className =
                  'text-[var(--sdm-c,inherit)] dark:text-[var(--shiki-dark,var(--sdm-c,inherit))]';
                if (token.color) span.style.setProperty('--sdm-c', token.color);
                for (const [key, value] of Object.entries(token.htmlStyle ?? {}))
                  span.style.setProperty(key, String(value));
                row.append(span);
              }
              fragment.append(row);
            }
            code.replaceChildren(fragment);
          };
          const result = plugin.highlight(
            { code: source, language, themes: ['github-light', 'github-dark'] },
            apply,
          );
          if (result) apply(result);
        })
        .catch(() => {
          /* Keep plain code. */
        });
    }
  }
}
