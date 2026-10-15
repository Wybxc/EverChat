import { documentMediaTypeSchema, MAX_DOCUMENT_BYTES, MAX_MESSAGE_DOCUMENTS, type DocumentPart } from '../shared/documents';
import { fileMediaType } from '../shared/attachments';
import { DocumentPreviews } from './DocumentPreviews';
import { preparePdf } from './pdf-loader';
import type { PDFExtraction } from '../shared/pdf';
import { messageFiles, messageImages, messageText } from '../shared/message-content';
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode, type SubmitEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, Check, CheckCheck, CloudOff, Copy, Download, Feather, FolderOpen, Globe, ImagePlus, Infinity as InfinityIcon, Lightbulb, LockKeyhole, Menu, MessageCircle, Monitor, Moon, Paperclip, Pencil, Pin, Plus, Quote, RefreshCw, Search, Settings, SlidersHorizontal, Square, Sun, Trash2, WifiOff, X } from 'lucide-react';
import 'streamdown/styles.css';
import 'katex/dist/katex.min.css';
import type { PluginConfig } from 'streamdown';
import { isActive, type ConversationInfo, type ConversationSettings, type LibrarySnapshot, type Message, type ModelSelection, type ProviderSettings, type ReasoningEffort, type SessionInfo, type Submission, type SubmitInput } from '../shared/types';
import { api, ApiError } from './api';
import { clearLocal, deletedAt, markConversationDeleted, read, storageEpoch, write, writePending, type Pending } from './storage';
import { useConversation } from './useConversation';
import { ProviderSettingsPanel, type SettingsTab } from './ProviderSettings';
import { GenerationMetadata } from './GenerationMetadata';
import { ToolActivity } from './ToolActivity';
import { assertWebToolSupport } from '../shared/web-tools';
import { loadWebToolSettings, useWebToolSettings, WEB_TOOL_SETTINGS_KEY } from './web-tool-settings';
import { ContextEstimateView } from './ContextEstimate';
import { buildContext, contextSource } from '../shared/context-budget';
import { chatModels, effortLabels, modelSelectionKey } from '../shared/models';
import { useThemeMode } from './theme';
import { useFollowScroll } from './useFollowScroll';
import { useSidebar } from './useSidebar';
import { conversationUrl, useConversationRoute } from './useConversationRoute';
import { ConversationActions } from './ConversationActions';
import { ActionMenu } from './ActionMenu';
import { MessageActions } from './MessageActions';
import { ConversationSearch } from './ConversationSearch';
import { LibrarySearch } from './LibrarySearch';
import type { SearchResult } from '../shared/search';
import { createArchive, restoreArchive, type BackupProgress } from './archive-client';
import { BackupProgressDialog } from './BackupProgressDialog';
import { MessageMutationDialog } from './MessageMutationDialog';
import { ConversationSettingsDialog } from './ConversationSettings';
import { SummaryDialog } from './SummaryDialog';
import { AttachmentDialog } from './AttachmentDialog';
import { ImagePreviews } from './ImagePreviews';
import { prepareChatImage } from './chat-image';
import { prepareAttachment, uploadAttachment } from './attachment-upload';
import { MAX_MESSAGE_IMAGES, type ImagePart } from '../shared/images';
import { prepareChatContext, summaryContext, summaryGeneration, summaryPrefix } from '../shared/summaries';
import { applyConversationSettings, conversationSettingsSchema, DEFAULT_CONVERSATION_SETTINGS } from '../shared/conversation-settings';
import * as v from 'valibot';

const EMPTY_SESSION: SessionInfo = { authenticated: false, configured: false, attachmentsConfigured: false, provider: '', model: '' };
type MarkdownRenderer = typeof import('streamdown')['Streamdown'];
let markdownRenderer: MarkdownRenderer | null = null;
let markdownRendererPromise: Promise<MarkdownRenderer> | null = null;
function loadMarkdownRenderer() {
  if (markdownRenderer) return Promise.resolve(markdownRenderer);
  return markdownRendererPromise ??= import('streamdown').then(({ Streamdown }) => {
    markdownRenderer = Streamdown; return Streamdown;
  }).catch((error: unknown) => { markdownRendererPromise = null; throw error; });
}
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

// Streamdown also loads internal React.lazy chunks, whose rejection escapes the plugin loaders.
class MarkdownBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function MarkdownFallback({ content, className }: { content: string; className: string }) {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return <div data-testid="markdown-fallback">
    <div className={`${className} whitespace-pre-wrap`}>{content}</div>
    {/* React.lazy retains a rejected promise. A new page runtime is needed to retry that chunk. */}
    <button type="button" className="btn btn-ghost btn-xs mt-2" disabled={!online} onClick={() => location.reload()}>重新加载</button>
  </div>;
}

function MarkdownContent({ content, streaming, searchId, className = 'markdown' }: { content: string; streaming: boolean; searchId?: string; className?: string }) {
  const [Renderer, setRenderer] = useState<MarkdownRenderer | null>(() => markdownRenderer);
  const [plugins, setPlugins] = useState<PluginConfig | null>(null);
  const needsCode = /```(?!mermaid\b)/iu.test(content);
  const needsMath = /\$\$|\\\(|\\\[/u.test(content);
  const needsMermaid = /```mermaid(?:\s|$)/imu.test(content);
  useEffect(() => {
    let active = true;
    const load = () => { void loadMarkdownRenderer().then((renderer) => {
      if (active) setRenderer(() => renderer);
    }).catch(() => { /* Keep the text readable when the runtime is unavailable. */ }); };
    load(); window.addEventListener('online', load);
    return () => { active = false; window.removeEventListener('online', load); };
  }, []);
  useEffect(() => {
    let active = true;
    if (!needsCode && !needsMath && !needsMermaid) { setPlugins(null); return () => { active = false; }; }
    const load = () => { void Promise.all([
      needsCode ? markdownPluginLoaders.code() : Promise.resolve(null),
      needsMath ? markdownPluginLoaders.math() : Promise.resolve(null),
      needsMermaid ? markdownPluginLoaders.mermaid() : Promise.resolve(null),
    ]).then(([code, math, mermaid]) => {
      if (active) setPlugins({ ...(code ? { code } : {}), ...(math ? { math } : {}), ...(mermaid ? { mermaid } : {}) });
    }).catch(() => { if (active) setPlugins(null); }); };
    load(); window.addEventListener('online', load);
    return () => { active = false; window.removeEventListener('online', load); };
  }, [needsCode, needsMath, needsMermaid]);
  return <div data-search-content={searchId}><MarkdownBoundary fallback={<MarkdownFallback content={content} className={className} />}>{Renderer ?
    <Renderer className={className} mode={streaming ? 'streaming' : 'static'} isAnimating={streaming} components={{
      a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span className="text-base-content/60">[图片：{alt ?? '附件'}]</span>,
    }} plugins={plugins ?? undefined} controls={{ code: { copy: true, download: false }, mermaid: { fullscreen: true, download: false, copy: false, panZoom: true } }}>{content}</Renderer>
    : <div className={`${className} whitespace-pre-wrap`}>{content}</div>}</MarkdownBoundary></div>;
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
const downloadFile = (filename: string, content: BlobPart, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

function Login({ session, onLogin }: { session: SessionInfo; onLogin: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
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

function SummaryView({ message, busy, onRetry, onDelete, selected }: { message: Message; busy: boolean; onRetry: () => void; onDelete: () => void; selected: boolean }) {
  const [open, setOpen] = useState(isActive(message));
  const scroll = useFollowScroll(message.id);
  if (message.deletedAt) return <article data-testid="summary-message" data-message-id={message.id} className="text-xs text-base-content/70">摘要已删除或失效</article>;
  return <article data-testid="summary-message" data-message-id={message.id} data-status={message.status} className="space-y-2">
    <details className="collapse collapse-arrow bg-base-200" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="collapse-title min-h-0 py-3 text-sm">{message.summary!.automatic ? '自动历史摘要' : '历史摘要'} · 覆盖 {message.summary!.sourceIds.length} 条{isActive(message) ? ' · 生成中' : message.status === 'failed' ? ' · 生成失败' : message.status === 'cancelled' ? ' · 已停止' : selected ? ' · 当前分支使用' : ' · 未用于当前分支'}</summary>
      <div className="collapse-content"><div ref={scroll.viewportRef} className="max-h-[min(22rem,40dvh)] overflow-y-auto overscroll-contain"><div ref={scroll.contentRef}>{messageText(message) && <MarkdownContent content={messageText(message)} streaming={isActive(message)} />}</div></div>
        {message.error && <p role="alert" className="mt-3 text-sm">{message.error}</p>}
        {message.status === 'cancelled' && <p className="mt-3 text-sm">已停止，摘要未用于上下文。</p>}
        {!isActive(message) && <GenerationMetadata generation={message.generation} />}
      </div>
    </details>
    <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-ghost btn-xs" disabled={busy || !navigator.onLine} onClick={onRetry}>重新生成摘要</button>
      <button type="button" className="btn btn-ghost btn-xs" disabled={busy || !navigator.onLine} onClick={onDelete}>删除摘要</button>
    </div>
  </article>;
}

function MessageView({ conversationId, message, busy, onRetry, onEdit, onQuote, onDelete, canRetry, branchSelected, onSelectBranch, canFork, onFork, summarySelected }: { conversationId: string; message: Message; busy: boolean; onRetry: () => void; onEdit: () => void; onQuote: () => void; onDelete: () => void; canRetry: boolean; branchSelected: boolean; onSelectBranch: () => void; canFork: boolean; onFork: () => Promise<void>; summarySelected?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false), [forkError, setForkError] = useState('');
  const forkLock = useRef(false);
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const reasoningScroll = useFollowScroll(message.id);
  const copy = async () => {
    try { await navigator.clipboard.writeText(messageText(message)); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* Clipboard can be unavailable outside HTTPS. */ }
  };
  const fork = async () => {
    if (forkLock.current || !canFork) return;
    forkLock.current = true; setForking(true); setForkError('');
    try { await onFork(); }
    catch (failure) { setForkError(failure instanceof Error ? failure.message : '复制失败，请重试。'); }
    finally { forkLock.current = false; setForking(false); }
  };
  if (message.summary) return <SummaryView message={message} busy={busy} onRetry={onRetry} onDelete={onDelete} selected={Boolean(summarySelected)} />;
  if (message.deletedAt) return <article data-testid={`${message.role}-message`} data-message-id={message.id} data-deleted="true" className={`py-2 text-xs text-base-content/60 ${message.role === 'user' ? 'text-right' : ''}`}>消息已删除</article>;
  const actions = <MessageActions message={message} busy={busy} copied={copied} forking={forking} canFork={canFork} canRetry={canRetry} branchSelected={branchSelected}
    copy={() => void copy()} quote={onQuote} edit={onEdit} remove={onDelete} fork={() => void fork()} retry={onRetry} selectBranch={onSelectBranch} />;
  if (message.role === 'user') return <article data-testid="user-message" data-message-id={message.id} className="group ml-auto w-fit max-w-[90%] sm:max-w-[82%]">
    <DocumentPreviews conversationId={conversationId} files={messageFiles(message)} />
    <ImagePreviews conversationId={conversationId} images={messageImages(message)} />
    {messageText(message) && <div data-search-content={`${message.id}:content`} className="rounded-2xl rounded-br-md bg-base-200 px-5 py-3.5 text-[15px] leading-7 whitespace-pre-wrap break-words">{messageText(message)}</div>}
    {actions}
    {message.revisionOf && <p className="mt-1 text-right text-xs text-base-content/70">新版本</p>}
    {forkError && <p role="alert" className="mt-1 text-xs">{forkError}</p>}
  </article>;
  return <article data-testid="assistant-message" data-message-id={message.id} data-status={message.status} data-durable-offset={message.durableOffset ?? 0} data-live-offset={message.liveOffset ?? message.durableOffset ?? 0} className="group flex gap-3 sm:gap-4">
    <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-base-200"><InfinityIcon size={20} strokeWidth={1.7} /></span>
    <div className="min-w-0 flex-1 pt-1">
      <div className="mb-3 flex items-center gap-3 text-xs"><span className="font-semibold">{message.modelName || message.model || 'EverChat'}</span>{message.revisionOf && <span className="text-base-content/60">新版本</span>}{isActive(message) && <span className="flex items-center gap-1.5 text-base-content/60"><span className="loading loading-dots loading-xs" />{message.waitingForSummary ? '等待历史摘要' : message.status === 'queued' ? '排队中' : '生成中'}</span>}</div>
      {messageText(message, 'reasoning') && <details open={reasoningOpen} onToggle={(event) => setReasoningOpen(event.currentTarget.open)} className="collapse collapse-arrow mb-4 bg-base-200" data-testid="message-reasoning">
        <summary className="collapse-title min-h-0 py-3 text-sm font-medium">思考过程</summary>
        <div className="collapse-content text-sm"><div ref={reasoningScroll.viewportRef} className="max-h-[min(22rem,40dvh)] overflow-y-auto overscroll-contain break-words"><div ref={reasoningScroll.contentRef}><MarkdownContent content={messageText(message, 'reasoning')} searchId={`${message.id}:reasoning`} streaming={isActive(message)} /></div></div></div>
      </details>}
      <ToolActivity task={message.tools} />
      {messageText(message) ? <MarkdownContent content={messageText(message)} searchId={`${message.id}:content`} streaming={isActive(message)} /> : isActive(message) && !messageText(message, 'reasoning') && !message.tools ? <p className="py-2 text-sm text-base-content/60">{message.waitingForSummary ? '压缩历史后开始回答…' : '准备中…'}</p> : null}
      {message.status === 'failed' && <p role="alert" className="mt-4 rounded-lg bg-error/5 px-3 py-2 text-xs font-medium leading-6 text-base-content">{message.error ?? '生成失败，已保存部分内容。'}</p>}
      {message.status === 'cancelled' && <p className="mt-4 text-xs text-base-content/60">已停止</p>}
      {actions}
      {forkError && <p role="alert" className="mt-1 text-xs">{forkError}</p>}
    </div>
  </article>;
}

export function App() {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const webToolSettings = useWebToolSettings(Boolean(session?.authenticated));
  const [bootError, setBootError] = useState('');
  const [localConversations, setLocalConversations] = useState<ConversationInfo[]>(() => read('library', []));
  const { id: selected, invalid: invalidRoute, navigate } = useConversationRoute();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [pending, setPending] = useState<Pending[]>(() => read<Pending[]>('pending', []).filter((item) => !deletedAt(item.conversation.id)));
  const pendingRef = useRef(pending);
  const deliveryLocks = useRef(new Set<string>());
  const [draft, setDraft] = useState('');
  const [draftFiles, setDraftFiles] = useState<DocumentPart[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [draftImages, setDraftImages] = useState<ImagePart[]>([]);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageUpload = useRef<{ origin: string | null; controller: AbortController } | null>(null);
  const [imageProgress, setImageProgress] = useState<{ name: string; percent: number; kind: 'image' | 'file' } | null>(null);
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
  const backupOperation = useRef<AbortController | null>(null);
  const [backupTask, setBackupTask] = useState<{ title: string; progress: BackupProgress; route: string | null; epoch: number } | null>(null);
  useEffect(() => () => backupOperation.current?.abort(), []);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [editorFocusTarget, setEditorFocusTarget] = useState<{ id: string | null } | null>(null);
  const mobileSidebarTrigger = useRef<HTMLButtonElement>(null);
  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    requestAnimationFrame(() => { if (mobileSidebarTrigger.current?.checkVisibility()) mobileSidebarTrigger.current.focus(); });
  }, []);
  const { sidebar, desktop, modal: sidebarModal } = useSidebar(sidebarOpen, closeSidebar);
  const settings = useRef<HTMLDialogElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [requestedSettingsTab, setRequestedSettingsTab] = useState<SettingsTab | undefined>();
  const returnToConversationSettings = useRef(false);
  const [modelChoice, setModelChoice] = useState<string>(() => read('chat-model', ''));
  const [branchHead, setBranchHead] = useState<string | null>(null);
  const [messageMutation, setMessageMutation] = useState<{ id: string; mode: 'edit' | 'delete' } | null>(null);
  const [conversationSettingsOpen, setConversationSettingsOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryTarget, setSummaryTarget] = useState<{ throughId: string; selection?: ModelSelection } | null>(null);
  const [newConversationSettings, setNewConversationSettings] = useState(() => ({ ...DEFAULT_CONVERSATION_SETTINGS, ...read('conversation-settings:new', DEFAULT_CONVERSATION_SETTINGS) }));
  const [settingsDraft, setSettingsDraft] = useState<{ id: string | null; settings: ConversationSettings } | null>(null);
  const [attachmentsFor, setAttachmentsFor] = useState<string | null>(null);
  const settingsDraftChanged = useCallback((settings: ConversationSettings) => {
    setSettingsDraft({ id: selected, settings });
    if (!selected) setNewConversationSettings(settings);
  }, [selected]);
  const models = session?.models ?? [];
  const selectedModel = models.find((model) => modelSelectionKey(model) === modelChoice)
    ?? models.find((model) => model.providerId === session?.activeProviderId && model.model === session?.model)
    ?? models[0];
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | ''>('');
  const settingsTrigger = useRef<HTMLElement | null>(null);
  const openSettings = () => {
    settingsTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSidebarOpen(false); setSettingsOpen(true); settings.current?.showModal();
  };
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
    if (selectedRef.current === id) { setDraft(''); setRevisionOf(undefined); setDraftImages([]); setDraftFiles([]); }
  }, [queryClient]);
  const currentPending = pending.find((item) => item.conversation.id === selected);
  const { snapshot, durableSnapshot, hasUnconfirmed, connection, syncedAt, loading, syncError, reconnect } = useConversation(selected, Boolean(session?.authenticated), loggedOut, Boolean(currentPending && !currentPending.error), rememberDeletion, selected ? deletedAt(selected) : null);
  const active = snapshot.messages.find(isActive);
  const liveUserIds = useMemo(() => new Set(snapshot.messages.filter((message) => message.role === 'user' && !message.deletedAt).map((message) => message.id)), [snapshot.messages]);
  const mutationMessage = messageMutation ? snapshot.messages.find((message) => message.id === messageMutation.id) : undefined;
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
  const busy = Boolean(active || currentPending || sending || imageProgress || syncError || invalidRoute || (selected && loading));
  const currentConversation = conversations.find((item) => item.id === selected);
  const latestCompletedAssistant = useMemo(() => [...snapshot.messages].reverse().find((message) => message.role === 'assistant' && message.status === 'completed' && !message.deletedAt && !message.summary), [snapshot.messages]);
  const currentBranchHead = branchHead && snapshot.messages.some((message) => message.id === branchHead && message.role === 'assistant' && message.status === 'completed' && !message.deletedAt && !message.summary)
    ? branchHead : latestCompletedAssistant?.id;
  const validBranchHead = branchHead && snapshot.messages.some((message) => message.id === branchHead && message.role === 'assistant' && message.status === 'completed' && !message.deletedAt && !message.summary) ? branchHead : undefined;
  const conversationSettings = settingsDraft?.id === selected ? settingsDraft.settings : selected ? snapshot.settings ?? DEFAULT_CONVERSATION_SETTINGS : newConversationSettings;
  const resetNewTools = () => {
    const settings = { ...newConversationSettings, tools: [] };
    setNewConversationSettings(settings); write('conversation-settings:new', settings);
    write('conversation-settings-draft:new', { settings, dirty: false });
  };
  const previewSource = contextSource(snapshot.messages, { content: draft, revisionOf, branchHead: validBranchHead });
  const previewHistory = useMemo(() => {
    try { return summaryContext(snapshot.messages, previewSource.parentId, conversationSettings.useSummaries); } catch { return null; }
  }, [snapshot.messages, previewSource.parentId, conversationSettings.useSummaries]);
  const contextPreview = useMemo(() => {
    if (!selectedModel || !previewHistory) return null;
    const settings = v.safeParse(conversationSettingsSchema, conversationSettings);
    if (!settings.success) return null;
    let estimate;
    try {
      const config = applyConversationSettings({ ...selectedModel, systemPrompt: selectedModel.systemPrompt ?? session?.systemPrompt ?? '',
        maxOutputTokens: session?.maxOutputTokens ?? null, modelMetadata: selectedModel.metadata, reasoningEnabled: selectedModel.reasoningSupported,
        reasoningEffort: reasoningEffort || undefined, showReasoning: session?.showReasoning }, settings.output);
      estimate = buildContext(previewHistory.history, draft.trim(), config, settings.output, previewHistory.summary ? summaryPrefix(previewHistory.summary) : undefined, draftImages, draftFiles).estimate;
      const prepared = prepareChatContext(snapshot.messages, previewSource.parentId, draft.trim(), config, settings.output, draftImages, draftFiles);
      if (prepared.automatic) {
        const selection = settings.output.autoCompression.model;
        const model = selection ? models.find((item) => modelSelectionKey(item) === modelSelectionKey(selection)) : selectedModel;
        if (!model) throw new Error('自动压缩模型不可用，请启用所选模型或关闭自动压缩。');
        summaryGeneration(snapshot.messages, prepared.automatic.throughId, { ...model, systemPrompt: '', maxOutputTokens: null, modelMetadata: model.metadata });
      }
      return { estimate: prepared.automatic?.demand ?? prepared.estimate, compressing: Boolean(prepared.automatic), error: '' };
    } catch (error) { return { estimate, error: error instanceof Error ? error.message : '无法预览上下文。' }; }
  }, [selectedModel, models, snapshot.messages, previewSource.parentId, previewHistory, conversationSettings, draft, draftImages, draftFiles, reasoningEffort, session?.systemPrompt, session?.maxOutputTokens, session?.showReasoning]);
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
    const saved: { text: string; revisionOf?: string; images?: ImagePart[]; files?: DocumentPart[] } = selected && deletedAt(selected) ? { text: '' } : read(`draft:${selected ?? 'new'}`, { text: '' });
    setDraft(saved.text); setRevisionOf(saved.revisionOf); setDraftImages(saved.images ?? []); setDraftFiles(saved.files ?? []); setError('');
  }, [selected]);
  useEffect(() => { setBranchHead(selected ? read<string | null>(`branch-head:${selected}`, null) : null); }, [selected]);
  useEffect(() => { setConversationSettingsOpen(false); }, [selected]);
  useEffect(() => { setSummaryOpen(false); setSummaryTarget(null); }, [selected]);
  useEffect(() => {
    if (!selectedModel?.reasoningSupported) { setReasoningEffort(''); return; }
    const saved = read<ReasoningEffort | ''>(`reasoning-effort:${modelSelectionKey(selectedModel)}`, '');
    setReasoningEffort(selectedModel.reasoningEfforts.includes(saved as ReasoningEffort) ? saved : '');
  }, [selectedModel]);
  useEffect(() => {
    const node = editor.current;
    if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 160)}px`; }
  }, [draft]);
  const updateDraft = (text: string) => { setDraft(text); write(`draft:${selected ?? 'new'}`, { text, revisionOf, images: draftImages, files: draftFiles }); };
  useEffect(() => {
    if (imageUpload.current && (imageUpload.current.origin !== selected || !session?.authenticated)) imageUpload.current.controller.abort();
  }, [selected, session?.authenticated]);
  useEffect(() => () => imageUpload.current?.controller.abort(), []);
  const removeImage = (id: string) => {
    const images = draftImages.filter((image) => image.attachmentId !== id);
    setDraftImages(images); write(`draft:${selected ?? 'new'}`, { text: draft, revisionOf, images, files: draftFiles });
  };
  const removeDocument = (id: string) => {
    const files = draftFiles.filter((file) => file.attachmentId !== id);
    setDraftFiles(files); write(`draft:${selected ?? 'new'}`, { text: draft, revisionOf, images: draftImages, files });
  };
  const addUploads = async (inputFiles: File[], kind: 'image' | 'file') => {
    if (!inputFiles.length || busy || imageUpload.current) return;
    if (!navigator.onLine || !session?.attachmentsConfigured) { setError('附件上传需要联网并配置文件存储。'); return; }
    if (selected && !currentConversation) { setError('请等待对话同步后再添加附件。'); return; }
    if (kind === 'image' && !selectedModel?.metadata.imageInput) { setError('请先选择支持图片的视觉模型。'); return; }
    if (inputFiles.length + (kind === 'image' ? draftImages.length : draftFiles.length) > (kind === 'image' ? MAX_MESSAGE_IMAGES : MAX_MESSAGE_DOCUMENTS)) { setError(kind === 'image' ? '每条消息最多添加 4 张图片。' : '每条消息最多添加 4 个文本文件。'); return; }
    const origin = selected, controller = new AbortController(), operation = { origin, controller };
    imageUpload.current = operation; setImageProgress({ name: inputFiles[0].name, percent: 0, kind }); setError('');
    let conversation = currentConversation;
    const uploadedImages: ImagePart[] = [], uploadedFiles: DocumentPart[] = [], registered: string[] = [];
    try {
      const preparedFiles: { file: File; input: Awaited<ReturnType<typeof prepareAttachment>>; pdf?: PDFExtraction }[] = [];
      for (const file of inputFiles) {
        setImageProgress({ name: file.name, percent: 0, kind });
        const mediaType = fileMediaType(file.name);
        if (kind === 'file' && (!v.safeParse(documentMediaTypeSchema, mediaType).success || !file.size || mediaType !== 'application/pdf' && file.size > MAX_DOCUMENT_BYTES)) throw new Error('请选择 PDF 或不超过 128 KiB 的 UTF-8 文本、代码、CSV 文件。');
        const prepared = kind === 'image' ? await prepareChatImage(file, controller.signal) : file;
        const input = await prepareAttachment(prepared, controller.signal);
        const pdf = kind === 'file' && input.mediaType === 'application/pdf' ? await preparePdf(prepared, input.sha256, controller.signal,
          (page, pages) => setImageProgress({ name: `正在提取 ${prepared.name} · ${page}/${pages}`, percent: Math.round(page / pages * 100), kind })) : undefined;
        preparedFiles.push({ file: prepared, input, pdf });
      }
      if (!conversation) {
        const parameters = v.safeParse(conversationSettingsSchema, conversationSettings);
        if (!parameters.success) throw new Error('请先修正会话参数，再添加附件。');
        conversation = { id: crypto.randomUUID(), title: (draft.trim() || inputFiles[0].name).slice(0, 26), createdAt: Date.now(), updatedAt: Date.now(), pinned: false, archived: false };
        await api('/conversations', 'POST', { id: conversation.id, title: conversation.title }, controller.signal);
        await api(`/conversations/${conversation.id}/settings`, 'PUT', parameters.output, controller.signal);
      }
      for (const { file: prepared, input, pdf } of preparedFiles) {
        setImageProgress({ name: prepared.name, percent: 0, kind }); registered.push(input.id);
        const saved = await uploadAttachment(conversation.id, input, prepared, controller.signal, (received) => setImageProgress({ name: prepared.name, percent: Math.round(received / input.size * 100), kind }));
        if (kind === 'image') uploadedImages.push({ type: 'image', attachmentId: saved.id, name: saved.name, sha256: saved.sha256, size: saved.size, mediaType: prepared.type as ImagePart['mediaType'] });
        else {
          setImageProgress({ name: `正在解析 ${prepared.name}`, percent: 100, kind });
          uploadedFiles.push(await api<DocumentPart>(`/conversations/${conversation.id}/attachments/${saved.id}/document`, 'POST', pdf, controller.signal));
        }
      }
      controller.signal.throwIfAborted();
      if (selectedRef.current !== origin) throw new DOMException('已切换对话', 'AbortError');
      const savedDraft = read<{ text: string; revisionOf?: string }>(`draft:${origin ?? 'new'}`, { text: draft, revisionOf });
      const images = [...draftImages, ...uploadedImages], files = [...draftFiles, ...uploadedFiles];
      if (!origin) resetNewTools();
      write(`draft:${conversation.id}`, { ...savedDraft, images, files }); setDraftImages(images); setDraftFiles(files);
      if (!origin) { write('draft:new', { text: '' }); select(conversation.id); }
      refreshLibrary();
    } catch (error) {
      if (conversation) for (const id of registered) await api(`/conversations/${conversation.id}/attachments/${id}`, 'DELETE', undefined, AbortSignal.timeout(10_000)).catch(() => {});
      if (selectedRef.current === origin && !controller.signal.aborted) setError(error instanceof Error ? error.message : '附件上传失败。');
    } finally {
      if (imageUpload.current === operation) { imageUpload.current = null; setImageProgress(null); }
    }
  };
  const addImages = (files: File[]) => addUploads(files, 'image');
  const addDocuments = (files: File[]) => addUploads(files, 'file');
  const select = (id: string | null) => {
    setSearchJump(null);
    setEditorFocusTarget({ id });
    navigate(id); setSidebarOpen(false);
  };
  useEffect(() => {
    if (!editorFocusTarget) return;
    if (editorFocusTarget.id !== selected) { setEditorFocusTarget(null); return; }
    // The deleted snapshot can keep the composer disabled until the route's empty snapshot is committed.
    if (snapshot.deletedAt) return;
    const target = editorFocusTarget.id;
    const frame = requestAnimationFrame(() => {
      if (selectedRef.current === target && editor.current && !editor.current.disabled && !document.querySelector('dialog[open]')) editor.current.focus();
      setEditorFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [editorFocusTarget, selected, snapshot.deletedAt]);
  const selectBranch = (message: Message) => {
    if (!selected || message.role !== 'assistant' || message.status !== 'completed' || message.deletedAt || message.summary) return;
    setBranchHead(message.id); write(`branch-head:${selected}`, message.id); setError('');
    requestAnimationFrame(() => editor.current?.focus());
  };
  const openSearchResult = (result: SearchResult, query: string) => {
    navigate(result.conversationId); setSidebarOpen(false);
    setSearchJump({ id: result.conversationId, query, key: `${result.messageId}:${result.field}`, token: Date.now() });
  };

  const queue = async (input: SubmitInput) => {
    const origin = selected, epoch = storageEpoch();
    const settings = v.safeParse(conversationSettingsSchema, conversationSettings);
    if (!settings.success) { setError('请先修正会话参数。'); return; }
    input = { ...input, settings: settings.output, ...(settings.output.tools.length ? { tools: settings.output.tools } : {}) };
    if (!input.selection && selectedModel) input = { ...input, selection: { providerId: selectedModel.providerId, model: selectedModel.model } };
    const selectedBranch = validBranchHead;
    if (input.content !== undefined && input.revisionOf === undefined && selectedBranch && input.branchHead === undefined) input = { ...input, branchHead: selectedBranch };
    if (input.showReasoning === undefined) input = { ...input, showReasoning: session?.showReasoning ?? false };
    const generationModel = input.selection ? models.find((model) => model.providerId === input.selection!.providerId && model.model === input.selection!.model) : selectedModel;
    const generationEffort = generationModel && generationModel === selectedModel
      ? reasoningEffort
      : generationModel ? read<ReasoningEffort | ''>(`reasoning-effort:${modelSelectionKey(generationModel)}`, '') : '';
    if (input.reasoningEffort === undefined && generationModel?.reasoningSupported && generationEffort && generationModel.reasoningEfforts.includes(generationEffort)) {
      input = { ...input, reasoningEffort: generationEffort };
    }
    if (input.tools) {
      try {
        assertWebToolSupport(generationModel?.metadata, input.tools);
        const service = navigator.onLine ? await queryClient.fetchQuery({ queryKey: WEB_TOOL_SETTINGS_KEY, queryFn: ({ signal }) => loadWebToolSettings(signal), staleTime: 0 }) : webToolSettings.data;
        if (!service?.hasApiKey) throw new Error('请先配置联网服务，或关闭会话中的联网工具。');
      } catch (error) { if (selectedRef.current === origin && storageEpoch() === epoch) setError(error instanceof Error ? error.message : '无法读取联网服务配置。'); return; }
      if (selectedRef.current !== origin || storageEpoch() !== epoch || !sessionRef.current?.authenticated) return;
    }
    if (generationModel) {
      try {
        const config = applyConversationSettings({ ...generationModel, reasoningEnabled: generationModel.reasoningSupported, reasoningEffort: input.reasoningEffort,
          showReasoning: input.showReasoning, systemPrompt: generationModel.systemPrompt ?? session?.systemPrompt ?? '', maxOutputTokens: session?.maxOutputTokens ?? null, modelMetadata: generationModel.metadata }, settings.output);
        const source = contextSource(snapshot.messages, input);
        const prepared = prepareChatContext(snapshot.messages, source.parentId, source.content, config, settings.output, input.retryOf ? source.images : draftImages, input.retryOf ? source.files : draftFiles);
        if (prepared.automatic) {
          const selection = settings.output.autoCompression.model;
          const model = selection ? models.find((item) => modelSelectionKey(item) === modelSelectionKey(selection)) : generationModel;
          if (!model) throw new Error('自动压缩模型不可用，请启用所选模型或关闭自动压缩。');
          summaryGeneration(snapshot.messages, prepared.automatic.throughId, { ...model, systemPrompt: '', maxOutputTokens: null, modelMetadata: model.metadata });
        }
      }
      catch (error) { setError(error instanceof Error ? error.message : '会话参数无效。'); return; }
    }
    const conversation: ConversationInfo = currentConversation ?? {
      id: selected ?? crypto.randomUUID(), title: (input.content?.trim() || draftImages[0]?.name || draftFiles[0]?.name || '新对话').slice(0, 26), createdAt: Date.now(), updatedAt: Date.now(), pinned: false, archived: false,
    };
    const item: Pending = { conversation, input, images: input.retryOf ? undefined : draftImages, files: input.retryOf ? undefined : draftFiles };
    if (!commitPending([...pendingRef.current, item])) return;
    if (!conversations.some((item) => item.id === conversation.id)) {
      const items = [conversation, ...localConversations]; setLocalConversations(items); write('library', items);
    }
    write(`draft:${selected ?? 'new'}`, { text: '' }); setDraft(''); setRevisionOf(undefined); setDraftImages([]); setDraftFiles([]);
    if (!selected) resetNewTools();
    select(conversation.id);
    setBranchHead(null); write(`branch-head:${conversation.id}`, null);
    scrollToBottom();
    await deliver(item);
  };
  const submit = async (event?: SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if ((!draft.trim() && !draftImages.length && !draftFiles.length) || busy || !selectedModel) return;
    setError(''); setSending(true);
    try { await queue({ requestId: crypto.randomUUID(), content: draft.trim(), ...(draftFiles.length ? { fileIds: draftFiles.map((file) => file.attachmentId) } : {}), ...(draftImages.length ? { imageIds: draftImages.map((image) => image.attachmentId) } : {}), ...(revisionOf ? { revisionOf } : {}) }); }
    finally { setSending(false); }
  };
  const queueSummary = async (input: SubmitInput) => {
    if (!selected || !currentConversation || busy || !input.summaryThrough) throw new Error('当前对话暂时无法压缩，请等待同步或生成完成。');
    const model = models.find((model) => model.providerId === input.selection?.providerId && model.model === input.selection?.model);
    if (!model) throw new Error('所选摘要模型不可用。');
    summaryGeneration(snapshot.messages, input.summaryThrough, { ...model, systemPrompt: '', maxOutputTokens: null, modelMetadata: model.metadata });
    const item = { conversation: currentConversation, input };
    if (!commitPending([...pendingRef.current, item])) throw new Error('无法保存待发送请求。');
    await deliver(item);
    requestAnimationFrame(() => { if (selectedRef.current === item.conversation.id) editor.current?.focus(); });
  };
  const cancel = async () => {
    if (!active?.runId || !selected) return;
    try { await api(`/conversations/${selected}/cancel`, 'POST', { runId: active.runId }); }
    catch (error) { setError(error instanceof Error ? error.message : '停止失败。'); }
  };
  const retry = async (message: Message) => {
    if (message.summary) {
      if (busy) return;
      setSummaryTarget({ throughId: message.summary.throughId, ...(message.providerId && message.model ? { selection: { providerId: message.providerId, model: message.model } } : {}) });
      setSummaryOpen(true); return;
    }
    if (busy || !selectedModel) { openSettings(); return; }
    setSending(true);
    try { await queue({ requestId: crypto.randomUUID(), retryOf: message.id,
      ...(message.status === 'completed' ? { branchHead: message.id } : {}),
      ...(message.providerId && message.model ? { selection: { providerId: message.providerId, model: message.model } } : {}),
    }); }
    finally { setSending(false); }
  };
  const edit = (message: Message) => {
    if (message.role === 'assistant') { setMessageMutation({ id: message.id, mode: 'edit' }); return; }
    setRevisionOf(message.id); setDraft(messageText(message)); setDraftImages(messageImages(message)); setDraftFiles(messageFiles(message));
    write(`draft:${selected}`, { text: messageText(message), revisionOf: message.id, images: messageImages(message), files: messageFiles(message) }); editor.current?.focus();
  };
  const confirmMessageMutation = async (content: string, requestId: string) => {
    if (!selected || !messageMutation) return;
    if (messageMutation.mode === 'edit') {
      await api(`/conversations/${selected}/messages/${messageMutation.id}`, 'PATCH', { requestId, content });
      setBranchHead(null); write(`branch-head:${selected}`, null); refreshLibrary(); scrollToBottom();
    } else {
      await api(`/conversations/${selected}/messages/${messageMutation.id}`, 'DELETE');
      if (branchHead === messageMutation.id) { setBranchHead(null); write(`branch-head:${selected}`, null); }
      if (revisionOf === messageMutation.id) { setRevisionOf(undefined); write(`draft:${selected}`, { text: draft, images: draftImages, files: draftFiles }); }
    }
    requestAnimationFrame(() => editor.current?.focus());
  };
  const quote = (message: Message) => {
    const source = messageText(message).trim();
    if (!source) return;
    const prefix = draft.trim() ? `${draft.trim()}\n\n` : '';
    const available = Math.max(0, 16_000 - prefix.length);
    const quoted = source.split(/\r?\n/u).map((line) => `> ${line}`).join('\n').slice(0, available);
    const next = `${prefix}${quoted}`;
    setRevisionOf(undefined); setDraft(next); setError(''); write(`draft:${selected ?? 'new'}`, { text: next, images: draftImages, files: draftFiles });
    requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(next.length, next.length); });
  };
  const logout = async () => {
    try {
      backupOperation.current?.abort(); setBackupTask(null);
      await api('/logout', 'POST'); clearLocal(); pendingRef.current = []; setPending([]);
      setLocalConversations([]); queryClient.clear(); navigate(null, true); setDraft(''); setRevisionOf(undefined);
      setNewConversationSettings({ ...DEFAULT_CONVERSATION_SETTINGS }); setSettingsDraft(null); setConversationSettingsOpen(false);
      returnToConversationSettings.current = false;
      loggedOut(); settings.current?.close();
    } catch (error) { setError(error instanceof Error ? error.message : '退出失败，请联网后重试。'); settings.current?.close(); }
  };
  const exportChat = (format: 'md' | 'txt' | 'html') => {
    if (!selected) return;
    const title = currentConversation?.title ?? 'EverChat';
    const messages = durableSnapshot.messages.filter((message) => !message.deletedAt);
    const markdown = `# ${title}\n\n${messages.map((message) => {
      const role = message.summary ? '历史摘要' : message.role === 'user' ? '你' : 'EverChat';
      const model = message.role === 'assistant' && (message.modelName || message.model) ? `\n模型：${message.modelName || message.model}\n` : '';
      const reasoning = messageText(message, 'reasoning') ? `\n### 思考过程\n\n${messageText(message, 'reasoning')}\n` : '';
      const status = message.status === 'completed' ? '' : `\n状态：${message.status}${message.error ? `（${message.error}）` : ''}\n`;
      return `## ${role}${message.revisionOf ? ' · 新版本' : ''}${model}\n\n${messageText(message)}${messageImages(message).map((image) => `\n[图片：${image.name}]`).join('')}${messageFiles(message).map((file) => `\n[文件：${file.name}]`).join('')}${reasoning}${status}\n`;
    }).join('\n')}`;
    if (format === 'md') downloadFile(`EverChat-${selected}.md`, markdown, 'text/markdown;charset=utf-8');
    else if (format === 'txt') downloadFile(`EverChat-${selected}.txt`, markdown.replace(/^#{1,6} /gm, '').replace(/^\n### /gm, '\n'), 'text/plain;charset=utf-8');
    else {
      const body = messages.map((message) => `<article><h2>${escapeHtml(message.summary ? '历史摘要' : message.role === 'user' ? '你' : 'EverChat')}${message.revisionOf ? ' · 新版本' : ''}</h2>${message.role === 'assistant' && (message.modelName || message.model) ? `<p class="meta">模型：${escapeHtml(message.modelName || message.model || '')}</p>` : ''}<pre>${escapeHtml(messageText(message))}${messageImages(message).map((image) => `\n[图片：${escapeHtml(image.name)}]`).join('')}${messageFiles(message).map((file) => `\n[文件：${escapeHtml(file.name)}]`).join('')}</pre>${messageText(message, 'reasoning') ? `<details open><summary>思考过程</summary><pre>${escapeHtml(messageText(message, 'reasoning'))}</pre></details>` : ''}${message.status !== 'completed' ? `<p class="error">状态：${escapeHtml(message.status)}${message.error ? `（${escapeHtml(message.error)}）` : ''}</p>` : ''}</article>`).join('');
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:54rem;margin:2rem auto;padding:0 1rem;color:#1f2937}article{border-top:1px solid #d1d5db;padding:1.5rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.meta{color:#6b7280;font-size:.875rem}.error{color:#b91c1c}summary{cursor:pointer}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
      downloadFile(`EverChat-${selected}.html`, html, 'text/html;charset=utf-8');
    }
  };
  const exportBackup = async () => {
    if (!selected || backupOperation.current) return;
    const controller = new AbortController(), id = selected, epoch = storageEpoch(); backupOperation.current = controller;
    setBackupTask({ title: '下载备份', progress: { value: 0, label: '正在读取备份资料' }, route: id, epoch });
    try {
      const blob = await createArchive(id, controller.signal, (progress) => setBackupTask((task) => task ? { ...task, progress } : null));
      if (!controller.signal.aborted && epoch === storageEpoch()) downloadFile(`EverChat-${id}.everchat.zip`, blob, 'application/zip');
    } catch (cause) { if (!controller.signal.aborted && epoch === storageEpoch()) setError(cause instanceof Error ? cause.message : '备份失败，请稍后重试。'); }
    finally { if (backupOperation.current === controller) { backupOperation.current = null; setBackupTask(null); } }
  };
  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || backupOperation.current) return;
    const controller = new AbortController(), sourceId = selectedRef.current, epoch = storageEpoch(); backupOperation.current = controller;
    setError('');
    setBackupTask({ title: '导入备份', progress: { value: 0, label: '正在检查备份' }, route: sourceId, epoch });
    try {
      const result = await restoreArchive(file, controller.signal, (progress) => setBackupTask((task) => task ? { ...task, progress } : null));
      if (epoch !== storageEpoch() || controller.signal.aborted) return;
      void queryClient.invalidateQueries({ queryKey: ['provider-settings'] });
      void api<ProviderSettings>('/settings/providers').then((config) => { if (epoch === storageEpoch()) providerSaved(config); }).catch(() => {});
      refreshLibrary(); if (selectedRef.current === sourceId) select(result.id);
    } catch (cause) { if (!controller.signal.aborted && epoch === storageEpoch()) setError(cause instanceof Error ? cause.message : '恢复备份失败，请检查文件。'); }
    finally { if (backupOperation.current === controller) { backupOperation.current = null; setBackupTask(null); } }
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
  const duplicateConversation = async (messageId?: string) => {
    if (!selected) return;
    const sourceId = selected;
    const path = messageId ? `/messages/${messageId}/duplicate` : '/duplicate';
    const epoch = storageEpoch(), key = `copy:${sourceId}:${messageId ?? 'all'}`, requestId = read<string | null>(key, null) ?? crypto.randomUUID();
    write(key, requestId);
    let result: { id: string };
    try { result = await api<{ id: string }>(`/conversations/${sourceId}${path}`, 'POST', { requestId }); }
    catch (error) {
      if (epoch === storageEpoch() && error instanceof ApiError && (error.code === 'copy-stopped' || error.status >= 400 && error.status < 500)) write(key, null);
      throw error instanceof ApiError ? error : new Error('复制结果未确认，请重试查看结果。');
    }
    if (epoch !== storageEpoch()) return;
    write(key, null);
    refreshLibrary();
    if (selectedRef.current === sourceId) select(result.id);
  };

  if (!session) return <main className="flex min-h-dvh flex-col items-center justify-center gap-6"><Brand />{bootError ? <><p className="max-w-sm px-5 text-center text-sm font-medium text-base-content" role="alert">{bootError}</p><button className="btn" onClick={boot}>重新连接</button></> : <span className="loading loading-dots loading-sm text-base-content/60" />}</main>;
  if (!session.authenticated) return <Login session={session} onLogin={async () => { await boot(); }} />;
  const statusText = connection === 'unavailable' ? '同步失败' : connection === 'offline' ? '离线' : connection === 'connecting' ? '连接中' : hasUnconfirmed ? '保存中' : '已同步';
  const welcome = !invalidRoute && !syncError && (!selected || (!snapshot.messages.length && !currentPending && !loading));
  return <div className="flex h-dvh min-h-0 overflow-hidden">
    {sidebarModal && <button tabIndex={-1} aria-label="关闭对话列表" className="fixed inset-0 z-30 bg-neutral/20 lg:hidden" onClick={closeSidebar} />}
    <aside ref={sidebar} inert={!desktop && !sidebarOpen} role={sidebarModal ? 'dialog' : undefined} aria-modal={sidebarModal || undefined} aria-label="对话列表" className={`${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} sidebar-surface fixed inset-y-0 left-0 z-40 flex w-70 max-w-[90vw] shrink-0 flex-col border-r border-base-300 bg-base-200 transition-transform lg:static lg:translate-x-0`}>
      <div className="flex items-center justify-between px-5 py-5"><Brand small /><button className="btn btn-ghost btn-sm btn-square lg:hidden" aria-label="收起侧栏" onClick={closeSidebar}><X size={18} /></button></div>
      <div className="px-4"><button className="btn h-11 w-full justify-between border-base-content/50 bg-base-100 px-4 text-sm font-medium" onClick={() => select(null)}><span className="flex items-center gap-2.5"><Plus size={17} />开启新对话</span><span><MessageCircle size={15} /></span></button></div>
      <label className="input mx-4 mt-3 h-11 w-auto gap-2 border-base-content/50 bg-base-100"><Search size={14} /><input className="text-xs placeholder:text-base-content/60" placeholder="搜索你的对话" aria-label="搜索对话" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-4">
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
      <button aria-label="空间设置" className="mx-3 mb-3 flex items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-base-300" onClick={openSettings}><span className="flex h-8 w-8 items-center justify-center rounded-full border border-base-content/50 bg-base-100 text-xs">我</span><span className="flex-1"><span className="block text-xs font-medium">私人空间</span></span><Settings size={16} /></button>
    </aside>

    <div inert={sidebarModal} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="chat-header flex h-14 shrink-0 items-center gap-2 border-b border-base-300 px-2 sm:h-16 sm:px-6">
        <button ref={mobileSidebarTrigger} className="btn btn-ghost btn-square h-11 w-11 shrink-0 lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="打开对话列表" aria-expanded={sidebarOpen}><Menu size={20} /></button>
        <p data-testid="conversation-title" className="min-w-0 flex-1 truncate text-sm font-medium" title={currentConversation?.title}>{invalidRoute ? '页面不可用' : currentConversation?.title ?? (selected ? '对话' : '新对话')}</p>
        <div className="flex shrink-0 items-center gap-0 sm:gap-1">
          <span aria-live="polite" className="mr-3 hidden items-center gap-1.5 text-xs text-base-content/70 md:flex" title={syncedAt ? `上次同步 ${new Date(syncedAt).toLocaleTimeString('zh-CN')}` : undefined}>{connection === 'offline' ? <CloudOff size={14} /> : <span className={`status status-xs ${connection === 'connected' && !hasUnconfirmed ? 'status-success' : 'status-warning'}`} />}{statusText}</span>
          {canSearch && <button ref={searchTrigger} type="button" aria-label="搜索当前对话" aria-expanded={searchOpen} aria-controls={searchOpen ? 'conversation-search' : undefined} title="搜索当前对话（Ctrl / ⌘ F）" className="btn btn-ghost btn-square h-11 w-11" onClick={() => searchOpen ? closeConversationSearch() : setConversationSearchFor(selected)}><Search size={18} /></button>}
          <button type="button" aria-label="会话参数" title="会话参数" className="btn btn-ghost btn-square h-11 w-11 hidden md:inline-flex" disabled={Boolean(invalidRoute || syncError)} onClick={() => setConversationSettingsOpen(true)}><SlidersHorizontal size={18} /></button>
          <ConversationActions key={selected ?? 'new'} conversation={currentConversation} disabled={connection === 'offline'} update={updateConversation} remove={deleteConversation} duplicate={duplicateConversation} exports={<>
            <li><button type="button" disabled={!snapshot.messages.length} onClick={() => exportChat('md')}>Markdown</button></li>
            <li><button type="button" disabled={!snapshot.messages.length} onClick={() => exportChat('txt')}>纯文本</button></li>
            <li><button type="button" disabled={!snapshot.messages.length} onClick={() => exportChat('html')}>HTML</button></li>
            <li><button type="button" disabled={!currentConversation} onClick={() => void exportBackup()}>下载备份</button></li>
            <li><button type="button" onClick={() => backupInput.current?.click()}>导入备份</button></li>
          </>}>
            <li className="md:hidden"><button type="button" disabled={Boolean(invalidRoute || syncError)} onClick={() => setConversationSettingsOpen(true)}><SlidersHorizontal size={16} />会话参数</button></li>
            {session.attachmentsConfigured && selected && currentConversation && !snapshot.deletedAt && <li><button type="button" aria-label="管理对话文件" onClick={() => setAttachmentsFor(selected)}><FolderOpen size={16} />对话文件</button></li>}
            {selected && latestCompletedAssistant && <li><button type="button" disabled={busy || connection === 'offline' || loading} onClick={() => { setSummaryTarget(null); setSummaryOpen(true); }}><BookOpen size={16} />压缩历史</button></li>}
          </ConversationActions>
          <input ref={backupInput} type="file" accept=".zip,.json,application/zip,application/json" className="hidden" onChange={(event) => void importBackup(event)} />
        </div>
      </header>
      {searchOpen && <ConversationSearch key={`${selected}:${searchJump?.token ?? ''}`} content={content} viewport={viewport} close={closeConversationSearch} initial={searchJump ?? undefined} />}
      {connection === 'offline' && <div role="status" className="flex items-center justify-center gap-2 border-b border-base-content/50 bg-base-200 px-4 py-2 text-xs text-base-content"><WifiOff size={13} />你现在离线，已保存的对话仍可阅读。新消息将在联网后发送。</div>}
      <div ref={viewportRef} data-testid="message-viewport" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {welcome ? <section ref={contentRef} className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-6 pt-8 pb-12 sm:px-10">
          <h1 className="text-[32px] leading-[1.45] font-semibold tracking-tight sm:text-[42px]">新对话</h1>
          <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {starters.map(({ icon: Icon, title, prompt }) => <button key={title} className="group rounded-lg border border-base-content/50 bg-base-100 p-4 text-left transition hover:-translate-y-0.5 hover:bg-base-200" onClick={() => { updateDraft(prompt); editor.current?.focus(); }}><Icon size={18} strokeWidth={1.5} className="mb-5" /><span className="flex items-center justify-between text-[13px] font-medium">{title}<ArrowUp size={13} className="rotate-45" /></span></button>)}
          </div>
        </section> : <section ref={contentRef} aria-label="对话消息" className="mx-auto w-full max-w-3xl space-y-8 px-5 py-8 sm:px-9 sm:py-10">
          {loading && !snapshot.messages.length && <div className="py-10 text-center text-xs text-base-content/60"><span className="loading loading-dots loading-sm" /><p className="mt-3">正在找回我们的对话…</p></div>}
          {snapshot.messages.map((message) => <MessageView conversationId={selected!} key={message.id} message={message} busy={busy} onRetry={() => void retry(message)} onEdit={() => edit(message)} onQuote={() => quote(message)} onDelete={() => setMessageMutation({ id: message.id, mode: 'delete' })} canRetry={liveUserIds.has(message.parentId ?? '')} branchSelected={message.role === 'assistant' && message.status === 'completed' && message.id === currentBranchHead} onSelectBranch={() => selectBranch(message)} canFork={Boolean(selected && connection !== 'offline' && !syncError && !loading)} onFork={() => duplicateConversation(message.id)} summarySelected={previewHistory?.summary?.id === message.id} />)}
          {currentPending && <article className="ml-auto max-w-[90%] rounded-2xl border border-dashed border-base-content/50 bg-base-200 px-5 py-4"><DocumentPreviews conversationId={currentPending.conversation.id} files={currentPending.files ?? []} /><ImagePreviews conversationId={currentPending.conversation.id} images={currentPending.images ?? []} /><p className="text-sm leading-7 whitespace-pre-wrap">{currentPending.input.summaryThrough ? '历史摘要请求' : currentPending.input.content ?? '新版本'}</p><div className="mt-2 flex items-center gap-2 text-[11px] text-base-content/60"><CloudOff size={12} />{currentPending.error ? '发送失败' : '等待发送'}</div>{currentPending.error && <p className="mt-2 text-xs font-medium leading-5 text-base-content">{currentPending.error}</p>}<div className="mt-2 flex gap-1"><button className="btn btn-ghost btn-xs" onClick={() => { const clean = { ...currentPending, error: undefined }; commitPending(pendingRef.current.map((item) => item.input.requestId === clean.input.requestId ? clean : item)); void deliver(clean); }}>重试</button>{(!currentPending.input.summaryThrough || currentPending.error) && <button className="btn btn-ghost btn-xs" onClick={() => { setDraft(currentPending.input.content ?? ''); setRevisionOf(currentPending.input.revisionOf); setDraftImages(currentPending.images ?? []); setDraftFiles(currentPending.files ?? []); write(`draft:${selected}`, { text: currentPending.input.content ?? '', revisionOf: currentPending.input.revisionOf, images: currentPending.images ?? [], files: currentPending.files ?? [] }); commitPending(pendingRef.current.filter((item) => item.input.requestId !== currentPending.input.requestId)); }}>{currentPending.input.summaryThrough ? '取消请求' : '编辑'}</button>}</div></article>}
        </section>}
      </div>

      <div className="composer-region relative shrink-0 px-3 pt-2 pb-3 sm:px-8 sm:pb-5" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        {!atBottom && <button className="btn btn-circle btn-sm absolute -top-12 left-1/2 z-10 border-base-content/50 bg-base-100 shadow-sm" aria-label="滚动到最新消息" onClick={scrollToBottom}><ArrowDown size={16} /></button>}
        <div className="mx-auto w-full max-w-3xl">
          {invalidRoute && <div role="alert" className="alert alert-error mb-3 text-xs"><span>找不到这个页面。</span><button type="button" className="btn btn-sm" onClick={() => select(null)}>开启新对话</button></div>}
          {syncError && <div role="alert" className="alert alert-error mb-3 text-xs"><span>{syncError}</span><button type="button" className="btn btn-sm" onClick={reconnect}>重新同步</button></div>}
          {error && <p role="alert" className="mb-3 text-xs font-medium text-base-content">{error}</p>}
          {revisionOf && <div className="mb-2 flex items-center justify-between text-xs text-base-content/60"><span>编辑消息</span><button className="btn btn-ghost btn-xs" onClick={() => { setRevisionOf(undefined); write(`draft:${selected}`, { text: draft, images: draftImages, files: draftFiles }); }}>取消</button></div>}
          <form onSubmit={submit} data-testid="chat-composer" className="chat-composer rounded-2xl border border-base-content/50 bg-base-100 p-2 sm:p-3">
            {selected && (draftFiles.length > 0 || draftImages.length > 0) && <div data-testid="draft-previews" className="draft-previews mb-2 max-h-[min(9rem,20dvh)] overflow-y-auto overscroll-contain p-1">
              <DocumentPreviews conversationId={selected} files={draftFiles} remove={imageProgress ? undefined : removeDocument} />
              <ImagePreviews conversationId={selected} images={draftImages} remove={imageProgress ? undefined : removeImage} />
            </div>}
            {imageProgress && <div className="flex items-center gap-2 py-2 text-xs" role="status"><span className="min-w-0 flex-1 truncate">{imageProgress.name}</span><progress className="progress w-20 shrink-0" value={imageProgress.percent} max={100} aria-label={imageProgress.kind === 'image' ? '图片上传进度' : '文件上传进度'} /><button type="button" className="btn btn-ghost btn-sm" onClick={() => imageUpload.current?.controller.abort()}>取消上传</button></div>}
            <textarea onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addImages(files); } }} ref={editor} disabled={Boolean(snapshot.deletedAt)} aria-label="消息" className="composer-editor textarea textarea-ghost block min-h-12 w-full resize-none border-0 px-2 py-1 text-base leading-6 placeholder:text-base-content/70 outline-none! focus:outline-none!" placeholder={active ? '生成中…' : '输入消息…'} value={draft} maxLength={16000} rows={2} onChange={(event) => updateDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
            <div className="mt-1 flex min-w-0 items-center gap-1" data-testid="composer-toolbar">
              {session.attachmentsConfigured && <ActionMenu label="添加附件" icon={<Paperclip size={18} />} placement="dropdown-top dropdown-start" disabled={busy || !navigator.onLine}>
                <li><button type="button" aria-label="添加文件" disabled={draftFiles.length >= MAX_MESSAGE_DOCUMENTS} onClick={() => fileInput.current?.click()}><Paperclip size={16} />文件</button></li>
                <li><button type="button" aria-label="添加图片" disabled={draftImages.length >= MAX_MESSAGE_IMAGES} onClick={() => imageInput.current?.click()}><ImagePlus size={16} />图片</button></li>
              </ActionMenu>}
              <input ref={fileInput} type="file" accept=".pdf,.txt,.md,.csv,.js,.jsx,.ts,.tsx,.py,.rs,.go,.c,.cpp,.h,.css,.json,.yaml,.yml,.toml,.sh" multiple className="hidden" aria-label="选择聊天文件" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addDocuments(files); }} />
              <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" aria-label="选择聊天图片" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addImages(files); }} />
              {selectedModel ? <select aria-label="聊天模型" title={`${selectedModel.providerName} · ${selectedModel.name}`} className="select select-ghost h-11 min-w-0 flex-1 truncate border-transparent pl-2 pr-6 text-xs sm:max-w-80 sm:text-sm" value={modelSelectionKey(selectedModel)} onChange={(event) => { setModelChoice(event.target.value); write('chat-model', event.target.value); }}>
                {[...new Set(models.map((model) => model.providerId))].map((providerId) => <optgroup key={providerId} label={models.find((model) => model.providerId === providerId)!.providerName}>
                  {models.filter((model) => model.providerId === providerId).map((model) => <option key={model.model} value={modelSelectionKey(model)}>{model.name}</option>)}
                </optgroup>)}
              </select> : <button type="button" className="btn btn-ghost min-w-0 flex-1 text-sm" onClick={() => { setRequestedSettingsTab('providers'); openSettings(); }}>配置模型</button>}
              {selectedModel?.reasoningSupported && selectedModel.reasoningEfforts.length > 0 && <select aria-label="思维强度" title={`思维强度：${reasoningEffort ? effortLabels[reasoningEffort] : '默认'}`} className="select select-ghost h-11 w-16 shrink-0 border-transparent pl-1 pr-5 text-xs sm:w-24" value={reasoningEffort} onChange={(event) => { const value = event.target.value as ReasoningEffort | ''; setReasoningEffort(value); write(`reasoning-effort:${modelSelectionKey(selectedModel)}`, value); }}>
                <option value="">思考</option>{selectedModel.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{effortLabels[effort]}</option>)}
              </select>}
              <button type="button" className={`btn btn-ghost btn-square h-11 w-11 shrink-0 ${conversationSettings.tools?.length ? 'bg-base-200' : ''}`} aria-label="联网工具" aria-pressed={Boolean(conversationSettings.tools?.length)} title={conversationSettings.tools?.length ? '联网已开启' : '联网工具'} onClick={() => setConversationSettingsOpen(true)}><Globe size={18} /></button>
              {active ? <button type="button" className="btn btn-square h-11 w-11 shrink-0 rounded-xl" aria-label="停止生成" title="停止生成" onClick={cancel} disabled={!navigator.onLine}><Square size={16} /></button> : <button type="submit" className="btn btn-primary btn-square h-11 w-11 shrink-0 rounded-xl" aria-label="发送消息" disabled={(!draft.trim() && !draftImages.length && !draftFiles.length) || busy || !selectedModel}>{sending ? <span className="loading loading-spinner loading-xs" /> : <ArrowUp size={19} />}</button>}
            </div>
            {contextPreview?.estimate && <ContextEstimateView estimate={contextPreview.estimate} compressing={contextPreview.compressing} />}
            {contextPreview?.error && <p className="mt-2 text-xs text-base-content/80">{contextPreview.error}</p>}
          </form>
        </div>
      </div>
    </div>
    <dialog id="space-settings" ref={settings} className="modal" onClose={() => {
      setSettingsOpen(false); setRequestedSettingsTab(undefined);
      if (!returnToConversationSettings.current) requestAnimationFrame(() => {
        const target = settingsTrigger.current;
        if (target?.isConnected && target.checkVisibility() && !target.closest('[inert]')) target.focus({ preventScroll: true });
        else if (mobileSidebarTrigger.current?.checkVisibility()) mobileSidebarTrigger.current.focus({ preventScroll: true });
      });
      if (returnToConversationSettings.current) { returnToConversationSettings.current = false; setConversationSettingsOpen(true); }
    }} aria-labelledby="space-settings-title">
      <div className="settings-dialog modal-box flex h-[min(48rem,92dvh)] max-h-[92dvh] max-w-5xl flex-col overflow-hidden p-0">
        <div className="flex shrink-0 items-center justify-between border-b border-base-content/30 px-6 py-4"><h2 id="space-settings-title" className="text-lg font-semibold">设置</h2><form method="dialog"><button className="btn btn-ghost btn-sm btn-square" aria-label="关闭设置"><X size={18} /></button></form></div>
        {backupTask && <BackupProgressDialog title={backupTask.title} progress={backupTask.progress} cancel={() => backupOperation.current?.abort()} canRestoreFocus={() => selectedRef.current === backupTask.route && storageEpoch() === backupTask.epoch} />}
        <ProviderSettingsPanel open={settingsOpen} requestedTab={requestedSettingsTab} onSaved={providerSaved} themeControl={<ThemeControl />} onLogout={() => void logout()} />
      </div>
      <form method="dialog" className="modal-backdrop"><button>关闭</button></form>
    </dialog>
    {session?.authenticated && <ConversationSettingsDialog key={selected ?? 'new'} id={selected} initial={selected ? snapshot.settings ?? DEFAULT_CONVERSATION_SETTINGS : newConversationSettings} model={selectedModel} models={models} effort={reasoningEffort} showReasoning={session.showReasoning ?? false} open={conversationSettingsOpen} close={() => setConversationSettingsOpen(false)} onDraft={settingsDraftChanged} managePresets={() => { returnToConversationSettings.current = true; setRequestedSettingsTab('presets'); openSettings(); }} manageWebTools={() => { returnToConversationSettings.current = true; setRequestedSettingsTab('web-tools'); openSettings(); }} />}
    {session.attachmentsConfigured && selected && currentConversation && !snapshot.deletedAt && <AttachmentDialog key={`attachments:${selected}`} id={selected} open={attachmentsFor === selected} close={() => setAttachmentsFor(null)} />}
    {summaryOpen && selected && <SummaryDialog messages={snapshot.messages} headId={summaryTarget?.throughId ?? contextSource(snapshot.messages, { branchHead: validBranchHead }).parentId} models={models} preferred={selectedModel} target={summaryTarget ?? undefined} busy={busy} submit={queueSummary} close={() => { setSummaryOpen(false); setSummaryTarget(null); }} />}
    {messageMutation && mutationMessage && <MessageMutationDialog key={`${selected}:${messageMutation.id}:${messageMutation.mode}`} message={mutationMessage} mode={messageMutation.mode} affectsSummaries={snapshot.messages.some((message) => !message.deletedAt && message.summary?.sourceIds.includes(mutationMessage.id))} confirm={confirmMessageMutation} close={() => setMessageMutation(null)} />}
  </div>;
}
