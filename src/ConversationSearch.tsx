import { Button } from '@/components/ui/button';
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react';
import { countMatches, matchAt, renderedText, textRange, type SearchText } from './conversation-search';
import { PAUSE_FOLLOW_EVENT } from './useFollowScroll';

interface Field { key: string; root: HTMLElement; source: SearchText; count: number; offset: number }
interface Position { key: string; ordinal: number; index: number }

function reveal(range: Range, viewport: HTMLElement) {
  for (let element = range.startContainer.parentElement; element; element = element.parentElement) {
    if (element instanceof HTMLDetailsElement) element.open = true;
    if (element === viewport) break;
  }
  for (let element = range.startContainer.parentElement; element; element = element.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    let rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    if (/auto|scroll/.test(overflowY) && element.scrollHeight > element.clientHeight) {
      element.dispatchEvent(new Event(PAUSE_FOLLOW_EVENT));
      element.scrollTop += rect.top + rect.height / 2 - bounds.top - element.clientHeight / 2;
      rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    }
    if (/auto|scroll/.test(overflowX) && element.scrollWidth > element.clientWidth && (rect.left < bounds.left || rect.right > bounds.left + element.clientWidth)) {
      element.scrollLeft += rect.left - bounds.left - 12;
    }
    if (element === viewport) break;
  }
}

export function ConversationSearch({ content, viewport, close, initial }: { content: HTMLElement | null; viewport: HTMLElement | null; close: () => void; initial?: { query: string; key: string } }) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initial?.query ?? '');
  const [status, setStatus] = useState({ count: 0, index: 0, excerpt: '', reasoning: false });
  const move = useRef<(direction: number) => void>(() => {});
  const previousQuery = useRef('');
  const position = useRef<Position | null>(null);
  const targetPending = useRef(Boolean(initial));
  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    if (!content || !viewport) return;
    const cache = new Map<HTMLElement, { source: SearchText; count: number }>();
    let fields: Field[] = [], count = 0, timer: ReturnType<typeof setTimeout> | undefined;
    let currentArticle: HTMLElement | null = null;
    const clear = () => {
      if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('everchat-search');
      currentArticle?.removeAttribute('data-search-current'); currentArticle = null;
    };
    const select = (index: number, scroll: boolean) => {
      clear();
      const field = fields.find((item) => index >= item.offset && index < item.offset + item.count);
      if (!field) { position.current = null; setStatus({ count, index: 0, excerpt: '', reasoning: false }); return; }
      const ordinal = index - field.offset, match = matchAt(field.source.text, query, ordinal);
      if (!match) return;
      const range = textRange(field.source, match);
      position.current = { key: field.key, ordinal, index };
      currentArticle = field.root.closest<HTMLElement>('[data-message-id]');
      currentArticle?.setAttribute('data-search-current', 'true');
      if (range && typeof Highlight !== 'undefined' && CSS.highlights) CSS.highlights.set('everchat-search', new Highlight(range));
      setStatus({ count, index, reasoning: field.key.endsWith(':reasoning'),
        excerpt: field.source.text.slice(Math.max(0, match.start - 24), match.end + 48).replace(/\s+/gu, ' ') });
      if (range && scroll) reveal(range, viewport);
    };
    let changedQuery = previousQuery.current !== query;
    previousQuery.current = query;
    const rebuild = (scroll: boolean) => {
      fields = []; count = 0;
      const roots = [...content.querySelectorAll<HTMLElement>('[data-search-content]')];
      const live = new Set(roots);
      for (const element of cache.keys()) if (!live.has(element)) cache.delete(element);
      if (query.trim()) for (const root of roots) {
        let cached = cache.get(root);
        if (!cached) { const source = renderedText(root); cached = { source, count: countMatches(source.text, query) }; cache.set(root, cached); }
        if (cached.count) { fields.push({ key: root.dataset.searchContent!, root, ...cached, offset: count }); count += cached.count; }
      }
      const previous = position.current;
      if (query !== initial?.query) targetPending.current = false;
      const target = targetPending.current && fields.find((field) => field.key === initial?.key);
      const same = previous && fields.find((field) => field.key === previous.key && field.count > previous.ordinal);
      const index = target ? target.offset : changedQuery ? 0 : same ? same.offset + previous!.ordinal : Math.min(previous?.index ?? 0, Math.max(0, count - 1));
      select(index, scroll || changedQuery || Boolean(target)); changedQuery = false;
      if (target) targetPending.current = false;
    };
    // Only dirty Markdown fields are rescanned during generation; no array of every occurrence is retained.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        const root = element?.closest<HTMLElement>('[data-search-content]');
        if (root) cache.delete(root);
      }
      if (!timer) timer = setTimeout(() => { timer = undefined; rebuild(false); }, 150);
    });
    timer = setTimeout(() => { timer = undefined; rebuild(changedQuery); }, 150);
    observer.observe(content, { subtree: true, childList: true, characterData: true });
    move.current = (direction) => { if (count) select(((position.current?.index ?? 0) + direction + count) % count, true); };
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); clear(); move.current = () => {}; };
  }, [content, viewport, query, initial]);

  return <div id="conversation-search" role="search" aria-label="当前对话搜索" className="shrink-0 border-b border-border bg-muted px-3 py-2 sm:px-8" onKeyDown={(event) => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); close(); } }}>
    <div className="mx-auto flex w-full max-w-3xl items-center gap-1 sm:gap-2">
      <label className="field-control h-11 min-w-0 flex-1 border-input bg-background"><Search className="h-[0.875rem] w-[0.875rem]" /><input ref={input} aria-label="查找当前对话" placeholder="查找当前对话" maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); move.current(event.shiftKey ? -1 : 1); }
      }} /></label>
      <span role="status" className="min-w-14 shrink-0 text-center text-xs text-foreground"><span aria-hidden="true">{query.trim() ? status.count ? `${status.index + 1} / ${status.count}` : '无结果' : ''}</span><span className="sr-only">{query.trim() ? status.count ? `第 ${status.index + 1} 个匹配，共 ${status.count} 个。${status.reasoning ? '思考内容' : '正文'}：${status.excerpt}` : '没有匹配结果' : '输入关键词查找'}</span></span>
      <Button variant="ghost" size="icon" type="button" className="h-11 w-11" aria-label="上一个匹配" disabled={!status.count} onClick={() => move.current(-1)}><ArrowUp className="h-[0.9375rem] w-[0.9375rem]" /></Button>
      <Button variant="ghost" size="icon" type="button" className="h-11 w-11" aria-label="下一个匹配" disabled={!status.count} onClick={() => move.current(1)}><ArrowDown className="h-[0.9375rem] w-[0.9375rem]" /></Button>
      <Button variant="ghost" size="icon" type="button" className="h-11 w-11" aria-label="关闭对话搜索" onClick={close}><X className="h-[0.9375rem] w-[0.9375rem]" /></Button>
    </div>
  </div>;
}
