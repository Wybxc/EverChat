import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs,TabsList,TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { ArrowDown,ArrowUp,BookOpen,CloudOff,FolderOpen,Globe,ImagePlus,Menu,MessageCircle,Paperclip,Pin,Plus,Search,Settings,SlidersHorizontal,Square,WifiOff,X } from 'lucide-react';
import { Fragment,useCallback,useEffect,useMemo,useRef,useState,type ChangeEvent,type SubmitEvent } from 'react';
import * as v from 'valibot';
import { documentMediaTypeSchema,MAX_DOCUMENT_BYTES,MAX_MESSAGE_DOCUMENTS,type DocumentPart } from '../../shared/attachments/documents';
import { fileMediaType } from '../../shared/attachments/files';
import { MAX_MESSAGE_IMAGES,type ImagePart } from '../../shared/attachments/images';
import type { PDFExtraction } from '../../shared/attachments/pdf';
import { parentKey,summariesOnBranch } from '../../shared/conversation/branches';
import { messageFiles,messageImages,messageText } from '../../shared/conversation/content';
import { buildContext,contextSource } from '../../shared/conversation/context-budget';
import { isActive } from '../../shared/conversation/message-state';
import { applyConversationSettings,conversationSettingsSchema,DEFAULT_CONVERSATION_SETTINGS } from '../../shared/conversation/settings';
import { prepareChatContext,summaryContext,summaryGeneration,summaryPrefix } from '../../shared/conversation/summaries';
import { type ConversationInfo,type ConversationSettings,type LibrarySnapshot,type Message,type Submission,type SubmitInput } from '../../shared/conversation/types';
import { canAttemptCapability } from '../../shared/models/metadata';
import { chatModels,effortLabels,modelSelectionKey } from '../../shared/models/selection';
import { type ModelSelection,type ReasoningEffort } from '../../shared/models/types';
import { type ProviderSettings,type SessionInfo } from '../../shared/providers/types';
import type { SearchResult } from '../../shared/search/query';
import { assertWebToolSupport } from '../../shared/web-tools/tasks';
import { ActionMenu,ActionMenuItem } from '../components/ActionMenu';
import { Disclosure,DisclosureScope } from '../components/Disclosure';
import { hasOpenModal,Modal,ModalTitle } from '../components/Modal';
import { prepareAttachment,uploadAttachment } from '../features/attachments/attachment-upload';
import { AttachmentDialog } from '../features/attachments/AttachmentDialog';
import { prepareChatImage } from '../features/attachments/chat-image';
import { DocumentPreviews } from '../features/attachments/DocumentPreviews';
import { ImagePreviews } from '../features/attachments/ImagePreviews';
import { preparePdf } from '../features/attachments/pdf-loader';
import { createArchive,restoreArchive,type BackupProgress } from '../features/backup/archive-client';
import { BackupProgressDialog } from '../features/backup/BackupProgressDialog';
import { downloadFile,escapeHtml } from '../features/backup/download';
import { type BranchNavigation } from '../features/chat/BranchSwitcher';
import { ContextEstimateView } from '../features/chat/ContextEstimate';
import { ConversationActions } from '../features/chat/ConversationActions';
import { ConversationSearch } from '../features/chat/ConversationSearch';
import { ConversationSettingsDialog } from '../features/chat/ConversationSettings';
import { MessageMutationDialog } from '../features/chat/MessageMutationDialog';
import { MessageView } from '../features/chat/MessageView';
import { SummaryDialog } from '../features/chat/SummaryDialog';
import { SummaryView } from '../features/chat/SummaryView';
import { useBranchScrollAnchor } from '../features/chat/useBranchScrollAnchor';
import { useConversation } from '../features/chat/useConversation';
import { useConversationBranches } from '../features/chat/useConversationBranches';
import { useFollowScroll } from '../features/chat/useFollowScroll';
import { conversationGroup } from '../features/library/group-conversations';
import { LibrarySearch } from '../features/library/LibrarySearch';
import { Sidebar } from '../features/library/Sidebar';
import { ModelPicker } from '../features/providers/ModelPicker';
import { ProviderSettingsPanel,type SettingsTab } from '../features/providers/ProviderSettings';
import { loadWebToolSettings,useWebToolSettings,WEB_TOOL_SETTINGS_KEY } from '../features/web-tools/web-tool-settings';
import { api,ApiError } from '../platform/api';
import { clearLocal,deletedAt,markConversationDeleted,read,storageEpoch,write,writePending,type Pending } from '../platform/storage';
import { Brand } from './Brand';
import { Login } from './Login';
import { ThemeControl } from './ThemeControl';
import { conversationUrl,useConversationRoute } from './useConversationRoute';
import { useSidebar } from './useSidebar';

const EMPTY_SESSION: SessionInfo = { authenticated: false, configured: false, attachmentsConfigured: false, provider: '', model: '' };

export function App() {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const webToolSettings = useWebToolSettings(Boolean(session?.authenticated));
  const [bootError, setBootError] = useState('');
  const [localConversations, setLocalConversations] = useState<ConversationInfo[]>(() => read('library', []));
  const { id: selected, branch: routeBranch, invalid: invalidRoute, navigate } = useConversationRoute();
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
  const { viewportRef, contentRef, viewport, content, atBottom, scrollToBottom, pauseFollowing } = useFollowScroll(selected);
  const anchorBranch = useBranchScrollAnchor(viewport, content, selected);
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
  const { desktop } = useSidebar(sidebarOpen, closeSidebar);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => read('sidebar-collapsed', false));
  const toggleSidebar = () => { if (desktop) setSidebarCollapsed((value) => { write('sidebar-collapsed', !value); return !value; }); else setSidebarOpen((value) => !value); };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [requestedSettingsTab, setRequestedSettingsTab] = useState<SettingsTab | undefined>();
  const returnToConversationSettings = useRef(false);
  const [modelChoice, setModelChoice] = useState<string>(() => read('chat-model', ''));
  const [branchAnnouncement, setBranchAnnouncement] = useState('');
  const followRequests = useRef(new Map<string, { id: string; version: number }>());
  const [backgroundTask, setBackgroundTask] = useState<{ conversationId: string; messageId: string; targetId: string } | null>(null);
  const [messageMutation, setMessageMutation] = useState<{ id: string; mode: 'edit' | 'delete' } | null>(null);
  const [conversationSettingsOpen, setConversationSettingsOpen] = useState(false);
  const [focusWebTools, setFocusWebTools] = useState(false);
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
    setSidebarOpen(false); setSettingsOpen(true);
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
  const { snapshot, snapshotFor, authoritative, durableSnapshot, hasUnconfirmed, connection, syncedAt, loading, syncError, reconnect } = useConversation(selected, Boolean(session?.authenticated), loggedOut, Boolean(currentPending && !currentPending.error), rememberDeletion, selected ? deletedAt(selected) : null);
  const branches = useConversationBranches({ id: selected, messages: snapshot.messages, ready: snapshotFor === selected, authoritative, routeHead: routeBranch, navigate });
  const viewHeadRef = useRef(branches.head); viewHeadRef.current = branches.head;
  const branchSummaries = summariesOnBranch(snapshot.messages, branches.path);
  const active = snapshot.messages.find(isActive);
  const activeChat = snapshot.messages.find((message) => isActive(message) && !message.summary) ?? active;
  const activeTarget = activeChat ? activeChat.summary?.throughId ?? activeChat.id : null;
  useEffect(() => {
    if (selected && activeChat && activeTarget && !branches.ids.includes(activeTarget) && branches.index.browsable.has(activeTarget)) {
      setBackgroundTask((previous) => previous?.messageId === activeChat.id && previous.conversationId === selected ? previous : { conversationId: selected, messageId: activeChat.id, targetId: activeTarget });
    } else setBackgroundTask((previous) => previous && (previous.conversationId !== selected || branches.ids.includes(previous.targetId)) ? null : previous);
  }, [selected, activeChat?.id, activeTarget, branches.index, branches.head]);
  const pendingVisible = currentPending && (currentPending.viewHeadId ?? null) === branches.head;
  const hiddenPending = currentPending && !pendingVisible;
  const backgroundMessage = backgroundTask?.conversationId === selected ? snapshot.messages.find((message) => message.id === backgroundTask.messageId) : undefined;
  const liveUserIds = useMemo(() => new Set(snapshot.messages.filter((message) => message.role === 'user' && !message.deletedAt).map((message) => message.id)), [snapshot.messages]);
  const mutationMessage = messageMutation ? snapshot.messages.find((message) => message.id === messageMutation.id) : undefined;
  const canSearch = Boolean(selected && snapshot.messages.length && !snapshot.deletedAt && session?.authenticated);
  const searchOpen = canSearch && (conversationSearchFor === selected || searchJump?.id === selected);
  const closeConversationSearch = () => { setConversationSearchFor(null); setSearchJump(null); searchTrigger.current?.focus(); };
  useEffect(() => { setConversationSearchFor(null); setSearchJump((current) => current?.id === selected ? current : null); }, [selected]);
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if (canSearch && !event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f' && !hasOpenModal()) {
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
  const busy = Boolean(active || currentPending || sending || imageProgress || syncError || branches.error || branches.waiting || invalidRoute || (selected && loading));
  const currentConversation = conversations.find((item) => item.id === selected);
  const latestCompletedAssistant = useMemo(() => [...snapshot.messages].reverse().find((message) => message.role === 'assistant' && message.status === 'completed' && !message.deletedAt && !message.summary), [snapshot.messages]);
  const conversationSettings = settingsDraft?.id === selected ? settingsDraft.settings : selected ? snapshot.settings ?? DEFAULT_CONVERSATION_SETTINGS : newConversationSettings;
  const resetNewTools = () => {
    const settings = { ...newConversationSettings, tools: [] };
    setNewConversationSettings(settings); write('conversation-settings:new', settings);
    write('conversation-settings-draft:new', { settings, dirty: false });
  };
  const previewSource = contextSource(snapshot.messages, { content: draft, revisionOf, parentId: branches.continuationParentId });
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
  const editPending = (item: Pending) => {
    if (!item.input.summaryThrough) {
      setDraft(item.input.content ?? ''); setRevisionOf(item.input.revisionOf); setDraftImages(item.images ?? []); setDraftFiles(item.files ?? []);
      write(`draft:${item.conversation.id}`, { text: item.input.content ?? '', revisionOf: item.input.revisionOf, images: item.images ?? [], files: item.files ?? [] });
    }
    followRequests.current.delete(item.input.requestId);
    commitPending(pendingRef.current.filter((next) => next.input.requestId !== item.input.requestId));
    editor.current?.focus({ preventScroll: true });
  };
  const deliver = async (item: Pending) => {
    if (deletedAt(item.conversation.id)) return;
    const key = item.input.requestId;
    if (deliveryLocks.current.has(key) || !navigator.onLine || !sessionRef.current?.authenticated) return;
    if (!followRequests.current.has(key) && selectedRef.current === item.conversation.id && viewHeadRef.current === (item.viewHeadId ?? null)) {
      followRequests.current.set(key, { id: item.conversation.id, version: branches.navigationVersion.current });
    }
    deliveryLocks.current.add(key);
    try {
      await api('/conversations', 'POST', { id: item.conversation.id, title: item.conversation.title });
      const accepted = await api<Submission>(`/conversations/${item.conversation.id}/messages`, 'POST', item.input);
      const follow = followRequests.current.get(key);
      if (!item.input.summaryThrough && follow && selectedRef.current === follow.id && branches.navigationVersion.current === follow.version) {
        branches.choose(accepted.assistantId, { automatic: true }); scrollToBottom();
      }
      followRequests.current.delete(key);
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
  useEffect(() => { setConversationSettingsOpen(false); setFocusWebTools(false); }, [selected]);
  useEffect(() => { setSummaryOpen(false); setSummaryTarget(null); }, [selected]);
  useEffect(() => {
    if (!selectedModel?.reasoningSupported) { setReasoningEffort(''); return; }
    const saved = read<ReasoningEffort | ''>(`reasoning-effort:${modelSelectionKey(selectedModel)}`, '');
    setReasoningEffort(selectedModel.reasoningEfforts.includes(saved as ReasoningEffort) ? saved : '');
  }, [selectedModel]);
  useEffect(() => {
    const node = editor.current;
    if (!node) return;
    const resize = () => { node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; };
    resize();
    // Font preferences and wrapping can change without changing the draft.
    const metrics = () => { const style = getComputedStyle(node); return `${node.clientWidth}:${style.fontSize}:${style.lineHeight}:${style.paddingBlock}`; };
    let previous = metrics();
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(resize); };
    const observer = new ResizeObserver(() => {
      const next = metrics();
      if (next !== previous) { previous = next; schedule(); }
    });
    observer.observe(node);
    window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); };
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
    if (kind === 'image' && !canAttemptCapability(selectedModel?.metadata, 'imageInput')) { setError('请先选择支持图片的视觉模型。'); return; }
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
    branches.navigationVersion.current++; navigate(id); setSidebarOpen(false);
  };
  useEffect(() => {
    if (!editorFocusTarget) return;
    if (editorFocusTarget.id !== selected) { setEditorFocusTarget(null); return; }
    // The deleted snapshot can keep the composer disabled until the route's empty snapshot is committed.
    if (snapshot.deletedAt) return;
    const target = editorFocusTarget.id;
    const frame = requestAnimationFrame(() => {
      if (selectedRef.current === target && editor.current && !editor.current.disabled && !hasOpenModal()) editor.current.focus();
      setEditorFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [editorFocusTarget, selected, snapshot.deletedAt]);
  const selectBranch = (message: Message) => {
    if (!selected || message.role !== 'assistant' || message.status !== 'completed' || message.deletedAt || message.summary) return;
    pauseFollowing(); branches.choose(message.id); setError('');
    requestAnimationFrame(() => editor.current?.focus({ preventScroll: true }));
  };
  useEffect(() => {
    window.addEventListener('popstate', pauseFollowing);
    return () => window.removeEventListener('popstate', pauseFollowing);
  }, [pauseFollowing]);
  const switchVersion = (message: Message, direction: -1 | 1) => {
    const choices = branches.choices(message.id), position = branches.index.positions.get(message.id) ?? 0, target = choices[position + direction];
    if (!target || !viewport) return;
    const key = parentKey(message.parentId), selector = `[data-branch-switcher="${CSS.escape(key)}"]`;
    const previous = content?.querySelector<HTMLElement>(selector), top = previous?.getBoundingClientRect().top;
    if (top !== undefined) anchorBranch(selector, top, direction);
    pauseFollowing(); branches.choose(target, { descend: true });
    const role = branches.index.roles.get(message.parentId), label = role === 'assistant' ? '回答版本' : role === 'user' ? '提问版本' : '分支';
    setBranchAnnouncement(`${label} ${position + direction + 1}，共 ${choices.length} 个`);
  };
  const branchNavigation = (message: Message): BranchNavigation => {
    const choices = branches.choices(message.id), role = branches.index.roles.get(message.parentId);
    return { count: choices.length, position: branches.index.positions.get(message.id) ?? 0, parent: parentKey(message.parentId),
      label: role === 'user' ? '提问版本' : role === 'assistant' ? '回答版本' : '分支', change: (direction) => switchVersion(message, direction) };
  };
  const openSearchResult = (result: SearchResult, query: string) => {
    branches.navigationVersion.current++; pauseFollowing();
    navigate(result.conversationId, false, result.messageId); setSidebarOpen(false);
    setSearchJump({ id: result.conversationId, query, key: `${result.messageId}:${result.field}`, token: Date.now() });
  };

  const queue = async (input: SubmitInput) => {
    const origin = selected, epoch = storageEpoch();
    const settings = v.safeParse(conversationSettingsSchema, conversationSettings);
    if (!settings.success) { setError('请先修正会话参数。'); return; }
    input = { ...input, settings: settings.output, ...(settings.output.tools.length ? { tools: settings.output.tools } : {}) };
    if (!input.selection && selectedModel) input = { ...input, selection: { providerId: selectedModel.providerId, model: selectedModel.model } };
    if (input.content !== undefined && !input.revisionOf && input.parentId === undefined) {
      if (branches.index.order.length && !branches.continuationParentId) { setError('请选择可继续的版本，或新建对话。'); return; }
      input = { ...input, parentId: branches.continuationParentId };
    }
    const requestView = input.revisionOf ?? input.retryOf ?? branches.head;
    if (requestView && requestView !== branches.head) { pauseFollowing(); branches.choose(requestView); }
    const navigationVersion = branches.navigationVersion.current;
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
    const item: Pending = { conversation, input, viewHeadId: requestView, images: input.retryOf ? undefined : draftImages, files: input.retryOf ? undefined : draftFiles };
    if (!commitPending([...pendingRef.current, item])) return;
    if (!conversations.some((item) => item.id === conversation.id)) {
      const items = [conversation, ...localConversations]; setLocalConversations(items); write('library', items);
    }
    write(`draft:${selected ?? 'new'}`, { text: '' }); setDraft(''); setRevisionOf(undefined); setDraftImages([]); setDraftFiles([]);
    if (!selected) resetNewTools();
    if (!selected) navigate(conversation.id, true);
    followRequests.current.set(input.requestId, { id: conversation.id, version: navigationVersion });
    if (branches.navigationVersion.current === navigationVersion) { scrollToBottom(); editor.current?.focus({ preventScroll: true }); }
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
    const item: Pending = { conversation: currentConversation, input, viewHeadId: branches.head };
    if (!commitPending([...pendingRef.current, item])) throw new Error('无法保存待发送请求。');
    await deliver(item);
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
      const version = branches.navigationVersion.current;
      const result = await api<{ messageId: string }>(`/conversations/${selected}/messages/${messageMutation.id}`, 'PATCH', { requestId, content });
      if (selectedRef.current === selected && version === branches.navigationVersion.current) { branches.choose(result.messageId, { automatic: true }); scrollToBottom(); }
      refreshLibrary();
    } else {
      await api(`/conversations/${selected}/messages/${messageMutation.id}`, 'DELETE');
      if (revisionOf === messageMutation.id) { setRevisionOf(undefined); write(`draft:${selected}`, { text: draft, images: draftImages, files: draftFiles }); }
    }
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
      loggedOut(); setSettingsOpen(false);
    } catch (error) { setError(error instanceof Error ? error.message : '退出失败，请联网后重试。'); setSettingsOpen(false); }
  };
  const exportChat = (format: 'md' | 'txt' | 'html') => {
    if (!selected) return;
    const title = currentConversation?.title ?? 'EverChat';
    const confirmed = new Map(durableSnapshot.messages.map((message) => [message.id, message]));
    const messages = branches.ids.flatMap((id) => { const message = confirmed.get(id); return message && !message.deletedAt && !message.summary ? [message] : []; });
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
    const sourceId = selected, version = branches.navigationVersion.current;
    const path = messageId ? `/messages/${messageId}/duplicate` : '/duplicate';
    const epoch = storageEpoch(), key = `copy:${sourceId}:${messageId ?? branches.head ?? 'all'}`, requestId = read<string | null>(key, null) ?? crypto.randomUUID();
    write(key, requestId);
    let result: { id: string; viewHeadId: string | null };
    try { result = await api<{ id: string; viewHeadId: string | null }>(`/conversations/${sourceId}${path}`, 'POST', { requestId, ...(messageId ?? branches.head ? { viewHeadId: messageId ?? branches.head } : {}) }); }
    catch (error) {
      if (epoch === storageEpoch() && error instanceof ApiError && (error.code === 'copy-stopped' || error.status >= 400 && error.status < 500)) write(key, null);
      throw error instanceof ApiError ? error : new Error('复制结果未确认，请重试查看结果。');
    }
    if (epoch !== storageEpoch()) return;
    write(key, null);
    refreshLibrary();
    if (selectedRef.current === sourceId && branches.navigationVersion.current === version) { branches.navigationVersion.current++; setEditorFocusTarget({ id: result.id }); navigate(result.id, false, result.viewHeadId); }
  };

  const closeSettings = () => {
      setSettingsOpen(false); setRequestedSettingsTab(undefined);
      if (!returnToConversationSettings.current) requestAnimationFrame(() => {
        const target = settingsTrigger.current;
        if (target?.isConnected && target.checkVisibility() && !target.closest('[inert]')) target.focus({ preventScroll: true });
        else if (mobileSidebarTrigger.current?.checkVisibility()) mobileSidebarTrigger.current.focus({ preventScroll: true });
      });
      if (returnToConversationSettings.current) {
        returnToConversationSettings.current = false;
        setFocusWebTools(requestedSettingsTab === 'web-tools');
        setConversationSettingsOpen(true);
      }
  };
  if (!session) return <main className="flex min-h-dvh flex-col items-center justify-center gap-6"><Brand />{bootError ? <><p className="max-w-sm px-5 text-center text-sm font-medium text-foreground" role="alert">{bootError}</p><Button variant="secondary" onClick={boot}>重新连接</Button></> : <Spinner className="text-muted-foreground" />}</main>;
  if (!session.authenticated) return <Login session={session} onLogin={async () => { await boot(); }} />;
  const statusText = connection === 'unavailable' ? '同步失败' : connection === 'offline' ? '离线' : connection === 'connecting' ? '连接中' : hasUnconfirmed ? '保存中' : '已同步';
  const welcome = !invalidRoute && !syncError && (!selected || (!snapshot.messages.length && !currentPending && !loading));
  return <div className="flex h-dvh min-h-0 overflow-hidden">
    <Sidebar desktop={desktop} collapsed={sidebarCollapsed} open={sidebarOpen} onOpenChange={setSidebarOpen} trigger={mobileSidebarTrigger}>
      <div className="flex items-center justify-between min-h-14 px-3 py-1.5"><Brand small /><Button variant="ghost" size="icon" aria-label="收起侧栏" onClick={toggleSidebar}><X className="h-[1.125rem] w-[1.125rem]" /></Button></div>
      <div className="px-3"><Button variant="secondary" className="h-11 w-full justify-between bg-accent px-4 text-sm font-medium text-accent-foreground" onClick={() => select(null)}><span className="flex items-center gap-2.5"><Plus className="h-[1.0625rem] w-[1.0625rem]" />开启新对话</span><span><MessageCircle className="h-[0.9375rem] w-[0.9375rem]" /></span></Button></div>
      <label className="field-control mx-3 mt-2 h-11 w-auto gap-2 border-input bg-background"><Search className="h-[0.875rem] w-[0.875rem]" /><input className="text-xs placeholder:text-muted-foreground" placeholder="搜索你的对话" aria-label="搜索对话" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2">
        <Tabs value={archivedList ? 'archived' : 'active'} onValueChange={(value) => setArchivedList(value === 'archived')}><TabsList className="mb-1 h-auto w-full bg-transparent p-0"><TabsTrigger value="active">对话</TabsTrigger><TabsTrigger value="archived">归档</TabsTrigger></TabsList></Tabs>
        <ul className="w-full space-y-0.5 p-0 text-sm">
          {visibleConversations.map((item, index) => <li key={item.id}>{(!index || conversationGroup(item) !== conversationGroup(visibleConversations[index - 1])) && <h2 className="px-3 pt-3 pb-1 text-xs font-normal text-muted-foreground">{conversationGroup(item)}</h2>}<a href={conversationUrl(item.id)} onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); select(item.id);
          }} aria-current={item.id === selected ? 'page' : undefined} aria-description={[item.pinned ? '已置顶' : '', pending.some((p) => p.conversation.id === item.id) ? '有待发送消息' : ''].filter(Boolean).join('，') || undefined} className="sidebar-link min-w-0 font-normal"><span className="truncate">{item.title}</span>{item.pinned && <Pin aria-hidden="true" className="shrink-0 h-[0.75rem] w-[0.75rem]" />}{pending.some((p) => p.conversation.id === item.id) && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}</a></li>)}
        </ul>
        {!visibleConversations.length && <p className="px-3 text-xs text-muted-foreground">{search ? '没有找到相关对话' : archivedList ? '暂无归档' : '暂无对话'}</p>}
        {search.trim() && <LibrarySearch query={search} archived={archivedList} open={openSearchResult} />}
      </div>
      <Button variant="ghost" aria-label="空间设置" className="mx-2 mb-2 flex min-h-11 items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-border" onClick={openSettings}><span className="flex h-7 w-7 items-center justify-center rounded-full bg-background text-xs">我</span><span className="flex-1"><span className="block text-xs font-medium">私人空间</span></span><Settings className="h-[1rem] w-[1rem]" /></Button>
    </Sidebar>

    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="chat-header flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="icon" ref={mobileSidebarTrigger} className={`h-11 w-11 shrink-0 ${desktop && !sidebarCollapsed ? 'hidden' : ''}`} onClick={toggleSidebar} aria-label="打开对话列表" aria-expanded={desktop ? !sidebarCollapsed : sidebarOpen}><Menu className="h-[1.25rem] w-[1.25rem]" /></Button>
        <p data-testid="conversation-title" className="min-w-0 flex-1 truncate text-sm font-medium" title={currentConversation?.title}>{invalidRoute ? '页面不可用' : currentConversation?.title ?? (selected ? '对话' : '新对话')}</p>
        <div className="flex shrink-0 items-center gap-0 sm:gap-1">
          <span aria-live="polite" className="mr-3 hidden items-center gap-1.5 text-xs text-muted-foreground md:flex" title={syncedAt ? `已同步 · 上次同步 ${new Date(syncedAt).toLocaleTimeString('zh-CN')}` : undefined}>{connection === 'offline' ? <CloudOff className="h-[0.875rem] w-[0.875rem]" /> : <span className="status-dot" data-pending={connection !== 'connected' || hasUnconfirmed} />}<span className={connection === 'connected' && !hasUnconfirmed ? 'sr-only' : undefined}>{statusText}</span></span>
          {canSearch && <Button variant="ghost" size="icon" ref={searchTrigger} type="button" aria-label="搜索当前对话" aria-expanded={searchOpen} aria-controls={searchOpen ? 'conversation-search' : undefined} title="搜索当前对话（Ctrl / ⌘ F）" className="h-11 w-11" onClick={() => searchOpen ? closeConversationSearch() : setConversationSearchFor(selected)}><Search className="h-[1.125rem] w-[1.125rem]" /></Button>}
          <Button variant="ghost" size="icon" type="button" aria-label="会话参数" title="会话参数" className="h-11 w-11 hidden md:inline-flex" disabled={Boolean(invalidRoute || syncError)} onClick={() => setConversationSettingsOpen(true)}><SlidersHorizontal className="h-[1.125rem] w-[1.125rem]" /></Button>
          <ConversationActions key={selected ?? 'new'} conversation={currentConversation} disabled={connection === 'offline'} update={updateConversation} remove={deleteConversation} duplicate={duplicateConversation} exports={<>
            <ActionMenuItem disabled={!snapshot.messages.length} onSelect={() => exportChat('md')}>Markdown</ActionMenuItem>
            <ActionMenuItem disabled={!snapshot.messages.length} onSelect={() => exportChat('txt')}>纯文本</ActionMenuItem>
            <ActionMenuItem disabled={!snapshot.messages.length} onSelect={() => exportChat('html')}>HTML</ActionMenuItem>
            <ActionMenuItem disabled={!currentConversation} onSelect={() => void exportBackup()}>下载备份</ActionMenuItem>
            <ActionMenuItem onSelect={() => backupInput.current?.click()}>导入备份</ActionMenuItem>
          </>}>
            <ActionMenuItem className="md:hidden" disabled={Boolean(invalidRoute || syncError)} onSelect={() => setConversationSettingsOpen(true)}><SlidersHorizontal className="h-[1rem] w-[1rem]" />会话参数</ActionMenuItem>
            {session.attachmentsConfigured && selected && currentConversation && !snapshot.deletedAt && <ActionMenuItem aria-label="管理对话文件" onSelect={() => setAttachmentsFor(selected)}><FolderOpen className="h-[1rem] w-[1rem]" />对话文件</ActionMenuItem>}
            {selected && latestCompletedAssistant && <ActionMenuItem disabled={busy || connection === 'offline' || loading} onSelect={() => { setSummaryTarget(null); setSummaryOpen(true); }}><BookOpen className="h-[1rem] w-[1rem]" />压缩历史</ActionMenuItem>}
          </ConversationActions>
          <input ref={backupInput} type="file" accept=".zip,.json,application/zip,application/json" className="hidden" onChange={(event) => void importBackup(event)} />
        </div>
      </header>
      {searchOpen && <ConversationSearch key={`${selected}:${searchJump?.token ?? ''}`} content={content} viewport={viewport} close={closeConversationSearch} initial={searchJump ?? undefined} />}
      {connection === 'offline' && <div role="status" className="flex items-center justify-center gap-2 border-b border-border bg-muted px-4 py-2 text-xs text-foreground"><WifiOff className="h-[0.8125rem] w-[0.8125rem]" />你现在离线，已保存的对话仍可阅读。新消息将在联网后发送。</div>}
      <div className="conversation-body" data-welcome={welcome}>
      <div ref={viewportRef} data-testid="message-viewport" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"><DisclosureScope key={selected ?? 'new'}>
        {welcome ? <div ref={contentRef} /> : <section ref={contentRef} aria-label="对话消息" className="mx-auto w-full max-w-[49rem] space-y-6 px-4 py-4 sm:py-6">
          {loading && !snapshot.messages.length && <div className="py-10 text-center text-xs text-muted-foreground"><Spinner /><p className="mt-3">正在找回我们的对话…</p></div>}
          {branches.path.map((message) => <Fragment key={message.id}>
            <MessageView conversationId={selected!} message={message} busy={busy} onRetry={() => void retry(message)} onEdit={() => edit(message)} onQuote={() => quote(message)} onDelete={() => setMessageMutation({ id: message.id, mode: 'delete' })} canRetry={liveUserIds.has(message.parentId ?? '')} branch={branchNavigation(message)} hasFollowing={message.id === branches.head && (branches.index.children.get(message.id) ?? []).some((id) => branches.index.browsable.has(id))} onSelectBranch={() => selectBranch(message)} onShowFollowing={() => { pauseFollowing(); branches.choose(message.id, { descend: true }); }} canFork={Boolean(selected && connection !== 'offline' && !syncError && !loading)} onFork={() => duplicateConversation(message.id)} />
            {branchSummaries.some((summary) => summary.summary!.throughId === message.id) && <div data-testid="branch-summaries"><Disclosure stateKey={`summaries:${message.id}`} forceOpen={branchSummaries.some((summary) => summary.summary!.throughId === message.id && isActive(summary))} title={`历史摘要 · ${branchSummaries.filter((summary) => summary.summary!.throughId === message.id).length}`}>
              <div className="space-y-3">{branchSummaries.filter((summary) => summary.summary!.throughId === message.id).map((summary) => <SummaryView key={summary.id} message={summary} busy={busy} onRetry={() => void retry(summary)} onDelete={() => setMessageMutation({ id: summary.id, mode: 'delete' })} selected={previewHistory?.summary?.id === summary.id} />)}</div>
            </Disclosure></div>}
          </Fragment>)}
          {currentPending && pendingVisible && <article className="ml-auto max-w-[90%] rounded-2xl border border-dashed border-input bg-muted px-5 py-4"><DocumentPreviews conversationId={currentPending.conversation.id} files={currentPending.files ?? []} /><ImagePreviews conversationId={currentPending.conversation.id} images={currentPending.images ?? []} /><p className="text-sm leading-7 whitespace-pre-wrap">{currentPending.input.summaryThrough ? '历史摘要请求' : currentPending.input.content ?? '新版本'}</p><div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><CloudOff className="h-[0.75rem] w-[0.75rem]" />{currentPending.error ? '发送失败' : '等待发送'}</div>{currentPending.error && <p className="mt-2 text-xs font-medium leading-5 text-foreground">{currentPending.error}</p>}<div className="mt-2 flex gap-1"><Button variant="ghost" onClick={() => { const clean = { ...currentPending, error: undefined }; commitPending(pendingRef.current.map((item) => item.input.requestId === clean.input.requestId ? clean : item)); void deliver(clean); }}>重试</Button>{(!currentPending.input.summaryThrough || currentPending.error) && <Button variant="ghost" onClick={() => editPending(currentPending)}>{currentPending.input.summaryThrough ? '取消请求' : '编辑'}</Button>}</div></article>}
        </section>}</DisclosureScope>
      </div>

      <div className="composer-region relative shrink-0 pt-2 pb-3" style={{ paddingBottom: 'max(.75rem, env(safe-area-inset-bottom))' }}>
        {!atBottom && <Button variant="secondary" size="icon" className="absolute -top-12 left-1/2 z-10 border-input bg-background shadow-sm" aria-label="滚动到最新消息" onClick={scrollToBottom}><ArrowDown className="h-[1rem] w-[1rem]" /></Button>}
        <div className="mx-auto w-full max-w-[48.5rem]">
          {welcome && <h1 className="mb-6 text-center text-xl font-semibold leading-snug sm:text-2xl">今天想聊些什么？</h1>}
          {invalidRoute && <Alert variant="destructive" role="alert" className="mb-3 text-xs"><span>找不到这个页面。</span><Button variant="secondary" type="button" onClick={() => select(null)}>开启新对话</Button></Alert>}
          {syncError && <Alert variant="destructive" role="alert" className="mb-3 text-xs"><span>{syncError}</span><Button variant="secondary" type="button" onClick={reconnect}>重新同步</Button></Alert>}
          <span className="sr-only" aria-live="polite">{branchAnnouncement}</span>
          {branches.error && <Alert variant="destructive" role="alert" className="mb-2 text-xs">{branches.error}</Alert>}
          {branches.notice && <div role="status" className="mb-2 flex items-center gap-2 text-xs"><span>{branches.notice}</span><Button variant="ghost" size="icon" aria-label="关闭分支提示" onClick={branches.dismissNotice}><X className="size-4" /></Button></div>}
          {(backgroundMessage || hiddenPending) && <div role="status" className="mb-2 flex items-center gap-2 text-xs">
            <span>{hiddenPending ? currentPending.error ? `发送失败：${currentPending.error}` : currentPending.viewHeadId == null ? '发送结果待确认' : '另一分支等待发送' : backgroundMessage && isActive(backgroundMessage) ? '另一分支生成中' : '另一分支已结束'}</span>
            {hiddenPending && currentPending.error && !branches.index.browsable.has(currentPending.viewHeadId ?? '')
              ? <Button variant="ghost" aria-label="编辑待发送消息" onClick={() => editPending(currentPending)}>编辑</Button>
              : hiddenPending && currentPending.viewHeadId == null ? <Button variant="ghost" onClick={() => void deliver(currentPending)}>重试</Button>
              : <Button variant="ghost" onClick={() => { const target = hiddenPending ? currentPending.viewHeadId : backgroundTask?.targetId; if (target) { pauseFollowing(); branches.choose(target); } }}>{backgroundMessage && !isActive(backgroundMessage) ? '查看' : '返回'}</Button>}
            {!hiddenPending && backgroundMessage && !isActive(backgroundMessage) && <Button variant="ghost" size="icon" aria-label="关闭后台分支提示" onClick={() => setBackgroundTask(null)}><X className="size-4" /></Button>}
          </div>}
          {error && <p role="alert" className="mb-3 text-xs font-medium text-foreground">{error}</p>}
          {revisionOf && <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground"><span>编辑消息</span>{!branches.ids.includes(revisionOf) && <Button variant="ghost" onClick={() => { pauseFollowing(); branches.choose(revisionOf); }}>返回原消息</Button>}<Button variant="ghost" onClick={() => { setRevisionOf(undefined); write(`draft:${selected}`, { text: draft, images: draftImages, files: draftFiles }); }}>取消</Button></div>}
          <form onSubmit={submit} data-testid="chat-composer" className="chat-composer">
            {selected && (draftFiles.length > 0 || draftImages.length > 0) && <div data-testid="draft-previews" className="draft-previews mb-2 max-h-[min(9rem,20dvh)] overflow-y-auto overscroll-contain p-1">
              <DocumentPreviews conversationId={selected} files={draftFiles} remove={imageProgress ? undefined : removeDocument} />
              <ImagePreviews conversationId={selected} images={draftImages} remove={imageProgress ? undefined : removeImage} />
            </div>}
            {imageProgress && <div className="flex items-center gap-2 py-2 text-xs" role="status"><span className="min-w-0 flex-1 truncate">{imageProgress.name}</span><progress className="progress-meter w-20 shrink-0" value={imageProgress.percent} max={100} aria-label={imageProgress.kind === 'image' ? '图片上传进度' : '文件上传进度'} /><Button variant="ghost" type="button" onClick={() => imageUpload.current?.controller.abort()}>取消上传</Button></div>}
            <Textarea onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addImages(files); } }} ref={editor} disabled={Boolean(snapshot.deletedAt)} aria-label="消息" className="composer-editor block min-h-11 w-full resize-none border-0 px-2 py-1 text-base leading-6 placeholder:text-muted-foreground outline-none! focus:outline-none!" placeholder={active ? '生成中…' : '输入消息…'} value={draft} maxLength={16000} rows={1} onChange={(event) => updateDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
            <div className="composer-toolbar mt-1 flex min-w-0 flex-wrap items-center gap-1" data-testid="composer-toolbar">
              {session.attachmentsConfigured && <ActionMenu label="添加附件" icon={<Paperclip className="h-[1.125rem] w-[1.125rem]" />} placement="dropdown-top dropdown-start" disabled={busy || !navigator.onLine}>
                <ActionMenuItem aria-label="添加文件" disabled={draftFiles.length >= MAX_MESSAGE_DOCUMENTS} onSelect={() => fileInput.current?.click()}><Paperclip className="h-[1rem] w-[1rem]" />文件</ActionMenuItem>
                <ActionMenuItem aria-label="添加图片" disabled={draftImages.length >= MAX_MESSAGE_IMAGES} onSelect={() => imageInput.current?.click()}><ImagePlus className="h-[1rem] w-[1rem]" />图片</ActionMenuItem>
              </ActionMenu>}
              <input ref={fileInput} type="file" accept=".pdf,.txt,.md,.csv,.js,.jsx,.ts,.tsx,.py,.rs,.go,.c,.cpp,.h,.css,.json,.yaml,.yml,.toml,.sh" multiple className="hidden" aria-label="选择聊天文件" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addDocuments(files); }} />
              <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" aria-label="选择聊天图片" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addImages(files); }} />
              {selectedModel ? <ModelPicker focusComposer={() => editor.current?.focus({ preventScroll: true })} models={models} selected={selectedModel} choose={(value) => { setModelChoice(value); write('chat-model', value); }} /> : <Button variant="ghost" type="button" className="min-w-0 flex-1 text-sm" onClick={() => { setRequestedSettingsTab('providers'); openSettings(); }}>配置模型</Button>}
              {selectedModel?.reasoningSupported && selectedModel.reasoningEfforts.length > 0 && <NativeSelect aria-label="思维强度" title={`思维强度：${reasoningEffort ? effortLabels[reasoningEffort] : '默认'}`} className="h-11 w-16 shrink-0 sm:w-24" selectClassName="border-transparent pl-1 pr-5 text-xs" value={reasoningEffort} onChange={(event) => { const value = event.target.value as ReasoningEffort | ''; setReasoningEffort(value); write(`reasoning-effort:${modelSelectionKey(selectedModel)}`, value); }}>
                <option value="">思考</option>{selectedModel.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{effortLabels[effort]}</option>)}
              </NativeSelect>}
              <Button variant="ghost" size="icon" type="button" className={`   h-11 w-11 shrink-0 ${conversationSettings.tools?.length ? 'bg-muted' : ''}`} aria-label="联网工具" aria-pressed={Boolean(conversationSettings.tools?.length)} title={conversationSettings.tools?.length ? '联网已开启' : '联网工具'} onClick={() => { setFocusWebTools(true); setConversationSettingsOpen(true); }}><Globe className="h-[1.125rem] w-[1.125rem]" /></Button>
              {active ? <Button variant="secondary" size="icon" type="button" className="send-button ml-auto h-11 w-11 shrink-0" aria-label="停止生成" title="停止生成" onClick={cancel} disabled={!navigator.onLine}><Square className="h-[1rem] w-[1rem]" /></Button> : <Button variant="default" size="icon" type="submit" className="send-button ml-auto h-11 w-11 shrink-0" aria-label="发送消息" disabled={(!draft.trim() && !draftImages.length && !draftFiles.length) || busy || !selectedModel}>{sending ? <Spinner /> : <ArrowUp className="h-[1.1875rem] w-[1.1875rem]" />}</Button>}
            </div>
            {contextPreview?.estimate && <ContextEstimateView estimate={contextPreview.estimate} compressing={contextPreview.compressing} />}
            {contextPreview?.error && <p className="mt-2 text-xs text-muted-foreground">{contextPreview.error}</p>}
          </form>
        </div>
      </div>
      </div>
    </div>
    <ProviderSettingsPanel open={settingsOpen} requestedTab={requestedSettingsTab} onSaved={providerSaved} themeControl={<ThemeControl />} onLogout={() => void logout()} render={(content) => (
<Modal open={settingsOpen} onOpenChange={(next) => { if (!next) closeSettings(); }} onCloseAutoFocus={(event) => event.preventDefault()} aria-labelledby="space-settings-title">
      <div className="settings-dialog flex h-[min(48rem,92dvh)] max-h-[92dvh] max-w-[60rem] flex-col overflow-hidden p-0">
        <div className="flex shrink-0 items-center justify-between px-3 py-1.5 sm:px-4"><ModalTitle id="space-settings-title" className="text-lg font-semibold">设置</ModalTitle><Button type="button" onClick={closeSettings} variant="ghost" size="icon" aria-label="关闭设置"><X className="h-[1.125rem] w-[1.125rem]" /></Button></div>

        {content}
      </div>
    </Modal>
    )} />
    {backupTask && <BackupProgressDialog title={backupTask.title} progress={backupTask.progress} cancel={() => backupOperation.current?.abort()} canRestoreFocus={() => selectedRef.current === backupTask.route && storageEpoch() === backupTask.epoch} />}
    {session?.authenticated && <ConversationSettingsDialog key={selected ?? 'new'} id={selected} initial={selected ? snapshot.settings ?? DEFAULT_CONVERSATION_SETTINGS : newConversationSettings} model={selectedModel} models={models} effort={reasoningEffort} showReasoning={session.showReasoning ?? false} open={conversationSettingsOpen} focusTools={focusWebTools} close={() => { setConversationSettingsOpen(false); setFocusWebTools(false); }} onDraft={settingsDraftChanged} managePresets={() => { returnToConversationSettings.current = true; setRequestedSettingsTab('presets'); openSettings(); }} manageWebTools={() => { returnToConversationSettings.current = true; setRequestedSettingsTab('web-tools'); openSettings(); }} />}
    {session.attachmentsConfigured && selected && currentConversation && !snapshot.deletedAt && <AttachmentDialog key={`attachments:${selected}`} id={selected} open={attachmentsFor === selected} close={() => setAttachmentsFor(null)} />}
    {summaryOpen && selected && <SummaryDialog messages={snapshot.messages} headId={summaryTarget?.throughId ?? contextSource(snapshot.messages, { parentId: branches.continuationParentId }).parentId} models={models} preferred={selectedModel} target={summaryTarget ?? undefined} busy={busy} submit={queueSummary} close={() => { setSummaryOpen(false); setSummaryTarget(null); }} focusComposer={() => { if (selectedRef.current === selected) editor.current?.focus({ preventScroll: true }); }} />}
    {messageMutation && mutationMessage && <MessageMutationDialog key={`${selected}:${messageMutation.id}:${messageMutation.mode}`} message={mutationMessage} mode={messageMutation.mode} affectsSummaries={snapshot.messages.some((message) => !message.deletedAt && message.summary?.sourceIds.includes(mutationMessage.id))} confirm={confirmMessageMutation} close={() => setMessageMutation(null)} completedFocus={() => {
      if (selectedRef.current !== selected) return null;
      return document.querySelector<HTMLElement>(`[data-message-id="${mutationMessage.id}"] button[aria-label="更多消息操作"]`)
        ?? [...document.querySelectorAll<HTMLElement>('[data-message-id] button[aria-label="更多消息操作"]')].at(-1) ?? editor.current;
    }} />}
  </div>;
}
