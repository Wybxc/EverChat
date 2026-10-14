import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, ArrowUp, Check, CheckCheck, CloudOff, Copy, Download, Feather, Infinity as InfinityIcon, Lightbulb, LockKeyhole, Menu, MessageCircle, Monitor, Moon, Pencil, Pin, Plus, RefreshCw, Search, Settings, Sparkles, Square, Sun, WifiOff, X } from 'lucide-react';
import 'streamdown/styles.css';
import 'katex/dist/katex.min.css';
import type { PluginConfig } from 'streamdown';
import { isActive, type ConversationInfo, type LibrarySnapshot, type Message, type ProviderSettings, type ReasoningEffort, type SessionInfo, type Submission, type SubmitInput } from '../shared/types';
import { api, ApiError } from './api';
import { clearLocal, deletedAt, markConversationDeleted, read, write, writePending, type Pending } from './storage';
import { useConversation } from './useConversation';
import { ProviderSettingsPanel } from './ProviderSettings';
import { chatModels, effortLabels, modelSelectionKey } from '../shared/models';
import { useThemeMode } from './theme';
import { useFollowScroll } from './useFollowScroll';
import { conversationUrl, useConversationRoute } from './useConversationRoute';
import { ConversationActions } from './ConversationActions';
import { ConversationSearch } from './ConversationSearch';
import { LibrarySearch } from './LibrarySearch';
import type { SearchResult } from '../shared/search';
import type { EverChatBackup } from '../shared/backup';

const EMPTY_SESSION: SessionInfo = { authenticated: false, configured: false, provider: '', model: '' };
const Streamdown = lazy(() => import('streamdown').then(({ Streamdown: Component }) => ({ default: Component })));
const markdownPluginLoaders = {
  code: () => import('@streamdown/code').then(({ createCodePlugin }) => createCodePlugin({ themes: ['github-light', 'github-dark'] })),
  math: () => import('@streamdown/math').then(({ createMathPlugin }) => createMathPlugin({ singleDollarTextMath: false })),
  mermaid: () => import('@streamdown/mermaid').then(({ createMermaidPlugin }) => createMermaidPlugin({ config: { securityLevel: 'strict', startOnLoad: false, suppressErrorRendering: true, theme: 'base' } })),
};
const starters = [
  { icon: Lightbulb, title: '梳理想法', prompt: '帮我梳理一个新项目的想法。请先问我三个能让方向更清晰的问题。' },
  { icon: Feather, title: '写一段文字', prompt: '我想写一个关于重逢的短篇故事，帮我构思一个有画面感的开头。' },
  { icon: Search, title: '解释概念', prompt: '用简单的语言和生活中的例子，向我解释什么是 Serverless。' },
];

function MarkdownContent({ content, streaming, searchId, className = 'markdown' }: { content: string; streaming: boolean; searchId?: string; className?: string }) {
  const [plugins, setPlugins] = useState<PluginConfig | null>(null);
  const needsCode = /```(?!mermaid\b)/iu.test(content);
  const needsMath = /\$\$|\\\(|\\\[/u.test(content);
  const needsMermaid = /```mermaid(?:\s|$)/imu.test(content);
  useEffect(() => {
    let active = true;
    if (!needsCode && !needsMath && !needsMermaid) { setPlugins(null); return () => { active = false; }; }
    void Promise.all([
      needsCode ? markdownPluginLoaders.code() : Promise.resolve(null),
      needsMath ? markdownPluginLoaders.math() : Promise.resolve(null),
      needsMermaid ? markdownPluginLoaders.mermaid() : Promise.resolve(null),
    ]).then(([code, math, mermaid]) => {
      if (active) setPlugins({ ...(code ? { code } : {}), ...(math ? { math } : {}), ...(mermaid ? { mermaid } : {}) });
    });
    return () => { active = false; };
  }, [needsCode, needsMath, needsMermaid]);
  return <div data-search-content={searchId}><Suspense fallback={<div className={`${className} whitespace-pre-wrap`}>{content}</div>}>
    <Streamdown className={className} mode={streaming ? 'streaming' : 'static'} isAnimating={streaming} components={{
      a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span className="text-base-content/60">[图片：{alt ?? '附件'}]</span>,
    }} plugins={plugins ?? undefined} controls={{ code: { copy: true, download: false }, mermaid: { fullscreen: true, download: false, copy: false, panZoom: true } }}>{content}</Streamdown>
  </Suspense></div>;
}

function Brand({ small = false }: { small?: boolean }) {
  return <div className="flex items-center gap-3"><span className={`${small ? 'h-9 w-9' : 'h-11 w-11'} inline-flex shrink-0 items-center justify-center rounded-lg bg-neutral text-neutral-content`}><InfinityIcon size={small ? 24 : 29} strokeWidth={1.7} /></span><span className="text-xl font-semibold">EverChat</span></div>;
}

function ThemeControl() {
  const [theme, choose] = useThemeMode();
  return <fieldset className="space-y-2"><legend className="text-sm font-medium">颜色模式</legend><div className="join">
    <label className={`join-item btn btn-sm gap-2 ${theme === 'light' ? 'btn-active' : ''}`}><input type="radio" name="theme" value="light" className="sr-only" checked={theme === 'light'} onChange={() => choose('light')} /><Sun size={14} />浅色</label>
    <label className={`join-item btn btn-sm gap-2 ${theme === 'dark' ? 'btn-active' : ''}`}><input type="radio" name="theme" value="dark" className="sr-only" checked={theme === 'dark'} onChange={() => choose('dark')} /><Moon size={14} />深色</label>
    <label className={`join-item btn btn-sm gap-2 ${theme === 'system' ? 'btn-active' : ''}`}><input type="radio" name="theme" value="system" className="sr-only" checked={theme === 'system'} onChange={() => choose('system')} /><Monitor size={14} />系统</label>
  </div></fieldset>;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const downloadFile = (filename: string, content: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

function Login({ session, onLogin }: { session: SessionInfo; onLogin: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try { await api('/login', 'POST', { password }); await onLogin(); }
    catch (error) { setError(error instanceof Error ? error.message : '登录失败。'); }
    finally { setBusy(false); }
  };
  return <main className="flex min-h-dvh flex-col bg-base-200">
    <header className="flex items-start justify-between px-7 py-7 sm:px-12"><Brand /><ThemeControl /></header>
    <section className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-7 pb-20">
      <span className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-base-content/50 bg-base-100"><LockKeyhole size={24} strokeWidth={1.5} /></span>
      <h1 className="text-3xl font-semibold leading-snug tracking-tight">登录</h1>
      <form onSubmit={submit} className="mt-7">
        <label htmlFor="password" className="mb-2 block text-xs font-medium">访问密码</label>
        <input id="password" autoFocus required type="password" autoComplete="current-password" className="input h-12 w-full border-base-content/50 bg-base-100" placeholder="输入你的私人空间密码" value={password} onChange={(event) => setPassword(event.target.value)} disabled={!session.configured} />
        <button className="btn btn-primary mt-4 h-12 w-full justify-between px-5" disabled={busy || !session.configured || !password.trim()}>{busy ? '正在进入…' : '进入我的空间'}{busy ? <span className="loading loading-spinner loading-xs" /> : <ArrowRight size={17} />}</button>
      </form>
      {error && <p role="alert" className="mt-4 text-sm font-medium text-base-content">{error}</p>}
      {!session.configured && <p role="alert" className="mt-4 text-sm font-medium leading-6 text-base-content">服务尚未设置访问密码。请按照 README 配置服务端 Secrets 后重试。</p>}
      {local && <p className="mt-4 text-xs text-base-content/60">本地密码：<code>everchat-local</code></p>}
    </section>
    <footer className="pb-6 text-center text-[11px] text-base-content/60">EverChat</footer>
  </main>;
}

function MessageView({ message, busy, onRetry, onEdit }: { message: Message; busy: boolean; onRetry: () => void; onEdit: () => void }) {
  const [copied, setCopied] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const reasoningScroll = useFollowScroll(message.id);
  const copy = async () => {
    try { await navigator.clipboard.writeText(message.content); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* Clipboard can be unavailable outside HTTPS. */ }
  };
  if (message.role === 'user') return <article data-testid="user-message" data-message-id={message.id} className="group ml-auto w-fit max-w-[90%] sm:max-w-[82%]">
    <div data-search-content={`${message.id}:content`} className="rounded-2xl rounded-br-md border border-base-content/50 bg-base-200 px-5 py-3.5 text-[15px] leading-7 whitespace-pre-wrap break-words">{message.content}</div>
    <div className="mt-1.5 flex items-center justify-end gap-2 text-[11px] text-base-content/60">
      {message.revisionOf && <span>新版本</span>}
      <CheckCheck size={13} /><span>已保存</span>
      <button className="btn btn-ghost btn-xs btn-square sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100" aria-label="编辑为新版本" title="编辑为新版本" disabled={busy} onClick={onEdit}><Pencil size={12} /></button>
    </div>
  </article>;
  return <article data-testid="assistant-message" data-message-id={message.id} data-status={message.status} data-durable-offset={message.durableOffset ?? 0} data-live-offset={message.liveOffset ?? message.durableOffset ?? 0} className="group flex gap-3 sm:gap-4">
    <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-base-content/50 bg-base-100"><InfinityIcon size={20} strokeWidth={1.7} /></span>
    <div className="min-w-0 flex-1 pt-1">
      <div className="mb-3 flex items-center gap-3 text-xs"><span className="font-semibold">{message.modelName || message.model || 'EverChat'}</span>{message.revisionOf && <span className="text-base-content/60">新版本</span>}{isActive(message) && <span className="flex items-center gap-1.5 text-base-content/60"><span className="loading loading-dots loading-xs" />{message.status === 'queued' ? '排队中' : '生成中'}</span>}</div>
      {message.reasoning && <details open={reasoningOpen || isActive(message)} onToggle={(event) => setReasoningOpen(event.currentTarget.open)} className="collapse collapse-arrow mb-4 border border-base-content/30 bg-base-200" data-testid="message-reasoning">
        <summary className="collapse-title min-h-0 py-3 text-sm font-medium">思考过程</summary>
        <div className="collapse-content text-sm"><div ref={reasoningScroll.viewportRef} className="max-h-80 overflow-y-auto break-words"><div ref={reasoningScroll.contentRef}><MarkdownContent content={message.reasoning} searchId={`${message.id}:reasoning`} streaming={isActive(message)} /></div></div></div>
      </details>}
      {message.content ? <MarkdownContent content={message.content} searchId={`${message.id}:content`} streaming={isActive(message)} /> : isActive(message) && !message.reasoning ? <p className="py-2 text-sm text-base-content/60">准备中…</p> : null}
      {message.status === 'failed' && <p role="alert" className="mt-4 rounded-lg bg-error/5 px-3 py-2 text-xs font-medium leading-6 text-base-content">{message.error ?? '生成失败，已保存部分内容。'}</p>}
      {message.status === 'cancelled' && <p className="mt-4 text-xs text-base-content/60">已停止</p>}
      {!isActive(message) && <div className="mt-4 flex items-center gap-1 text-base-content/60">
        <button className="btn btn-ghost btn-xs gap-1.5" onClick={copy} aria-label="复制回答">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button>
        <button className="btn btn-ghost btn-xs gap-1.5" disabled={busy} onClick={onRetry}><RefreshCw size={12} />重新生成</button>
      </div>}
    </div>
  </article>;
}

export function App() {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [bootError, setBootError] = useState('');
  const [localConversations, setLocalConversations] = useState<ConversationInfo[]>(() => read('library', []));
  const { id: selected, invalid: invalidRoute, navigate } = useConversationRoute();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [pending, setPending] = useState<Pending[]>(() => read<Pending[]>('pending', []).filter((item) => !deletedAt(item.conversation.id)));
  const pendingRef = useRef(pending);
  const deliveryLocks = useRef(new Set<string>());
  const [draft, setDraft] = useState('');
  const [revisionOf, setRevisionOf] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [archivedList, setArchivedList] = useState(false);
  const [sending, setSending] = useState(false);
  const { viewportRef, contentRef, viewport, content, atBottom, scrollToBottom } = useFollowScroll(selected);
  const [conversationSearchFor, setConversationSearchFor] = useState<string | null>(null);
  const [searchJump, setSearchJump] = useState<{ id: string; query: string; key: string; token: number } | null>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const mobileSidebarTrigger = useRef<HTMLButtonElement>(null);
  const settings = useRef<HTMLDialogElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelChoice, setModelChoice] = useState<string>(() => read('chat-model', ''));
  const models = session?.models ?? [];
  const selectedModel = models.find((model) => modelSelectionKey(model) === modelChoice)
    ?? models.find((model) => model.providerId === session?.activeProviderId && model.model === session?.model)
    ?? models[0];
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | ''>('');
  const openSettings = () => { setSettingsOpen(true); settings.current?.showModal(); };
  const providerSaved = useCallback((config: ProviderSettings) => {
    const profile = config.providers.find((profile) => profile.id === config.activeProviderId);
    const model = profile?.models.find((model) => model.id === config.activeModel && model.enabled);
    setSession((current) => {
      if (!current?.authenticated) return current;
      const next = { ...current, provider: model ? profile!.provider : '', model: model?.id ?? '', modelName: model?.name || model?.id || '', activeProviderId: model ? profile!.id : null, models: chatModels(config), showReasoning: config.showReasoning, systemPrompt: config.systemPrompt, maxOutputTokens: config.maxOutputTokens };
      write('session', next); return next;
    });
  }, []);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const loggedOut = useCallback(() => { setSession((current) => ({ ...(current ?? EMPTY_SESSION), authenticated: false })); }, []);
  const rememberDeletion = useCallback((id: string, time: number) => {
    markConversationDeleted(id, time);
    const remaining = pendingRef.current.filter((item) => item.conversation.id !== id);
    writePending(remaining); pendingRef.current = remaining; setPending(remaining);
    setLocalConversations((items) => items.filter((item) => item.id !== id));
    queryClient.setQueryData<ConversationInfo[]>(['conversations'], (items) => items?.filter((item) => item.id !== id));
    write('library', read<ConversationInfo[]>('library', []).filter((item) => item.id !== id));
    if (selectedRef.current === id) { setDraft(''); setRevisionOf(undefined); }
  }, [queryClient]);
  const currentPending = pending.find((item) => item.conversation.id === selected);
  const { snapshot, durableSnapshot, hasUnconfirmed, connection, syncedAt, loading, syncError, reconnect } = useConversation(selected, Boolean(session?.authenticated), loggedOut, Boolean(currentPending && !currentPending.error), rememberDeletion, selected ? deletedAt(selected) : null);
  const active = snapshot.messages.find(isActive);
  const canSearch = Boolean(selected && snapshot.messages.length && !snapshot.deletedAt && session?.authenticated);
  const searchOpen = canSearch && (conversationSearchFor === selected || searchJump?.id === selected);
  const closeConversationSearch = () => { setConversationSearchFor(null); setSearchJump(null); searchTrigger.current?.focus(); };
  useEffect(() => { setConversationSearchFor(null); setSearchJump((current) => current?.id === selected ? current : null); }, [selected]);
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if (canSearch && !event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f' && !document.querySelector('dialog[open]')) {
        event.preventDefault(); setConversationSearchFor(selected);
        document.querySelector<HTMLInputElement>('#conversation-search input')?.focus();
      }
    };
    window.addEventListener('keydown', find);
    return () => window.removeEventListener('keydown', find);
  }, [canSearch, selected]);
  const libraryQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      let page: LibrarySnapshot;
      do {
        page = await api<LibrarySnapshot>(`/conversations?after=${read('library-deletion-cursor', 0)}`);
        for (const deletion of page.deletions) rememberDeletion(deletion.id, deletion.deletedAt);
        write('library-deletion-cursor', page.deletionCursor);
      } while (page.hasMoreDeletions);
      return page.conversations;
    },
    enabled: Boolean(session?.authenticated),
    initialData: () => read('library', []),
    refetchInterval: 10_000,
  });
  const conversations = useMemo(() => {
    const cloud = libraryQuery.data ?? [];
    const cloudIds = new Set(cloud.map((item) => item.id));
    const queued = pending.map((item) => item.conversation).filter((item) => !cloudIds.has(item.id));
    const local = localConversations.filter((item) => !cloudIds.has(item.id) && !queued.some((next) => next.id === item.id));
    return [...queued, ...local, ...cloud].filter((item) => !deletedAt(item.id)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }, [libraryQuery.data, localConversations, pending]);
  const busy = Boolean(active || currentPending || sending || syncError || invalidRoute);
  const currentConversation = conversations.find((item) => item.id === selected);
  const visibleConversations = conversations.filter((item) => Boolean(item.archived) === archivedList && item.title.toLowerCase().includes(search.toLowerCase()));

  const boot = useCallback(async () => {
    setBootError('');
    try {
      const current = await api<SessionInfo>('/session'); setSession(current); write('session', current);
    } catch {
      const cached = read<SessionInfo | null>('session', null);
      if (cached?.authenticated) setSession(cached);
      else setBootError('暂时无法连接你的空间。请检查网络和服务是否已启动。');
    }
  }, []);
  useEffect(() => {
    void boot();
    const refresh = () => { void boot(); };
    window.addEventListener('online', refresh); window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh); };
  }, [boot]);
  useEffect(() => {
    if (libraryQuery.error instanceof ApiError && libraryQuery.error.status === 401) loggedOut();
    if (libraryQuery.data) { setLocalConversations(libraryQuery.data); write('library', libraryQuery.data); }
  }, [libraryQuery.data, libraryQuery.error, loggedOut]);
  const refreshLibrary = useCallback(() => { void queryClient.invalidateQueries({ queryKey: ['conversations'] }); void queryClient.invalidateQueries({ queryKey: ['body-search'] }); }, [queryClient]);

  const commitPending = (items: Pending[]) => {
    items = items.filter((item) => !deletedAt(item.conversation.id));
    if (!writePending(items)) { setError('浏览器存储已满，无法可靠保存待发送消息。请释放空间后重试。'); return false; }
    pendingRef.current = items; setPending(items); return true;
  };
  const deliver = async (item: Pending) => {
    if (deletedAt(item.conversation.id)) return;
    const key = item.input.requestId;
    if (deliveryLocks.current.has(key) || !navigator.onLine || !sessionRef.current?.authenticated) return;
    deliveryLocks.current.add(key);
    try {
      await api('/conversations', 'POST', { id: item.conversation.id, title: item.conversation.title });
      await api<Submission>(`/conversations/${item.conversation.id}/messages`, 'POST', item.input);
      commitPending(pendingRef.current.filter((next) => next.input.requestId !== key));
      refreshLibrary();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) loggedOut();
      else if (error instanceof ApiError && error.status === 410) rememberDeletion(item.conversation.id, Date.now());
      else if (error instanceof ApiError) commitPending(pendingRef.current.map((next) => next.input.requestId === key ? { ...next, error: error.message } : next));
      // A network error has an unknown outcome: keep the same request ID for retry.
    } finally { deliveryLocks.current.delete(key); }
  };
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;
  useEffect(() => {
    const flush = () => { for (const item of pendingRef.current) if (!item.error) void deliverRef.current(item); };
    flush();
    const timer = setInterval(flush, 5000);
    window.addEventListener('online', flush);
    return () => { clearInterval(timer); window.removeEventListener('online', flush); };
  }, [session?.authenticated, pending.length]);

  useEffect(() => {
    const saved: { text: string; revisionOf?: string } = selected && deletedAt(selected) ? { text: '' } : read(`draft:${selected ?? 'new'}`, { text: '' });
    setDraft(saved.text); setRevisionOf(saved.revisionOf); setError('');
  }, [selected]);
  useEffect(() => {
    if (!selectedModel?.reasoningSupported) { setReasoningEffort(''); return; }
    const saved = read<ReasoningEffort | ''>(`reasoning-effort:${modelSelectionKey(selectedModel)}`, '');
    setReasoningEffort(selectedModel.reasoningEfforts.includes(saved as ReasoningEffort) ? saved : '');
  }, [selectedModel]);
  useEffect(() => {
    const node = editor.current;
    if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 160)}px`; }
  }, [draft]);
  const updateDraft = (text: string) => { setDraft(text); write(`draft:${selected ?? 'new'}`, { text, revisionOf }); };
  const select = (id: string | null) => {
    setSearchJump(null);
    navigate(id); setSidebarOpen(false);
    requestAnimationFrame(() => editor.current?.focus());
  };
  const openSearchResult = (result: SearchResult, query: string) => {
    navigate(result.conversationId); setSidebarOpen(false);
    setSearchJump({ id: result.conversationId, query, key: `${result.messageId}:${result.field}`, token: Date.now() });
  };
  const closeSidebar = () => {
    setSidebarOpen(false);
    requestAnimationFrame(() => mobileSidebarTrigger.current?.focus());
  };

  const queue = async (input: SubmitInput) => {
    if (!input.selection && selectedModel) input = { ...input, selection: { providerId: selectedModel.providerId, model: selectedModel.model } };
    if (input.showReasoning === undefined) input = { ...input, showReasoning: session?.showReasoning ?? false };
    const generationModel = input.selection ? models.find((model) => model.providerId === input.selection!.providerId && model.model === input.selection!.model) : selectedModel;
    const generationEffort = generationModel && generationModel === selectedModel
      ? reasoningEffort
      : generationModel ? read<ReasoningEffort | ''>(`reasoning-effort:${modelSelectionKey(generationModel)}`, '') : '';
    if (input.reasoningEffort === undefined && generationModel?.reasoningSupported && generationEffort && generationModel.reasoningEfforts.includes(generationEffort)) {
      input = { ...input, reasoningEffort: generationEffort };
    }
    const conversation: ConversationInfo = currentConversation ?? {
      id: selected ?? crypto.randomUUID(), title: (input.content ?? '新对话').trim().slice(0, 26), createdAt: Date.now(), updatedAt: Date.now(), pinned: false, archived: false,
    };
    const item: Pending = { conversation, input };
    if (!commitPending([...pendingRef.current, item])) return;
    if (!conversations.some((item) => item.id === conversation.id)) {
      const items = [conversation, ...localConversations]; setLocalConversations(items); write('library', items);
    }
    write(`draft:${selected ?? 'new'}`, { text: '' }); setDraft(''); setRevisionOf(undefined);
    select(conversation.id);
    scrollToBottom();
    await deliver(item);
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft.trim() || busy || !selectedModel) return;
    setError(''); setSending(true);
    try { await queue({ requestId: crypto.randomUUID(), content: draft.trim(), ...(revisionOf ? { revisionOf } : {}) }); }
    finally { setSending(false); }
  };
  const cancel = async () => {
    if (!active?.runId || !selected) return;
    try { await api(`/conversations/${selected}/cancel`, 'POST', { runId: active.runId }); }
    catch (error) { setError(error instanceof Error ? error.message : '停止失败。'); }
  };
  const retry = async (message: Message) => {
    if (busy || !selectedModel) { openSettings(); return; }
    setSending(true);
    try { await queue({ requestId: crypto.randomUUID(), retryOf: message.id,
      ...(message.providerId && message.model ? { selection: { providerId: message.providerId, model: message.model } } : {}),
    }); }
    finally { setSending(false); }
  };
  const edit = (message: Message) => {
    setRevisionOf(message.id); setDraft(message.content);
    write(`draft:${selected}`, { text: message.content, revisionOf: message.id }); editor.current?.focus();
  };
  const logout = async () => {
    try {
      await api('/logout', 'POST'); clearLocal(); pendingRef.current = []; setPending([]);
      setLocalConversations([]); queryClient.clear(); navigate(null, true); setDraft(''); setRevisionOf(undefined); loggedOut(); settings.current?.close();
    } catch (error) { setError(error instanceof Error ? error.message : '退出失败，请联网后重试。'); settings.current?.close(); }
  };
  const exportChat = (format: 'md' | 'txt' | 'html') => {
    if (!selected) return;
    const title = currentConversation?.title ?? 'EverChat';
    const messages = durableSnapshot.messages;
    const markdown = `# ${title}\n\n${messages.map((message) => {
      const role = message.role === 'user' ? '你' : 'EverChat';
      const model = message.role === 'assistant' && (message.modelName || message.model) ? `\n模型：${message.modelName || message.model}\n` : '';
      const reasoning = message.reasoning ? `\n### 思考过程\n\n${message.reasoning}\n` : '';
      const status = message.status === 'completed' ? '' : `\n状态：${message.status}${message.error ? `（${message.error}）` : ''}\n`;
      return `## ${role}${message.revisionOf ? ' · 新版本' : ''}${model}\n\n${message.content}${reasoning}${status}\n`;
    }).join('\n')}`;
    if (format === 'md') downloadFile(`EverChat-${selected}.md`, markdown, 'text/markdown;charset=utf-8');
    else if (format === 'txt') downloadFile(`EverChat-${selected}.txt`, markdown.replace(/^#{1,6} /gm, '').replace(/^\n### /gm, '\n'), 'text/plain;charset=utf-8');
    else {
      const body = messages.map((message) => `<article><h2>${escapeHtml(message.role === 'user' ? '你' : 'EverChat')}${message.revisionOf ? ' · 新版本' : ''}</h2>${message.role === 'assistant' && (message.modelName || message.model) ? `<p class="meta">模型：${escapeHtml(message.modelName || message.model || '')}</p>` : ''}<pre>${escapeHtml(message.content)}</pre>${message.reasoning ? `<details open><summary>思考过程</summary><pre>${escapeHtml(message.reasoning)}</pre></details>` : ''}${message.status !== 'completed' ? `<p class="error">状态：${escapeHtml(message.status)}${message.error ? `（${escapeHtml(message.error)}）` : ''}</p>` : ''}</article>`).join('');
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:54rem;margin:2rem auto;padding:0 1rem;color:#1f2937}article{border-top:1px solid #d1d5db;padding:1.5rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.meta{color:#6b7280;font-size:.875rem}.error{color:#b91c1c}summary{cursor:pointer}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
      downloadFile(`EverChat-${selected}.html`, html, 'text/html;charset=utf-8');
    }
  };
  const exportBackup = async () => {
    if (!selected) return;
    try {
      const backup = await api<EverChatBackup>(`/conversations/${selected}/backup`);
      downloadFile(`EverChat-${selected}.everchat.json`, JSON.stringify(backup, null, 2), 'application/json;charset=utf-8');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '备份失败，请稍后重试。'); }
  };
  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setError('');
    try {
      const result = await api<{ id: string }>('/backup/restore', 'POST', JSON.parse(await file.text()));
      refreshLibrary(); select(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '恢复备份失败，请检查文件。'); }
  };
  const updateConversation = async (patch: { title?: string; pinned?: boolean; archived?: boolean }) => {
    if (!selected) return;
    const result = await api<ConversationInfo>(`/conversations/${selected}`, 'PATCH', patch);
    queryClient.setQueryData<ConversationInfo[]>(['conversations'], (items) => items?.map((item) => item.id === result.id ? result : item));
    refreshLibrary();
  };
  const deleteConversation = async () => {
    if (!selected) return;
    const id = selected, result = await api<{ deletedAt: number }>(`/conversations/${id}`, 'DELETE');
    rememberDeletion(id, result.deletedAt);
    if (selectedRef.current === id) select(null);
    refreshLibrary();
  };

  if (!session) return <main className="flex min-h-dvh flex-col items-center justify-center gap-6"><Brand />{bootError ? <><p className="max-w-sm px-5 text-center text-sm font-medium text-base-content" role="alert">{bootError}</p><button className="btn" onClick={boot}>重新连接</button></> : <span className="loading loading-dots loading-sm text-base-content/60" />}</main>;
  if (!session.authenticated) return <Login session={session} onLogin={async () => { await boot(); }} />;
  const statusText = connection === 'unavailable' ? '同步失败' : connection === 'offline' ? '离线' : connection === 'connecting' ? '连接中' : hasUnconfirmed ? '保存中' : '已同步';
  const welcome = !invalidRoute && !syncError && (!selected || (!snapshot.messages.length && !currentPending && !loading));
  return <div className="flex h-dvh overflow-hidden">
    {sidebarOpen && <button aria-label="关闭对话列表" className="fixed inset-0 z-30 bg-neutral/20 backdrop-blur-sm lg:hidden" onClick={closeSidebar} />}
    <aside className={`${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-0 left-0 z-40 flex w-70 shrink-0 flex-col border-r border-base-content/50 bg-base-200 transition-transform lg:static lg:translate-x-0`}>
      <div className="flex items-center justify-between px-6 pt-7 pb-8"><Brand small /><button className="btn btn-ghost btn-sm btn-square lg:hidden" aria-label="收起侧栏" onClick={closeSidebar}><X size={18} /></button></div>
      <div className="px-4"><button className="btn h-11 w-full justify-between border-base-content/50 bg-base-100 px-4 text-sm font-medium" onClick={() => select(null)}><span className="flex items-center gap-2.5"><Plus size={17} />开启新对话</span><span><MessageCircle size={15} /></span></button></div>
      <label className="input mx-4 mt-5 h-9 w-auto gap-2 border-base-content/50 bg-base-100"><Search size={14} /><input className="text-xs placeholder:text-base-content/60" placeholder="搜索你的对话" aria-label="搜索对话" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="flex-1 overflow-y-auto px-3 pt-6">
        <div role="tablist" className="tabs tabs-border tabs-sm mb-3"><input type="radio" role="tab" name="conversation-list" className="tab" aria-label="对话" aria-selected={!archivedList} checked={!archivedList} onChange={() => setArchivedList(false)} /><input type="radio" role="tab" name="conversation-list" className="tab" aria-label="归档" aria-selected={archivedList} checked={archivedList} onChange={() => setArchivedList(true)} /></div>
        <ul className="menu w-full gap-1 p-0 text-sm">
          {visibleConversations.map((item) => <li key={item.id}><a href={conversationUrl(item.id)} onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); select(item.id);
          }} aria-current={item.id === selected ? 'page' : undefined} className={`${item.id === selected ? 'menu-active bg-primary! text-primary-content! hover:bg-primary!' : ''} h-11 min-w-0 gap-3 rounded-lg px-3 font-normal`}><MessageCircle size={15} className="shrink-0" /><span className="truncate">{item.title}</span>{item.pinned && <Pin size={12} aria-hidden="true" className="shrink-0" />}{pending.some((p) => p.conversation.id === item.id) && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}</a></li>)}
        </ul>
        {!visibleConversations.length && <p className="px-3 text-xs text-base-content/60">{search ? '没有找到相关对话' : archivedList ? '暂无归档' : '暂无对话'}</p>}
        {search.trim() && <LibrarySearch query={search} archived={archivedList} open={openSearchResult} />}
      </div>
      <button className="mx-3 mb-4 flex items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-base-300" onClick={openSettings}><span className="flex h-8 w-8 items-center justify-center rounded-full border border-base-content/50 bg-base-100 text-xs">我</span><span className="flex-1"><span className="block text-xs font-medium">私人空间</span></span><Settings size={16} /></button>
    </aside>

    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-18 shrink-0 items-center justify-between border-b border-base-content/50 px-5 sm:px-8">
        <div className="flex min-w-0 items-center gap-3"><button ref={mobileSidebarTrigger} className="btn btn-ghost btn-sm btn-square lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="打开对话列表"><Menu size={19} /></button><div className="min-w-0"><p className="truncate text-sm font-medium">{invalidRoute ? '页面不可用' : currentConversation?.title ?? (selected ? '对话' : '新对话')}</p><p className="mt-1 text-[10px] text-base-content/60">{selectedModel?.name || session.modelName || session.model || '未选择模型'}</p></div></div>
        <div className="flex shrink-0 items-center gap-3"><span aria-live="polite" className="hidden items-center gap-1.5 text-[11px] text-base-content/60 sm:flex" title={syncedAt ? `上次同步 ${new Date(syncedAt).toLocaleTimeString('zh-CN')}` : undefined}>{connection === 'offline' ? <CloudOff size={14} /> : <span className={`status status-xs ${connection === 'connected' && !hasUnconfirmed ? 'status-success' : 'status-warning'}`} />}{statusText}</span>{canSearch && <button ref={searchTrigger} type="button" aria-label="搜索当前对话" aria-expanded={searchOpen} aria-controls={searchOpen ? 'conversation-search' : undefined} title="搜索当前对话（Ctrl / ⌘ F）" className="btn btn-ghost btn-sm btn-square" onClick={() => searchOpen ? closeConversationSearch() : setConversationSearchFor(selected)}><Search size={16} /></button>}{currentConversation && <ConversationActions key={currentConversation.id} conversation={currentConversation} disabled={connection === 'offline'} update={updateConversation} remove={deleteConversation} />}<div className="dropdown dropdown-end"><button type="button" aria-label="对话文件操作" title="导出或导入对话" className="btn btn-ghost btn-sm btn-square"><Download size={16} /></button><ul tabIndex={0} className="dropdown-content menu z-50 mt-2 w-48 rounded-box border border-base-content/20 bg-base-100 p-2 shadow"><li className="menu-title">导出对话</li><li><button type="button" disabled={!snapshot.messages.length} onClick={() => exportChat('md')}>Markdown</button></li><li><button type="button" disabled={!snapshot.messages.length} onClick={() => exportChat('txt')}>纯文本</button></li><li><button type="button" disabled={!snapshot.messages.length} onClick={() => exportChat('html')}>HTML</button></li><li><button type="button" disabled={!currentConversation || !snapshot.messages.length} onClick={() => void exportBackup()}>下载备份</button></li><li className="menu-title mt-1">恢复</li><li><button type="button" onClick={() => backupInput.current?.click()}>导入备份</button></li></ul></div><input ref={backupInput} type="file" accept=".json,application/json" className="hidden" onChange={(event) => void importBackup(event)} /><button aria-label="空间设置" className="btn btn-ghost btn-sm btn-square" onClick={openSettings}><Settings size={17} /></button></div>
      </header>
      {searchOpen && <ConversationSearch key={`${selected}:${searchJump?.token ?? ''}`} content={content} viewport={viewport} close={closeConversationSearch} initial={searchJump ?? undefined} />}
      {connection === 'offline' && <div role="status" className="flex items-center justify-center gap-2 border-b border-base-content/50 bg-base-200 px-4 py-2 text-xs text-base-content"><WifiOff size={13} />你现在离线，已保存的对话仍可阅读。新消息将在联网后发送。</div>}
      <div ref={viewportRef} className="relative flex-1 overflow-y-auto">
        {welcome ? <section ref={contentRef} className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-6 pt-8 pb-12 sm:px-10">
          <h1 className="text-[32px] leading-[1.45] font-semibold tracking-tight sm:text-[42px]">新对话</h1>
          <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {starters.map(({ icon: Icon, title, prompt }) => <button key={title} className="group rounded-lg border border-base-content/50 bg-base-100 p-4 text-left transition hover:-translate-y-0.5 hover:bg-base-200" onClick={() => { updateDraft(prompt); editor.current?.focus(); }}><Icon size={18} strokeWidth={1.5} className="mb-5" /><span className="flex items-center justify-between text-[13px] font-medium">{title}<ArrowUp size={13} className="rotate-45" /></span></button>)}
          </div>
        </section> : <section ref={contentRef} aria-label="对话消息" className="mx-auto w-full max-w-3xl space-y-8 px-5 py-8 sm:px-9 sm:py-10">
          {loading && !snapshot.messages.length && <div className="py-10 text-center text-xs text-base-content/60"><span className="loading loading-dots loading-sm" /><p className="mt-3">正在找回我们的对话…</p></div>}
          {snapshot.messages.map((message) => <MessageView key={message.id} message={message} busy={busy} onRetry={() => void retry(message)} onEdit={() => edit(message)} />)}
          {currentPending && <article className="ml-auto max-w-[90%] rounded-2xl border border-dashed border-base-content/50 bg-base-200 px-5 py-4"><p className="text-sm leading-7 whitespace-pre-wrap">{currentPending.input.content ?? '新版本'}</p><div className="mt-2 flex items-center gap-2 text-[11px] text-base-content/60"><CloudOff size={12} />{currentPending.error ? '发送失败' : '等待发送'}</div>{currentPending.error && <p className="mt-2 text-xs font-medium leading-5 text-base-content">{currentPending.error}</p>}<div className="mt-2 flex gap-1"><button className="btn btn-ghost btn-xs" onClick={() => { const clean = { ...currentPending, error: undefined }; commitPending(pendingRef.current.map((item) => item.input.requestId === clean.input.requestId ? clean : item)); void deliver(clean); }}>重试</button><button className="btn btn-ghost btn-xs" onClick={() => { if (currentPending.input.content) updateDraft(currentPending.input.content); commitPending(pendingRef.current.filter((item) => item.input.requestId !== currentPending.input.requestId)); }}>编辑</button></div></article>}
        </section>}
      </div>

      <div className="relative shrink-0 px-4 pt-2 pb-3 sm:px-8 sm:pb-5" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        {!atBottom && <button className="btn btn-circle btn-sm absolute -top-12 left-1/2 z-10 border-base-content/50 bg-base-100 shadow-sm" aria-label="滚动到最新消息" onClick={scrollToBottom}><ArrowDown size={16} /></button>}
        <div className="mx-auto w-full max-w-3xl">
          {invalidRoute && <div role="alert" className="alert alert-error mb-3 text-xs"><span>找不到这个页面。</span><button type="button" className="btn btn-sm" onClick={() => select(null)}>开启新对话</button></div>}
          {syncError && <div role="alert" className="alert alert-error mb-3 text-xs"><span>{syncError}</span><button type="button" className="btn btn-sm" onClick={reconnect}>重新同步</button></div>}
          {error && <p role="alert" className="mb-3 text-xs font-medium text-base-content">{error}</p>}
          {revisionOf && <div className="mb-2 flex items-center justify-between text-xs text-base-content/60"><span>编辑消息</span><button className="btn btn-ghost btn-xs" onClick={() => { setRevisionOf(undefined); write(`draft:${selected}`, { text: draft }); }}>取消</button></div>}
          <form onSubmit={submit} className="rounded-2xl border border-base-content/50 bg-base-100 p-3 shadow-[0_3px_16px_-7px_rgba(39,55,47,0.12)] sm:p-4">
            <textarea ref={editor} disabled={Boolean(snapshot.deletedAt)} aria-label="消息" className="textarea textarea-ghost block min-h-13 w-full resize-none border-0 p-1 text-[15px] leading-6 placeholder:text-base-content/60 outline-none! focus:outline-none!" placeholder={active ? '生成中…' : '输入消息…'} value={draft} maxLength={16000} rows={2} onChange={(event) => updateDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><div className="flex min-w-0 flex-wrap items-center gap-2 text-base-content"><Sparkles size={14} strokeWidth={1.5} className="shrink-0" />{selectedModel ? <select aria-label="聊天模型" className="select select-ghost select-sm min-w-0 max-w-48 border-base-content/50 text-xs sm:max-w-80" value={modelSelectionKey(selectedModel)} onChange={(event) => { setModelChoice(event.target.value); write('chat-model', event.target.value); }}>
              {[...new Set(models.map((model) => model.providerId))].map((providerId) => <optgroup key={providerId} label={models.find((model) => model.providerId === providerId)!.providerName}>
                {models.filter((model) => model.providerId === providerId).map((model) => <option key={model.model} value={modelSelectionKey(model)}>{model.name}</option>)}
              </optgroup>)}
            </select> : <button type="button" className="btn btn-ghost btn-xs" onClick={openSettings}>配置模型</button>}
            {selectedModel?.reasoningSupported && <select aria-label="思维强度" className="select select-ghost select-sm w-auto max-w-32 border-base-content/50 text-xs" value={reasoningEffort} onChange={(event) => { const value = event.target.value as ReasoningEffort | ''; setReasoningEffort(value); write(`reasoning-effort:${modelSelectionKey(selectedModel)}`, value); }}>
              <option value="">思维强度：默认</option>{selectedModel.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{effortLabels[effort]}</option>)}
            </select>}
            </div>{active ? <button type="button" className="btn btn-sm h-9 shrink-0 gap-2 px-3" onClick={cancel} disabled={!navigator.onLine}><Square size={12} />停止生成</button> : <button type="submit" className="btn btn-primary btn-square btn-sm h-9 w-9 shrink-0 rounded-xl" aria-label="发送消息" disabled={!draft.trim() || busy || !selectedModel}>{sending ? <span className="loading loading-spinner loading-xs" /> : <ArrowUp size={18} />}</button>}</div>
          </form>
        </div>
      </div>
    </div>
    <dialog id="space-settings" ref={settings} className="modal" onClose={() => setSettingsOpen(false)} aria-labelledby="space-settings-title">
      <div className="modal-box flex h-[min(48rem,92dvh)] max-h-[92dvh] max-w-5xl flex-col overflow-hidden p-0">
        <div className="flex shrink-0 items-center justify-between border-b border-base-content/30 px-6 py-4"><h2 id="space-settings-title" className="text-lg font-semibold">设置</h2><form method="dialog"><button className="btn btn-ghost btn-sm btn-square" aria-label="关闭设置"><X size={18} /></button></form></div>
        <ProviderSettingsPanel open={settingsOpen} onSaved={providerSaved} themeControl={<ThemeControl />} onLogout={() => void logout()} />
      </div>
      <form method="dialog" className="modal-backdrop"><button>关闭</button></form>
    </dialog>
  </div>;
}
