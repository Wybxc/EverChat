import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, ArrowUp, Check, CheckCheck, CloudOff, Copy, Download, Feather, Infinity as InfinityIcon, Lightbulb, LockKeyhole, LogOut, Menu, MessageCircle, Moon, Pencil, Plus, RefreshCw, Search, Settings, Sparkles, Square, Sun, WifiOff, X } from 'lucide-react';
import 'streamdown/styles.css';
import { isActive, type ConversationInfo, type Message, type SessionInfo, type Submission, type SubmitInput } from '../shared/types';
import { api, ApiError } from './api';
import { clearLocal, read, write, writePending, type Pending } from './storage';
import { useConversation } from './useConversation';

const EMPTY_SESSION: SessionInfo = { authenticated: false, configured: false, provider: 'demo', model: '演示模型' };
const Streamdown = lazy(() => import('streamdown').then(({ Streamdown: Component }) => ({ default: Component })));
const starters = [
  { icon: Lightbulb, title: '梳理想法', prompt: '帮我梳理一个新项目的想法。请先问我三个能让方向更清晰的问题。' },
  { icon: Feather, title: '写一段文字', prompt: '我想写一个关于重逢的短篇故事，帮我构思一个有画面感的开头。' },
  { icon: Search, title: '解释概念', prompt: '用简单的语言和生活中的例子，向我解释什么是 Serverless。' },
];

function Brand({ small = false }: { small?: boolean }) {
  return <div className="flex items-center gap-3"><span className={`${small ? 'h-9 w-9' : 'h-11 w-11'} inline-flex shrink-0 items-center justify-center rounded-lg bg-neutral text-neutral-content`}><InfinityIcon size={small ? 24 : 29} strokeWidth={1.7} /></span><span className="text-xl font-semibold">EverChat</span></div>;
}

function ThemeControl() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const choose = (value: 'light' | 'dark') => {
    document.documentElement.dataset.theme = value;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#1d232a' : '#ffffff');
    try { localStorage.setItem('everchat:theme', value); } catch { /* Theme still applies for this session. */ }
    setTheme(value);
  };
  return <fieldset className="space-y-2"><legend className="text-sm font-medium">主题</legend><div className="join">
    <label className={`join-item btn btn-sm gap-2 ${theme === 'light' ? 'btn-active' : ''}`}><input type="radio" name="theme" value="light" className="theme-controller sr-only" checked={theme === 'light'} onChange={() => choose('light')} /><Sun size={14} />浅色</label>
    <label className={`join-item btn btn-sm gap-2 ${theme === 'dark' ? 'btn-active' : ''}`}><input type="radio" name="theme" value="dark" className="theme-controller sr-only" checked={theme === 'dark'} onChange={() => choose('dark')} /><Moon size={14} />深色</label>
  </div></fieldset>;
}

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
      {local && session.provider === 'demo' && <p className="mt-4 text-xs text-base-content/60">本地密码：<code>everchat-local</code></p>}
    </section>
    <footer className="pb-6 text-center text-[11px] text-base-content/60">EverChat</footer>
  </main>;
}

function MessageView({ message, busy, onRetry, onEdit }: { message: Message; busy: boolean; onRetry: () => void; onEdit: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(message.content); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* Clipboard can be unavailable outside HTTPS. */ }
  };
  if (message.role === 'user') return <article data-testid="user-message" className="group ml-auto w-fit max-w-[90%] sm:max-w-[82%]">
    <div className="rounded-2xl rounded-br-md border border-base-content/50 bg-base-200 px-5 py-3.5 text-[15px] leading-7 whitespace-pre-wrap break-words">{message.content}</div>
    <div className="mt-1.5 flex items-center justify-end gap-2 text-[11px] text-base-content/60">
      {message.revisionOf && <span>新版本</span>}
      <CheckCheck size={13} /><span>已保存</span>
      <button className="btn btn-ghost btn-xs btn-square sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100" aria-label="编辑为新版本" title="编辑为新版本" disabled={busy} onClick={onEdit}><Pencil size={12} /></button>
    </div>
  </article>;
  return <article data-testid="assistant-message" data-status={message.status} className="group flex gap-3 sm:gap-4">
    <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-base-content/50 bg-base-100"><InfinityIcon size={20} strokeWidth={1.7} /></span>
    <div className="min-w-0 flex-1 pt-1">
      <div className="mb-3 flex items-center gap-3 text-xs"><span className="font-semibold">EverChat</span>{message.revisionOf && <span className="text-base-content/60">新版本</span>}{isActive(message) && <span className="flex items-center gap-1.5 text-base-content/60"><span className="loading loading-dots loading-xs" />{message.status === 'queued' ? '排队中' : '生成中'}</span>}</div>
      {message.content ? <Suspense fallback={<div className="markdown whitespace-pre-wrap">{message.content}</div>}><Streamdown className="markdown" mode={isActive(message) ? 'streaming' : 'static'} isAnimating={isActive(message)} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span className="text-base-content/60">[图片：{alt ?? '附件'}]</span> }}>{message.content}</Streamdown></Suspense> : isActive(message) ? <p className="py-2 text-sm text-base-content/60">准备中…</p> : null}
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
  const [selected, setSelected] = useState<string | null>(() => read('selected', null));
  const [pending, setPending] = useState<Pending[]>(() => read('pending', []));
  const pendingRef = useRef(pending);
  const deliveryLocks = useRef(new Set<string>());
  const [draft, setDraft] = useState('');
  const [revisionOf, setRevisionOf] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scrollArea = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const editor = useRef<HTMLTextAreaElement>(null);
  const settings = useRef<HTMLDialogElement>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const loggedOut = useCallback(() => { setSession((current) => ({ ...(current ?? EMPTY_SESSION), authenticated: false })); }, []);
  const { snapshot, connection, syncedAt, loading } = useConversation(selected, Boolean(session?.authenticated), loggedOut);
  const active = snapshot.messages.find(isActive);
  const currentPending = pending.find((item) => item.conversation.id === selected);
  const libraryQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api<ConversationInfo[]>('/conversations'),
    enabled: Boolean(session?.authenticated),
    initialData: () => read('library', []),
    refetchInterval: 10_000,
  });
  const conversations = useMemo(() => {
    const cloud = libraryQuery.data ?? [];
    const cloudIds = new Set(cloud.map((item) => item.id));
    const queued = pending.map((item) => item.conversation).filter((item) => !cloudIds.has(item.id));
    const local = localConversations.filter((item) => !cloudIds.has(item.id) && !queued.some((next) => next.id === item.id));
    return [...queued, ...local, ...cloud];
  }, [libraryQuery.data, localConversations, pending]);
  const busy = Boolean(active || currentPending || sending);
  const currentConversation = conversations.find((item) => item.id === selected);

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
  useEffect(() => { void boot(); }, [boot]);
  useEffect(() => {
    if (libraryQuery.error instanceof ApiError && libraryQuery.error.status === 401) loggedOut();
    if (libraryQuery.data) { setLocalConversations(libraryQuery.data); write('library', libraryQuery.data); }
  }, [libraryQuery.data, libraryQuery.error, loggedOut]);
  const refreshLibrary = useCallback(() => { void queryClient.invalidateQueries({ queryKey: ['conversations'] }); }, [queryClient]);

  const commitPending = (items: Pending[]) => {
    if (!writePending(items)) { setError('浏览器存储已满，无法可靠保存待发送消息。请释放空间后重试。'); return false; }
    pendingRef.current = items; setPending(items); return true;
  };
  const deliver = async (item: Pending) => {
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
    const saved = read<{ text: string; revisionOf?: string }>(`draft:${selected ?? 'new'}`, { text: '' });
    setDraft(saved.text); setRevisionOf(saved.revisionOf); setError('');
    nearBottom.current = true; setAtBottom(true);
  }, [selected]);
  useEffect(() => {
    const node = editor.current;
    if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 160)}px`; }
  }, [draft]);
  useEffect(() => {
    if (nearBottom.current && scrollArea.current) scrollArea.current.scrollTop = scrollArea.current.scrollHeight;
  }, [snapshot.seq, pending.length, selected]);
  const updateDraft = (text: string) => { setDraft(text); write(`draft:${selected ?? 'new'}`, { text, revisionOf }); };
  const select = (id: string | null) => { setSelected(id); write('selected', id); setSidebarOpen(false); };

  const queue = async (input: SubmitInput) => {
    const conversation: ConversationInfo = currentConversation ?? {
      id: selected ?? crypto.randomUUID(), title: (input.content ?? '新对话').trim().slice(0, 26), createdAt: Date.now(), updatedAt: Date.now(),
    };
    const item: Pending = { conversation, input };
    if (!commitPending([...pendingRef.current, item])) return;
    if (!conversations.some((item) => item.id === conversation.id)) {
      const items = [conversation, ...localConversations]; setLocalConversations(items); write('library', items);
    }
    write(`draft:${selected ?? 'new'}`, { text: '' }); setDraft(''); setRevisionOf(undefined);
    select(conversation.id);
    nearBottom.current = true;
    await deliver(item);
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft.trim() || busy) return;
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
    if (busy) return;
    setSending(true);
    try { await queue({ requestId: crypto.randomUUID(), retryOf: message.id }); }
    finally { setSending(false); }
  };
  const edit = (message: Message) => {
    setRevisionOf(message.id); setDraft(message.content);
    write(`draft:${selected}`, { text: message.content, revisionOf: message.id }); editor.current?.focus();
  };
  const logout = async () => {
    try {
      await api('/logout', 'POST'); clearLocal(); pendingRef.current = []; setPending([]);
      setLocalConversations([]); void queryClient.removeQueries({ queryKey: ['conversations'] }); setSelected(null); setDraft(''); setRevisionOf(undefined); loggedOut(); settings.current?.close();
    } catch (error) { setError(error instanceof Error ? error.message : '退出失败，请联网后重试。'); settings.current?.close(); }
  };
  const exportChat = () => {
    const text = `# ${currentConversation?.title ?? 'EverChat'}\n\n` + snapshot.messages.map((message) => `## ${message.role === 'user' ? '你' : 'EverChat'}${message.revisionOf ? ' · 新版本' : ''}\n\n${message.content}\n\n${message.error ? `> ${message.error}\n\n` : ''}`).join('');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `EverChat-${selected}.md`; link.click(); URL.revokeObjectURL(url);
  };

  if (!session) return <main className="flex min-h-dvh flex-col items-center justify-center gap-6"><Brand />{bootError ? <><p className="max-w-sm px-5 text-center text-sm font-medium text-base-content" role="alert">{bootError}</p><button className="btn" onClick={boot}>重新连接</button></> : <span className="loading loading-dots loading-sm text-base-content/60" />}</main>;
  if (!session.authenticated) return <Login session={session} onLogin={async () => { await boot(); }} />;
  const statusText = connection === 'offline' ? '离线' : connection === 'connecting' ? '连接中' : '已同步';
  const welcome = !selected || (!snapshot.messages.length && !currentPending && !loading);
  return <div className="flex h-dvh overflow-hidden">
    {sidebarOpen && <button aria-label="关闭对话列表" className="fixed inset-0 z-30 bg-neutral/20 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />}
    <aside className={`${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-0 left-0 z-40 flex w-70 shrink-0 flex-col border-r border-base-content/50 bg-base-200 transition-transform lg:static lg:translate-x-0`}>
      <div className="flex items-center justify-between px-6 pt-7 pb-8"><Brand small /><button className="btn btn-ghost btn-sm btn-square lg:hidden" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
      <div className="px-4"><button className="btn h-11 w-full justify-between border-base-content/50 bg-base-100 px-4 text-sm font-medium" onClick={() => select(null)}><span className="flex items-center gap-2.5"><Plus size={17} />开启新对话</span><span><MessageCircle size={15} /></span></button></div>
      <label className="input mx-4 mt-5 h-9 w-auto gap-2 border-base-content/50 bg-base-100"><Search size={14} /><input className="text-xs placeholder:text-base-content/60" placeholder="搜索你的对话" aria-label="搜索对话" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="flex-1 overflow-y-auto px-3 pt-6">
        <p className="px-3 pb-3 text-[10px] font-medium tracking-wider text-base-content/60">对话 <span className="ml-1">{conversations.length ? String(conversations.length).padStart(2, '0') : ''}</span></p>
        <ul className="menu w-full gap-1 p-0 text-sm">
          {conversations.filter((item) => item.title.toLowerCase().includes(search.toLowerCase())).map((item) => <li key={item.id}><button onClick={() => select(item.id)} aria-current={item.id === selected ? 'page' : undefined} className={`${item.id === selected ? 'menu-active bg-primary! text-primary-content! hover:bg-primary!' : ''} h-11 min-w-0 gap-3 rounded-lg px-3 font-normal`}><MessageCircle size={15} className="shrink-0" /><span className="truncate">{item.title}</span>{pending.some((p) => p.conversation.id === item.id) && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}</button></li>)}
        </ul>
        {!conversations.length && <p className="px-3 text-xs leading-6 text-base-content/60">暂无对话</p>}
        {search && !conversations.some((item) => item.title.toLowerCase().includes(search.toLowerCase())) && <p className="px-3 text-xs text-base-content/60">没有找到相关对话</p>}
      </div>
      <button className="mx-3 mb-4 flex items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-base-300" onClick={() => settings.current?.showModal()}><span className="flex h-8 w-8 items-center justify-center rounded-full border border-base-content/50 bg-base-100 text-xs">我</span><span className="flex-1"><span className="block text-xs font-medium">私人空间</span></span><Settings size={16} /></button>
    </aside>

    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-18 shrink-0 items-center justify-between border-b border-base-content/50 px-5 sm:px-8">
        <div className="flex min-w-0 items-center gap-3"><button className="btn btn-ghost btn-sm btn-square lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="打开对话列表"><Menu size={19} /></button><div className="min-w-0"><p className="truncate text-sm font-medium">{currentConversation?.title ?? '新对话'}</p><p className="mt-1 text-[10px] text-base-content/60">{session.model}</p></div></div>
        <div className="flex shrink-0 items-center gap-3"><span aria-live="polite" className="hidden items-center gap-1.5 text-[11px] text-base-content/60 sm:flex" title={syncedAt ? `上次同步 ${new Date(syncedAt).toLocaleTimeString('zh-CN')}` : undefined}>{connection === 'offline' ? <CloudOff size={14} /> : <span className={`h-1.5 w-1.5 rounded-full ${connection === 'connected' ? 'bg-success' : 'bg-warning'}`} />}{statusText}</span>{snapshot.messages.length > 0 && <button aria-label="导出对话" title="导出 Markdown" className="btn btn-ghost btn-sm btn-square" onClick={exportChat}><Download size={16} /></button>}<button aria-label="空间设置" className="btn btn-ghost btn-sm btn-square" onClick={() => settings.current?.showModal()}><Settings size={17} /></button></div>
      </header>
      {connection === 'offline' && <div role="status" className="flex items-center justify-center gap-2 border-b border-base-content/50 bg-base-200 px-4 py-2 text-xs text-base-content"><WifiOff size={13} />你现在离线，已保存的对话仍可阅读。新消息将在联网后发送。</div>}
      <div ref={scrollArea} className="relative flex-1 overflow-y-auto" onScroll={(event) => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; setAtBottom(nearBottom.current); }}>
        {welcome ? <section className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-6 pt-8 pb-12 sm:px-10">
          <h1 className="text-[32px] leading-[1.45] font-semibold tracking-tight sm:text-[42px]">新对话</h1>
          <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {starters.map(({ icon: Icon, title, prompt }) => <button key={title} className="group rounded-lg border border-base-content/50 bg-base-100 p-4 text-left transition hover:-translate-y-0.5 hover:bg-base-200" onClick={() => { updateDraft(prompt); editor.current?.focus(); }}><Icon size={18} strokeWidth={1.5} className="mb-5" /><span className="flex items-center justify-between text-[13px] font-medium">{title}<ArrowUp size={13} className="rotate-45" /></span></button>)}
          </div>
        </section> : <section aria-label="对话消息" className="mx-auto w-full max-w-3xl space-y-8 px-5 py-8 sm:px-9 sm:py-10">
          {loading && !snapshot.messages.length && <div className="py-10 text-center text-xs text-base-content/60"><span className="loading loading-dots loading-sm" /><p className="mt-3">正在找回我们的对话…</p></div>}
          {snapshot.messages.map((message) => <MessageView key={message.id} message={message} busy={busy} onRetry={() => void retry(message)} onEdit={() => edit(message)} />)}
          {currentPending && <article className="ml-auto max-w-[90%] rounded-2xl border border-dashed border-base-content/50 bg-base-200 px-5 py-4"><p className="text-sm leading-7 whitespace-pre-wrap">{currentPending.input.content ?? '新版本'}</p><div className="mt-2 flex items-center gap-2 text-[11px] text-base-content/60"><CloudOff size={12} />{currentPending.error ? '发送失败' : '等待发送'}</div>{currentPending.error && <p className="mt-2 text-xs font-medium leading-5 text-base-content">{currentPending.error}</p>}<div className="mt-2 flex gap-1"><button className="btn btn-ghost btn-xs" onClick={() => { const clean = { ...currentPending, error: undefined }; commitPending(pendingRef.current.map((item) => item.input.requestId === clean.input.requestId ? clean : item)); void deliver(clean); }}>重试</button><button className="btn btn-ghost btn-xs" onClick={() => { if (currentPending.input.content) updateDraft(currentPending.input.content); commitPending(pendingRef.current.filter((item) => item.input.requestId !== currentPending.input.requestId)); }}>编辑</button></div></article>}
        </section>}
      </div>

      <div className="relative shrink-0 px-4 pt-2 pb-3 sm:px-8 sm:pb-5" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        {!atBottom && <button className="btn btn-circle btn-sm absolute -top-12 left-1/2 z-10 border-base-content/50 bg-base-100 shadow-sm" aria-label="滚动到最新消息" onClick={() => { scrollArea.current?.scrollTo({ top: scrollArea.current.scrollHeight, behavior: 'smooth' }); nearBottom.current = true; }}><ArrowDown size={16} /></button>}
        <div className="mx-auto w-full max-w-3xl">
          {error && <p role="alert" className="mb-3 text-xs font-medium text-base-content">{error}</p>}
          {revisionOf && <div className="mb-2 flex items-center justify-between text-xs text-base-content/60"><span>编辑消息</span><button className="btn btn-ghost btn-xs" onClick={() => { setRevisionOf(undefined); write(`draft:${selected}`, { text: draft }); }}>取消</button></div>}
          <form onSubmit={submit} className="rounded-2xl border border-base-content/50 bg-base-100 p-3 shadow-[0_3px_16px_-7px_rgba(39,55,47,0.12)] sm:p-4">
            <textarea ref={editor} aria-label="消息" className="textarea textarea-ghost block min-h-13 w-full resize-none border-0 p-1 text-[15px] leading-6 placeholder:text-base-content/60 outline-none! focus:outline-none!" placeholder={active ? '生成中…' : '输入消息…'} value={draft} maxLength={16000} rows={2} onChange={(event) => updateDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
            <div className="mt-2 flex items-center justify-between"><div className="flex items-center gap-2 text-[11px] text-base-content/60"><Sparkles size={14} strokeWidth={1.5} /><span>{session.model}</span>{session.provider === 'demo' && <span className="badge badge-sm border-base-content/50 bg-base-200 text-[9px] text-base-content/60">演示</span>}</div>{active ? <button type="button" className="btn btn-sm h-9 gap-2 px-3" onClick={cancel} disabled={!navigator.onLine}><Square size={12} />停止生成</button> : <button type="submit" className="btn btn-primary btn-square btn-sm h-9 w-9 rounded-xl" aria-label="发送消息" disabled={!draft.trim() || busy}>{sending ? <span className="loading loading-spinner loading-xs" /> : <ArrowUp size={18} />}</button>}</div>
          </form>
        </div>
      </div>
    </div>
    <dialog ref={settings} className="modal">
      <div className="modal-box max-w-md">
        <div className="mb-7 flex items-center justify-between"><h2 className="text-lg font-semibold">我的私人空间</h2><form method="dialog"><button className="btn btn-ghost btn-sm btn-square" aria-label="关闭设置"><X size={18} /></button></form></div>
        <div className="space-y-4 text-sm"><div className="flex justify-between"><span className="text-base-content/60">模型</span><span>{session.model}</span></div><div className="flex justify-between"><span className="text-base-content/60">状态</span><span>{statusText}</span></div><div className="flex justify-between"><span className="text-base-content/60">对话</span><span>{conversations.length}</span></div></div>
        <div className="mt-6"><ThemeControl /></div>
        <div className="modal-action"><button className="btn gap-2" onClick={logout}><LogOut size={15} />退出并清除本地记录</button></div>
      </div>
      <form method="dialog" className="modal-backdrop"><button>关闭</button></form>
    </dialog>
  </div>;
}
