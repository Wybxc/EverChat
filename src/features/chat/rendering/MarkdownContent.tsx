import { Button } from '@/components/ui/button';
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { PluginConfig, StreamdownProps } from 'streamdown';
import { recoverApplicationResources } from '../../../platform/pwa/controller';

import 'katex/dist/katex.min.css';
import 'streamdown/styles.css';

type MarkdownRenderer = (typeof import('streamdown'))['Streamdown'];

let markdownRenderer: MarkdownRenderer | null = null;
let markdownRemarkPlugins: StreamdownProps['remarkPlugins'];

let markdownRendererPromise: Promise<MarkdownRenderer> | null = null;

function loadMarkdownRenderer() {
  if (markdownRenderer) return Promise.resolve(markdownRenderer);
  return (markdownRendererPromise ??= Promise.all([import('streamdown'), import('remark-breaks')])
    .then(([{ Streamdown, defaultRemarkPlugins }, { default: remarkBreaks }]) => {
      markdownRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];
      markdownRenderer = Streamdown;
      return Streamdown;
    })
    .catch((error: unknown) => {
      markdownRendererPromise = null;
      throw error;
    }));
}

const markdownPluginLoaders = {
  code: () =>
    import('@streamdown/code').then(({ createCodePlugin }) =>
      createCodePlugin({ themes: ['github-light', 'github-dark'] }),
    ),
  math: () =>
    Promise.all([import('@streamdown/math'), import('./math')]).then(
      ([{ createMathPlugin }, { normalizeMathMarkdown }]) => ({
        plugin: createMathPlugin({ singleDollarTextMath: false }),
        normalize: normalizeMathMarkdown,
      }),
    ),
  mermaid: () =>
    import('@streamdown/mermaid').then(({ createMermaidPlugin }) =>
      createMermaidPlugin({
        config: {
          securityLevel: 'strict',
          startOnLoad: false,
          suppressErrorRendering: true,
          theme: 'base',
        },
      }),
    ),
};

interface MarkdownBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  streaming: boolean;
  container: RefObject<HTMLDivElement | null>;
}
type ScrollSnapshot = { element: HTMLElement; top: number }[];

// Streamdown also loads internal React.lazy chunks, whose rejection escapes the plugin loaders.
class MarkdownBoundary extends Component<MarkdownBoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  getSnapshotBeforeUpdate(previous: MarkdownBoundaryProps): ScrollSnapshot | null {
    if (!previous.streaming || this.props.streaming) return null;
    const positions: ScrollSnapshot = [];
    // Static rendering replaces the stream's blocks. WebKit can reset enclosing
    // scroll panes during that commit, even when their final height is unchanged.
    for (
      let element = this.props.container.current?.parentElement;
      element;
      element = element.parentElement
    )
      if (element.scrollTop > 0) positions.push({ element, top: element.scrollTop });
    return positions;
  }
  componentDidUpdate(
    _previous: MarkdownBoundaryProps,
    _state: { failed: boolean },
    positions: ScrollSnapshot | null,
  ) {
    // Read the committed position first; unchanged panes need no programmatic scroll.
    for (const { element, top } of positions ?? [])
      if (element.isConnected && element.scrollTop !== top) element.scrollTop = top;
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function MarkdownFallback({ content, className }: { content: string; className: string }) {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return (
    <div data-testid="markdown-fallback">
      <div className={`${className} whitespace-pre-wrap`}>{content}</div>
      {/* React.lazy retains a rejected promise. A new page runtime is needed to retry that chunk. */}
      <Button
        variant="ghost"
        type="button"
        className="mt-2"
        disabled={!online}
        onClick={() => void recoverApplicationResources()}
      >
        重新加载
      </Button>
    </div>
  );
}

export function MarkdownContent({
  content,
  streaming,
  searchId,
  className = 'markdown',
}: {
  content: string;
  streaming: boolean;
  searchId?: string;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [Renderer, setRenderer] = useState<MarkdownRenderer | null>(() => markdownRenderer);
  const [plugins, setPlugins] = useState<PluginConfig | null>(null);
  const [normalizeMath, setNormalizeMath] = useState<((source: string) => string) | null>(null);
  const needsCode = /```(?!mermaid\b)/iu.test(content);
  const needsMath = /\$|\\\(|\\\[/u.test(content);
  const needsMermaid = /```mermaid(?:\s|$)/imu.test(content);
  useEffect(() => {
    let active = true;
    const load = () => {
      void loadMarkdownRenderer()
        .then((renderer) => {
          if (active) setRenderer(() => renderer);
        })
        .catch(() => {
          /* Keep the text readable when the runtime is unavailable. */
        });
    };
    load();
    window.addEventListener('online', load);
    return () => {
      active = false;
      window.removeEventListener('online', load);
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (!needsCode && !needsMath && !needsMermaid) {
      setPlugins(null);
      return () => {
        active = false;
      };
    }
    const load = () => {
      void Promise.all([
        needsCode ? markdownPluginLoaders.code() : Promise.resolve(null),
        needsMath ? markdownPluginLoaders.math() : Promise.resolve(null),
        needsMermaid ? markdownPluginLoaders.mermaid() : Promise.resolve(null),
      ])
        .then(([code, math, mermaid]) => {
          if (active) {
            setPlugins({
              ...(code ? { code } : {}),
              ...(math ? { math: math.plugin } : {}),
              ...(mermaid ? { mermaid } : {}),
            });
            setNormalizeMath(() => math?.normalize ?? null);
          }
        })
        .catch(() => {
          if (active) setPlugins(null);
        });
    };
    load();
    window.addEventListener('online', load);
    return () => {
      active = false;
      window.removeEventListener('online', load);
    };
  }, [needsCode, needsMath, needsMermaid]);
  const renderedContent = useMemo(
    () => (needsMath && plugins?.math && normalizeMath ? normalizeMath(content) : content),
    [content, needsMath, normalizeMath, plugins?.math],
  );
  return (
    <div ref={container} data-search-content={searchId}>
      <MarkdownBoundary
        container={container}
        streaming={streaming}
        fallback={<MarkdownFallback content={content} className={className} />}
      >
        {Renderer ? (
          <Renderer
            className={`${className} space-y-3`}
            mode={streaming ? 'streaming' : 'static'}
            isAnimating={streaming}
            remarkPlugins={markdownRemarkPlugins}
            components={{
              a: ({ children, ...props }) => (
                <a {...props} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
              img: ({ alt }) => (
                <span className="text-muted-foreground">[图片：{alt ?? '附件'}]</span>
              ),
            }}
            plugins={plugins ?? undefined}
            controls={{
              code: { copy: true, download: false },
              mermaid: { fullscreen: true, download: false, copy: false, panZoom: true },
            }}
          >
            {renderedContent}
          </Renderer>
        ) : (
          <div className={`${className} whitespace-pre-wrap`}>{content}</div>
        )}
      </MarkdownBoundary>
    </div>
  );
}
