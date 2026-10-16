import { completeSignOut, pendingLogout } from '../platform/auth';
import { useMutationFocus } from '../features/chat/useMutationFocus';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CloudOff,
  Download,
  FolderOpen,
  Globe,
  ImagePlus,
  Keyboard,
  Menu,
  Paperclip,
  Pin,
  Search,
  SlidersHorizontal,
  Square,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SubmitEvent,
} from 'react';
import * as v from 'valibot';
import { MAX_MESSAGE_DOCUMENTS } from '../../shared/attachments/documents';
import { MAX_MESSAGE_IMAGES } from '../../shared/attachments/images';
import { parentKey, summariesOnBranch } from '../../shared/conversation/branches';
import { messageFiles, messageImages, messageText } from '../../shared/conversation/content';
import { contextSource } from '../../shared/conversation/context-budget';
import { isActive } from '../../shared/conversation/message-state';
import {
  applyConversationSettings,
  conversationSettingsSchema,
  DEFAULT_CONVERSATION_SETTINGS,
} from '../../shared/conversation/settings';
import { prepareChatContext, summaryGeneration } from '../../shared/conversation/summaries';
import {
  type ConversationInfo,
  type ConversationSettings,
  type Message,
  type SubmitInput,
} from '../../shared/conversation/types';
import { effortLabels, modelSelectionKey } from '../../shared/models/selection';
import { type ModelSelection, type ReasoningEffort } from '../../shared/models/types';
import type { SearchResult } from '../../shared/search/query';
import { assertWebToolSupport } from '../../shared/web-tools/tasks';
import {
  ActionMenu,
  ActionMenuItem,
  ActionMenuLabel,
  ActionMenuSeparator,
} from '../components/ActionMenu';
import { Disclosure, DisclosureScope } from '../components/Disclosure';
import { hasOpenModal, Modal, ModalTitle } from '../components/Modal';
import { AttachmentDialog } from '../features/attachments/AttachmentDialog';
import { DocumentPreviews } from '../features/attachments/DocumentPreviews';
import { ImagePreviews } from '../features/attachments/ImagePreviews';
import { useChatAttachments } from '../features/attachments/useChatAttachments';
import { BackupProgressDialog } from '../features/backup/BackupProgressDialog';
import { exportChatFile } from '../features/backup/export-chat';
import { useBackup } from '../features/backup/useBackup';
import { type BranchNavigation } from '../features/chat/BranchSwitcher';
import {
  deletedAt,
  markConversationDeleted,
  writeChatCache,
  writePending,
  type Pending,
} from '../features/chat/cache';
import { ContextEstimateView } from '../features/chat/ContextEstimate';
import { ConversationActions } from '../features/chat/ConversationActions';
import { ConversationSearch } from '../features/chat/ConversationSearch';
import { ConversationSettingsDialog } from '../features/chat/ConversationSettings';
import { MessageMutationDialog } from '../features/chat/MessageMutationDialog';
import { MessageView } from '../features/chat/MessageView';
import { SummaryDialog } from '../features/chat/SummaryDialog';
import { SummaryView } from '../features/chat/SummaryView';
import { useBranchScrollAnchor } from '../features/chat/useBranchScrollAnchor';
import { useChatDraft } from '../features/chat/useChatDraft';
import { useComposerSize } from '../features/chat/useComposerSize';
import { useContextPreview } from '../features/chat/useContextPreview';
import { useConversation } from '../features/chat/useConversation';
import { useConversationBranches } from '../features/chat/useConversationBranches';
import { useFollowScroll } from '../features/chat/useFollowScroll';
import { useOutbox } from '../features/chat/useOutbox';
import { conversationGroup } from '../features/library/group-conversations';
import { GlobalSearch } from '../features/library/GlobalSearch';
import { Sidebar } from '../features/library/Sidebar';
import { useLibraryIndex } from '../features/library/useLibraryIndex';
import { ModelPicker } from '../features/providers/ModelPicker';
import {
  loadWebToolSettings,
  useWebToolSettings,
  WEB_TOOL_SETTINGS_KEY,
} from '../features/web-tools/web-tool-settings';
import { api, ApiError } from '../platform/api';
import { clearLocal, read, storageEpoch, write } from '../platform/storage';
import { AppFrame, LoadingContent, SidebarHeader, SpaceSettingsButton } from './AppFrame';
import { SettingsDialog } from './SettingsDialog';
import { AccessGate } from './AccessGate';
import { identityKey } from '../../shared/auth/types';
import { SettingsPanel, type SettingsTab } from './SettingsPanel';
import { ThemeControl } from './ThemeControl';
import { conversationUrl, useConversationRoute } from './useConversationRoute';
import { useSession } from './useSession';
import { useSidebar } from './useSidebar';
import {
  ariaShortcut,
  commandDefinitions,
  shortcutLabel,
  useAppCommands,
  type CommandId,
} from './commands';

export function App({
  initialSettings,
}: { initialSettings?: { open: boolean; tab?: SettingsTab } } = {}) {
  const queryClient = useQueryClient();
  const [logoutTarget, setLogoutTarget] = useState(
    () => pendingLogout() ?? '/cdn-cgi/access/logout',
  );
  const {
    session,
    sessionRef,
    status,
    bootError,
    boot,
    loggedOut,
    signOut,
    providerSaved,
    reportSignOutError,
  } = useSession();
  const webToolSettings = useWebToolSettings(Boolean(session?.authenticated));

  const {
    id: selected,
    branch: routeBranch,
    invalid: invalidRoute,
    navigate,
  } = useConversationRoute();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const { pending, pendingRef, setPending, followRequests, commitPending, deliver } = useOutbox({
    authenticated: Boolean(session?.authenticated),
    sessionRef,
    selectedRef,
    getView: () => ({ head: branches.head, version: branches.navigationVersion.current }),
    onAccepted: (accepted) => {
      branches.choose(accepted.assistantId, { automatic: true });
      scrollToBottom();
    },
    onUnauthorized: loggedOut,
    onDeleted: (id, time) => rememberDeletion(id, time),
    refreshLibrary: () => refreshLibrary(),
    setError: (error) => setError(error),
  });
  const chatDraft = useChatDraft(selected);
  const {
    draft,
    setDraft,
    draftFiles,
    setDraftFiles,
    draftImages,
    setDraftImages,
    revisionOf,
    setRevisionOf,
    updateDraft,
    removeImage,
    removeDocument,
  } = chatDraft;
  const fileInput = useRef<HTMLInputElement>(null),
    imageInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setError('');
  }, [selected]);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const globalSearchReturn = useRef<HTMLElement | null>(null);
  const searchNavigated = useRef(false);
  const [archivedList, setArchivedList] = useState(false);
  const [sending, setSending] = useState(false);
  const { viewportRef, contentRef, viewport, content, atBottom, scrollToBottom, pauseFollowing } =
    useFollowScroll(selected);
  const anchorBranch = useBranchScrollAnchor(viewport, content, selected);
  const [conversationSearchFor, setConversationSearchFor] = useState<string | null>(null);
  const [searchJump, setSearchJump] = useState<{
    id: string;
    query: string;
    key: string;
    token: number;
  } | null>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [editorFocusTarget, setEditorFocusTarget] = useState<{ id: string | null } | null>(null);
  const mobileSidebarTrigger = useRef<HTMLButtonElement>(null);
  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    requestAnimationFrame(() => {
      if (mobileSidebarTrigger.current?.checkVisibility()) mobileSidebarTrigger.current.focus();
    });
  }, []);
  const { desktop } = useSidebar(sidebarOpen, closeSidebar);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => read('sidebar-collapsed', false));
  const toggleSidebar = () => {
    if (desktop)
      setSidebarCollapsed((value) => {
        write('sidebar-collapsed', !value);
        return !value;
      });
    else setSidebarOpen((value) => !value);
  };
  const [settingsOpen, setSettingsOpen] = useState(initialSettings?.open ?? false);
  const [requestedSettingsTab, setRequestedSettingsTab] = useState<SettingsTab | undefined>(
    initialSettings?.tab,
  );
  const returnToConversationSettings = useRef(false);
  const [requestedProviderId, setRequestedProviderId] = useState<string | undefined>();
  const [modelChoice, setModelChoice] = useState<string>(() => read('chat-model', ''));
  const [branchAnnouncement, setBranchAnnouncement] = useState('');
  const [backgroundTask, setBackgroundTask] = useState<{
    conversationId: string;
    messageId: string;
    targetId: string;
  } | null>(null);
  const [messageMutation, setMessageMutation] = useState<{
    id: string;
    mode: 'edit' | 'delete';
  } | null>(null);
  const [conversationSettingsOpen, setConversationSettingsOpen] = useState(false);
  const [focusWebTools, setFocusWebTools] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryTarget, setSummaryTarget] = useState<{
    throughId: string;
    selection?: ModelSelection;
  } | null>(null);
  const [newConversationSettings, setNewConversationSettings] = useState(() => ({
    ...DEFAULT_CONVERSATION_SETTINGS,
    ...read('conversation-settings:new', DEFAULT_CONVERSATION_SETTINGS),
  }));
  const [settingsDraft, setSettingsDraft] = useState<{
    id: string | null;
    settings: ConversationSettings;
  } | null>(null);
  const [attachmentsFor, setAttachmentsFor] = useState<string | null>(null);
  const settingsDraftChanged = useCallback(
    (settings: ConversationSettings) => {
      setSettingsDraft({ id: selected, settings });
      if (!selected) setNewConversationSettings(settings);
    },
    [selected],
  );
  const models = session?.models ?? [];
  const selectedModel =
    models.find((model) => modelSelectionKey(model) === modelChoice) ??
    models.find(
      (model) => model.providerId === session?.activeProviderId && model.model === session?.model,
    ) ??
    models[0];
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | ''>('');
  const settingsTrigger = useRef<HTMLElement | null>(null);
  const openSettings = () => {
    settingsTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSidebarOpen(false);
    setSettingsOpen(true);
  };
  const {
    conversations,
    libraryLoading,
    libraryError,
    setLocalConversations,
    rememberConversation,
    refreshLibrary,
    forgetConversation,
  } = useLibraryIndex({
    enabled: Boolean(session?.authenticated),
    pending,
    onDeleted: (id, time) => rememberDeletion(id, time),
    onUnauthorized: loggedOut,
  });
  const rememberDeletion = useCallback(
    (id: string, time: number) => {
      markConversationDeleted(id, time);
      const remaining = pendingRef.current.filter((item) => item.conversation.id !== id);
      writePending(remaining);
      pendingRef.current = remaining;
      setPending(remaining);
      forgetConversation(id);
      if (selectedRef.current === id) {
        setDraft('');
        setRevisionOf(undefined);
        setDraftImages([]);
        setDraftFiles([]);
      }
    },
    [forgetConversation],
  );
  const currentPending = pending.find((item) => item.conversation.id === selected);
  const {
    snapshot,
    snapshotFor,
    authoritative,
    durableSnapshot,
    hasUnconfirmed,
    connection,
    syncedAt,
    loading,
    syncError,
    connectionError,
    reconnect,
  } = useConversation(
    selected,
    Boolean(session?.authenticated),
    loggedOut,
    Boolean(currentPending && !currentPending.error),
    rememberDeletion,
    selected ? deletedAt(selected) : null,
  );
  const branches = useConversationBranches({
    id: selected,
    messages: snapshot.messages,
    ready: snapshotFor === selected,
    authoritative,
    routeHead: routeBranch,
    navigate,
  });
  const { prepareMutationFocus, closeMutationFocus } = useMutationFocus({
    selected,
    messages: snapshot.messages,
    visibleIds: branches.ids,
    navigationVersion: branches.navigationVersion,
    editor,
  });
  const branchSummaries = summariesOnBranch(snapshot.messages, branches.path);
  const active = snapshot.messages.find(isActive);
  const activeChat =
    snapshot.messages.find((message) => isActive(message) && !message.summary) ?? active;
  const activeTarget = activeChat ? (activeChat.summary?.throughId ?? activeChat.id) : null;
  useEffect(() => {
    if (
      selected &&
      activeChat &&
      activeTarget &&
      !branches.ids.includes(activeTarget) &&
      branches.index.browsable.has(activeTarget)
    ) {
      setBackgroundTask((previous) =>
        previous?.messageId === activeChat.id && previous.conversationId === selected
          ? previous
          : { conversationId: selected, messageId: activeChat.id, targetId: activeTarget },
      );
    } else
      setBackgroundTask((previous) =>
        previous &&
        (previous.conversationId !== selected || branches.ids.includes(previous.targetId))
          ? null
          : previous,
      );
  }, [selected, activeChat?.id, activeTarget, branches.index, branches.head]);
  const pendingVisible = currentPending && (currentPending.viewHeadId ?? null) === branches.head;
  const hiddenPending = currentPending && !pendingVisible;
  const backgroundMessage =
    backgroundTask?.conversationId === selected
      ? snapshot.messages.find((message) => message.id === backgroundTask.messageId)
      : undefined;
  const liveUserIds = useMemo(
    () =>
      new Set(
        snapshot.messages
          .filter((message) => message.role === 'user' && !message.deletedAt)
          .map((message) => message.id),
      ),
    [snapshot.messages],
  );
  const mutationMessage = messageMutation
    ? snapshot.messages.find((message) => message.id === messageMutation.id)
    : undefined;
  const canSearch = Boolean(
    selected && snapshot.messages.length && !snapshot.deletedAt && session?.authenticated,
  );
  const searchOpen =
    canSearch && (conversationSearchFor === selected || searchJump?.id === selected);
  const closeConversationSearch = () => {
    setConversationSearchFor(null);
    setSearchJump(null);
    searchTrigger.current?.focus();
  };
  useEffect(() => {
    setConversationSearchFor(null);
    setSearchJump((current) => (current?.id === selected ? current : null));
  }, [selected]);
  const currentConversation = conversations.find((item) => item.id === selected);
  const latestCompletedAssistant = useMemo(
    () =>
      [...snapshot.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' &&
            message.status === 'completed' &&
            !message.deletedAt &&
            !message.summary,
        ),
    [snapshot.messages],
  );
  const conversationSettings =
    settingsDraft?.id === selected
      ? settingsDraft.settings
      : selected
        ? (snapshot.settings ?? DEFAULT_CONVERSATION_SETTINGS)
        : newConversationSettings;
  const resetNewTools = () => {
    const settings = { ...newConversationSettings, tools: [] };
    setNewConversationSettings(settings);
    write('conversation-settings:new', settings);
    writeChatCache('conversation-settings-draft:new', { settings, dirty: false });
  };
  const { previewHistory, contextPreview } = useContextPreview({
    messages: snapshot.messages,
    parentId: branches.continuationParentId,
    draft,
    revisionOf,
    draftImages,
    draftFiles,
    conversationSettings,
    selectedModel,
    models,
    reasoningEffort,
    session,
  });
  const visibleConversations = conversations.filter(
    (item) => Boolean(item.archived) === archivedList,
  );

  const { backupOperation, backupTask, exportBackup, importBackup, cancelBackup } = useBackup({
    selected,
    selectedRef,
    setError,
    providerSaved,
    refreshLibrary,
    navigate: (id) => select(id),
  });

  const editPending = (item: Pending) => {
    if (!item.input.summaryThrough) {
      setDraft(item.input.content ?? '');
      setRevisionOf(item.input.revisionOf);
      setDraftImages(item.images ?? []);
      setDraftFiles(item.files ?? []);
      writeChatCache(`draft:${item.conversation.id}`, {
        text: item.input.content ?? '',
        revisionOf: item.input.revisionOf,
        images: item.images ?? [],
        files: item.files ?? [],
      });
    }
    followRequests.current.delete(item.input.requestId);
    commitPending(
      pendingRef.current.filter((next) => next.input.requestId !== item.input.requestId),
    );
    editor.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    setConversationSettingsOpen(false);
    setFocusWebTools(false);
  }, [selected]);
  useEffect(() => {
    setSummaryOpen(false);
    setSummaryTarget(null);
  }, [selected]);
  useEffect(() => {
    if (!selectedModel?.reasoningSupported) {
      setReasoningEffort('');
      return;
    }
    const saved = read<ReasoningEffort | ''>(
      `reasoning-effort:${modelSelectionKey(selectedModel)}`,
      '',
    );
    setReasoningEffort(
      selectedModel.reasoningEfforts.includes(saved as ReasoningEffort) ? saved : '',
    );
  }, [selectedModel]);
  useComposerSize(editor, draft);
  const { imageUpload, imageProgress, addImages, addDocuments } = useChatAttachments({
    selected,
    selectedRef,
    currentConversation,
    session,
    selectedModel,
    isBusy: () => attachmentBlocked,
    chatDraft,
    conversationSettings,
    resetNewTools,
    select: (id) => select(id),
    refreshLibrary,
    setError,
  });
  const historyPending = Boolean(
    selected &&
    (snapshotFor !== selected || loading || (!authoritative && connection !== 'offline')),
  );
  const messageBlocked = Boolean(
    active ||
    currentPending ||
    sending ||
    syncError ||
    branches.error ||
    branches.waiting ||
    invalidRoute ||
    historyPending ||
    snapshot.deletedAt,
  );
  const attachmentBlocked = Boolean(
    imageProgress ||
    currentPending ||
    sending ||
    syncError ||
    invalidRoute ||
    snapshot.deletedAt ||
    (selected && !currentConversation),
  );
  const generationBlocked = messageBlocked || Boolean(imageProgress);
  const select = (id: string | null) => {
    setSearchJump(null);
    setEditorFocusTarget({ id });
    branches.navigationVersion.current++;
    navigate(id);
    setSidebarOpen(false);
  };
  const openGlobalSearch = () => {
    if (globalSearchOpen) {
      document.querySelector<HTMLInputElement>('[data-testid="global-search"] input')?.focus();
      return;
    }
    globalSearchReturn.current =
      sidebarOpen && !desktop
        ? mobileSidebarTrigger.current
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    searchNavigated.current = false;
    setSidebarOpen(false);
    setGlobalSearchOpen(true);
  };
  useAppCommands([
    {
      id: 'new-chat',
      enabled: Boolean(session?.authenticated),
      allowEditing: true,
      run: () => select(null),
    },
    {
      id: 'global-search',
      enabled: Boolean(session?.authenticated),
      allowEditing: true,
      allowModal: globalSearchOpen,
      run: openGlobalSearch,
    },
    {
      id: 'find-in-chat',
      enabled: canSearch,
      allowEditing: true,
      run: () => {
        setConversationSearchFor(selected);
        document.querySelector<HTMLInputElement>('#conversation-search input')?.focus();
      },
    },
    {
      id: 'focus-composer',
      enabled: Boolean(session?.authenticated && !invalidRoute && !snapshot.deletedAt),
      allowEditing: true,
      run: () => editor.current?.focus({ preventScroll: true }),
    },
    { id: 'toggle-sidebar', enabled: Boolean(session?.authenticated), run: toggleSidebar },
  ]);
  useEffect(() => {
    if (!editorFocusTarget) return;
    if (editorFocusTarget.id !== selected) {
      setEditorFocusTarget(null);
      return;
    }
    // The deleted snapshot can keep the composer disabled until the route's empty snapshot is committed.
    if (snapshot.deletedAt) return;
    const target = editorFocusTarget.id;
    const previousFocus = document.activeElement;
    const frame = requestAnimationFrame(() => {
      if (
        selectedRef.current === target &&
        editor.current &&
        !editor.current.disabled &&
        !hasOpenModal() &&
        (document.activeElement === previousFocus || document.activeElement === document.body)
      )
        editor.current.focus({ preventScroll: true });
      setEditorFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [editorFocusTarget, selected, snapshot.deletedAt]);
  const selectBranch = (message: Message) => {
    if (
      !selected ||
      message.role !== 'assistant' ||
      message.status !== 'completed' ||
      message.deletedAt ||
      message.summary
    )
      return;
    pauseFollowing();
    branches.choose(message.id);
    setError('');
    requestAnimationFrame(() => editor.current?.focus({ preventScroll: true }));
  };
  useEffect(() => {
    window.addEventListener('popstate', pauseFollowing);
    return () => window.removeEventListener('popstate', pauseFollowing);
  }, [pauseFollowing]);
  const switchVersion = (message: Message, direction: -1 | 1) => {
    const choices = branches.choices(message.id),
      position = branches.index.positions.get(message.id) ?? 0,
      target = choices[position + direction];
    if (!target || !viewport) return;
    const key = parentKey(message.parentId),
      selector = `[data-branch-switcher="${CSS.escape(key)}"]`;
    const previous = content?.querySelector<HTMLElement>(selector),
      top = previous?.getBoundingClientRect().top;
    if (top !== undefined) anchorBranch(selector, top, direction);
    pauseFollowing();
    branches.choose(target, { descend: true });
    const role = branches.index.roles.get(message.parentId),
      label = role === 'assistant' ? '回答版本' : role === 'user' ? '提问版本' : '分支';
    setBranchAnnouncement(`${label} ${position + direction + 1}，共 ${choices.length} 个`);
  };
  const branchNavigation = (message: Message): BranchNavigation => {
    const choices = branches.choices(message.id),
      role = branches.index.roles.get(message.parentId);
    return {
      count: choices.length,
      position: branches.index.positions.get(message.id) ?? 0,
      parent: parentKey(message.parentId),
      label: role === 'user' ? '提问版本' : role === 'assistant' ? '回答版本' : '分支',
      change: (direction) => switchVersion(message, direction),
    };
  };
  const openSearchResult = (result: SearchResult, query: string) => {
    branches.navigationVersion.current++;
    pauseFollowing();
    navigate(result.conversationId, false, result.messageId);
    setSidebarOpen(false);
    setSearchJump({
      id: result.conversationId,
      query,
      key: `${result.messageId}:${result.field}`,
      token: Date.now(),
    });
  };

  const queue = async (input: SubmitInput) => {
    const origin = selected,
      epoch = storageEpoch();
    const settings = v.safeParse(conversationSettingsSchema, conversationSettings);
    if (!settings.success) {
      setError('请先修正会话参数。');
      return;
    }
    input = {
      ...input,
      settings: settings.output,
      ...(settings.output.tools.length ? { tools: settings.output.tools } : {}),
    };
    if (!input.selection && selectedModel)
      input = {
        ...input,
        selection: { providerId: selectedModel.providerId, model: selectedModel.model },
      };
    if (input.content !== undefined && !input.revisionOf && input.parentId === undefined) {
      if (branches.index.order.length && !branches.continuationParentId) {
        setError('请选择可继续的版本，或新建对话。');
        return;
      }
      input = { ...input, parentId: branches.continuationParentId };
    }
    const requestView = input.revisionOf ?? input.retryOf ?? branches.head;
    if (requestView && requestView !== branches.head) {
      pauseFollowing();
      branches.choose(requestView);
    }
    const navigationVersion = branches.navigationVersion.current;
    const generationModel = input.selection
      ? models.find(
          (model) =>
            model.providerId === input.selection!.providerId &&
            model.model === input.selection!.model,
        )
      : selectedModel;
    const generationEffort =
      generationModel && generationModel === selectedModel
        ? reasoningEffort
        : generationModel
          ? read<ReasoningEffort | ''>(`reasoning-effort:${modelSelectionKey(generationModel)}`, '')
          : '';
    if (
      input.reasoningEffort === undefined &&
      generationModel?.reasoningSupported &&
      generationEffort &&
      generationModel.reasoningEfforts.includes(generationEffort)
    ) {
      input = { ...input, reasoningEffort: generationEffort };
    }
    if (input.tools) {
      try {
        assertWebToolSupport(generationModel?.metadata, input.tools);
        const service = navigator.onLine
          ? await queryClient.fetchQuery({
              queryKey: WEB_TOOL_SETTINGS_KEY,
              queryFn: ({ signal }) => loadWebToolSettings(signal),
              staleTime: 0,
            })
          : webToolSettings.data;
        if (!service?.hasApiKey) throw new Error('请先配置联网服务，或关闭会话中的联网工具。');
      } catch (error) {
        if (selectedRef.current === origin && storageEpoch() === epoch)
          setError(error instanceof Error ? error.message : '无法读取联网服务配置。');
        return;
      }
      if (
        selectedRef.current !== origin ||
        storageEpoch() !== epoch ||
        !sessionRef.current?.authenticated
      )
        return;
    }
    if (generationModel) {
      try {
        const config = applyConversationSettings(
          {
            ...generationModel,
            reasoningEnabled: generationModel.reasoningSupported,
            reasoningEffort: input.reasoningEffort,
            systemPrompt: generationModel.systemPrompt ?? session?.systemPrompt ?? '',
            maxOutputTokens: session?.maxOutputTokens ?? null,
            modelMetadata: generationModel.metadata,
          },
          settings.output,
        );
        const source = contextSource(snapshot.messages, input);
        const prepared = prepareChatContext(
          snapshot.messages,
          source.parentId,
          source.content,
          config,
          settings.output,
          input.retryOf ? source.images : draftImages,
          input.retryOf ? source.files : draftFiles,
        );
        if (prepared.automatic) {
          const selection = settings.output.autoCompression.model;
          const model = selection
            ? models.find((item) => modelSelectionKey(item) === modelSelectionKey(selection))
            : generationModel;
          if (!model) throw new Error('自动压缩模型不可用，请启用所选模型或关闭自动压缩。');
          summaryGeneration(snapshot.messages, prepared.automatic.throughId, {
            ...model,
            systemPrompt: '',
            maxOutputTokens: null,
            modelMetadata: model.metadata,
          });
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : '会话参数无效。');
        return;
      }
    }
    const conversation: ConversationInfo = currentConversation ?? {
      id: selected ?? crypto.randomUUID(),
      title: (
        input.content?.trim() ||
        draftImages[0]?.name ||
        draftFiles[0]?.name ||
        '新对话'
      ).slice(0, 26),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      archived: false,
    };
    const item: Pending = {
      owner: identityKey(sessionRef.current!.identity),
      conversation,
      input,
      viewHeadId: requestView,
      modelLabel: generationModel?.name || input.selection?.model,
      images: input.retryOf ? undefined : draftImages,
      files: input.retryOf ? undefined : draftFiles,
    };
    if (!commitPending([...pendingRef.current, item])) return;
    if (!conversations.some((item) => item.id === conversation.id)) {
      rememberConversation(conversation);
    }
    if (!input.retryOf) {
      writeChatCache(`draft:${selected ?? 'new'}`, { text: '' });
      setDraft('');
      setRevisionOf(undefined);
      setDraftImages([]);
      setDraftFiles([]);
    }
    if (!selected) resetNewTools();
    if (!selected) navigate(conversation.id, true);
    followRequests.current.set(input.requestId, {
      id: conversation.id,
      version: navigationVersion,
    });
    if (branches.navigationVersion.current === navigationVersion) {
      scrollToBottom();
      editor.current?.focus({ preventScroll: true });
    }
    await deliver(item);
  };
  const submit = async (event?: SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (
      (!draft.trim() && !draftImages.length && !draftFiles.length) ||
      generationBlocked ||
      !selectedModel
    )
      return;
    setError('');
    setSending(true);
    try {
      await queue({
        requestId: crypto.randomUUID(),
        content: draft.trim(),
        ...(draftFiles.length ? { fileIds: draftFiles.map((file) => file.attachmentId) } : {}),
        ...(draftImages.length ? { imageIds: draftImages.map((image) => image.attachmentId) } : {}),
        ...(revisionOf ? { revisionOf } : {}),
      });
    } finally {
      setSending(false);
    }
  };
  const queueSummary = async (input: SubmitInput) => {
    if (!selected || !currentConversation || generationBlocked || !input.summaryThrough)
      throw new Error('当前对话暂时无法压缩，请等待同步或生成完成。');
    const model = models.find(
      (model) =>
        model.providerId === input.selection?.providerId && model.model === input.selection?.model,
    );
    if (!model) throw new Error('所选摘要模型不可用。');
    summaryGeneration(snapshot.messages, input.summaryThrough, {
      ...model,
      systemPrompt: '',
      maxOutputTokens: null,
      modelMetadata: model.metadata,
    });
    const item: Pending = {
      owner: identityKey(sessionRef.current!.identity),
      conversation: currentConversation,
      input,
      viewHeadId: branches.head,
    };
    if (!commitPending([...pendingRef.current, item])) throw new Error('无法保存待发送请求。');
    await deliver(item);
  };
  const cancel = async () => {
    if (!active?.runId || !selected) return;
    try {
      await api(`/conversations/${selected}/cancel`, 'POST', { runId: active.runId });
    } catch (error) {
      setError(error instanceof Error ? error.message : '停止失败。');
    }
  };
  const retry = async (message: Message) => {
    if (message.summary) {
      if (generationBlocked) return;
      setSummaryTarget({
        throughId: message.summary.throughId,
        ...(message.providerId && message.model
          ? { selection: { providerId: message.providerId, model: message.model } }
          : {}),
      });
      setSummaryOpen(true);
      return;
    }
    if (generationBlocked) return;
    if (!selectedModel) {
      setRequestedSettingsTab('providers');
      openSettings();
      return;
    }
    setSending(true);
    try {
      await queue({
        requestId: crypto.randomUUID(),
        retryOf: message.id,
        selection: { providerId: selectedModel.providerId, model: selectedModel.model },
      });
    } finally {
      setSending(false);
    }
  };
  const edit = (message: Message) => {
    if (message.role === 'assistant') {
      setMessageMutation({ id: message.id, mode: 'edit' });
      return;
    }
    setRevisionOf(message.id);
    setDraft(messageText(message));
    setDraftImages(messageImages(message));
    setDraftFiles(messageFiles(message));
    writeChatCache(`draft:${selected}`, {
      text: messageText(message),
      revisionOf: message.id,
      images: messageImages(message),
      files: messageFiles(message),
    });
    editor.current?.focus();
  };
  const confirmMessageMutation = async (content: string, requestId: string) => {
    if (!selected || !messageMutation) return;
    if (messageMutation.mode === 'edit') {
      const version = branches.navigationVersion.current;
      const result = await api<{ messageId: string }>(
        `/conversations/${selected}/messages/${messageMutation.id}`,
        'PATCH',
        { requestId, content },
      );
      if (selectedRef.current === selected && version === branches.navigationVersion.current) {
        branches.choose(result.messageId, { automatic: true });
        scrollToBottom();
        prepareMutationFocus(selected, result.messageId, 'visible', version);
      }
      refreshLibrary();
    } else {
      const version = branches.navigationVersion.current;
      await api(`/conversations/${selected}/messages/${messageMutation.id}`, 'DELETE');
      if (selectedRef.current === selected && version === branches.navigationVersion.current)
        prepareMutationFocus(selected, messageMutation.id, 'deleted', version);
      if (revisionOf === messageMutation.id) {
        setRevisionOf(undefined);
        writeChatCache(`draft:${selected}`, {
          text: draft,
          images: draftImages,
          files: draftFiles,
        });
      }
    }
  };
  const quote = (message: Message) => {
    const source = messageText(message).trim();
    if (!source) return;
    const prefix = draft.trim() ? `${draft.trim()}\n\n` : '';
    const available = Math.max(0, 16_000 - prefix.length);
    const quoted = source
      .split(/\r?\n/u)
      .map((line) => `> ${line}`)
      .join('\n')
      .slice(0, available);
    const next = `${prefix}${quoted}`;
    setRevisionOf(undefined);
    setDraft(next);
    setError('');
    writeChatCache(`draft:${selected ?? 'new'}`, {
      text: next,
      images: draftImages,
      files: draftFiles,
    });
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(next.length, next.length);
    });
  };
  useEffect(() => {
    if (status !== 'signed-out') return;
    queryClient.clear();
    pendingRef.current = [];
    setPending([]);
    setLocalConversations([]);
    setDraft('');
    setDraftImages([]);
    setDraftFiles([]);
    setRevisionOf(undefined);
    setSettingsDraft(null);
    setNewConversationSettings({ ...DEFAULT_CONVERSATION_SETTINGS });
    setSettingsOpen(false);
    setConversationSettingsOpen(false);
  }, [status]);
  const logout = async () => {
    try {
      cancelBackup();
      const target = session?.logoutUrl ?? logoutTarget;
      setLogoutTarget(target);
      signOut();
      const channel = new BroadcastChannel('everchat-access');
      channel.postMessage('sign-out');
      channel.close();
      await clearLocal();
      pendingRef.current = [];
      setPending([]);
      setLocalConversations([]);
      queryClient.clear();
      navigate(null, true);
      setDraft('');
      setRevisionOf(undefined);
      setNewConversationSettings({ ...DEFAULT_CONVERSATION_SETTINGS });
      setSettingsDraft(null);
      setConversationSettingsOpen(false);
      returnToConversationSettings.current = false;
      setSettingsOpen(false);
      if (navigator.onLine) completeSignOut(target);
    } catch (error) {
      reportSignOutError(error instanceof Error ? error.message : '本地记录未能完全清除，请重试。');
      setSettingsOpen(false);
    }
  };
  const exportChat = (format: 'md' | 'txt' | 'html') => {
    if (!selected) return;
    const title = currentConversation?.title ?? 'EverChat';
    const confirmed = new Map(durableSnapshot.messages.map((message) => [message.id, message]));
    const messages = branches.ids.flatMap((id) => {
      const message = confirmed.get(id);
      return message && !message.deletedAt && !message.summary ? [message] : [];
    });
    exportChatFile(selected, title, messages, format);
  };
  const updateConversation = async (patch: {
    title?: string;
    pinned?: boolean;
    archived?: boolean;
  }) => {
    if (!selected) return;
    const result = await api<ConversationInfo>(`/conversations/${selected}`, 'PATCH', patch);
    queryClient.setQueryData<ConversationInfo[]>(['conversations'], (items) =>
      items?.map((item) => (item.id === result.id ? result : item)),
    );
    refreshLibrary();
  };
  const deleteConversation = async () => {
    if (!selected) return;
    const id = selected,
      result = await api<{ deletedAt: number }>(`/conversations/${id}`, 'DELETE');
    rememberDeletion(id, result.deletedAt);
    if (selectedRef.current === id) select(null);
    refreshLibrary();
  };
  const duplicateConversation = async (messageId?: string) => {
    if (!selected) return;
    const sourceId = selected,
      version = branches.navigationVersion.current;
    const path = messageId ? `/messages/${messageId}/duplicate` : '/duplicate';
    const epoch = storageEpoch(),
      key = `copy:${sourceId}:${messageId ?? branches.head ?? 'all'}`,
      requestId = read<string | null>(key, null) ?? crypto.randomUUID();
    write(key, requestId);
    let result: { id: string; viewHeadId: string | null };
    try {
      result = await api<{ id: string; viewHeadId: string | null }>(
        `/conversations/${sourceId}${path}`,
        'POST',
        {
          requestId,
          ...((messageId ?? branches.head) ? { viewHeadId: messageId ?? branches.head } : {}),
        },
      );
    } catch (error) {
      if (
        epoch === storageEpoch() &&
        error instanceof ApiError &&
        (error.code === 'copy-stopped' || (error.status >= 400 && error.status < 500))
      )
        write(key, null);
      throw error instanceof ApiError ? error : new Error('复制结果未确认，请重试查看结果。');
    }
    if (epoch !== storageEpoch()) return;
    write(key, null);
    refreshLibrary();
    if (selectedRef.current === sourceId && branches.navigationVersion.current === version) {
      branches.navigationVersion.current++;
      setEditorFocusTarget({ id: result.id });
      navigate(result.id, false, result.viewHeadId);
    }
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    setRequestedSettingsTab(undefined);
    setRequestedProviderId(undefined);
    if (!returnToConversationSettings.current)
      requestAnimationFrame(() => {
        const target = settingsTrigger.current;
        if (target?.isConnected && target.checkVisibility() && !target.closest('[inert]'))
          target.focus({ preventScroll: true });
        else if (mobileSidebarTrigger.current?.checkVisibility())
          mobileSidebarTrigger.current.focus({ preventScroll: true });
      });
    if (returnToConversationSettings.current) {
      returnToConversationSettings.current = false;
      setFocusWebTools(requestedSettingsTab === 'web-tools');
      setConversationSettingsOpen(true);
    }
  };
  if (!session)
    return (
      <AccessGate
        logoutUrl={logoutTarget}
        status={status}
        error={bootError}
        settingsState={{
          open: settingsOpen,
          tab: requestedSettingsTab,
          change: (open) => (open ? openSettings() : closeSettings()),
          selectTab: setRequestedSettingsTab,
        }}
        onRetry={() => void (status === 'signed-out' ? logout() : boot())}
      />
    );
  const statusText =
    connection === 'unavailable'
      ? '同步失败'
      : connection === 'offline'
        ? '离线'
        : connection === 'connecting'
          ? '连接中'
          : hasUnconfirmed
            ? '保存中'
            : '已同步';
  const welcome =
    !invalidRoute &&
    !syncError &&
    (!selected || (!snapshot.messages.length && !currentPending && !loading));
  return (
    <>
      <AppFrame
        sidebar={
          <Sidebar
            desktop={desktop}
            collapsed={sidebarCollapsed}
            open={sidebarOpen}
            onOpenChange={setSidebarOpen}
            trigger={mobileSidebarTrigger}
          >
            <SidebarHeader toggle={toggleSidebar} create={() => select(null)} />
            <Button
              variant="ghost"
              className="mx-3 mt-1 h-11 justify-start gap-2 px-3"
              onClick={openGlobalSearch}
              aria-label="全局搜索"
              aria-keyshortcuts={ariaShortcut('global-search')}
              title={`全局搜索（${shortcutLabel('global-search')}）`}
            >
              <Search className="h-[0.875rem] w-[0.875rem]" />
              <span className="flex-1 text-left">搜索</span>
              <kbd className="text-xs text-muted-foreground">{shortcutLabel('global-search')}</kbd>
            </Button>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2">
              <Tabs
                value={archivedList ? 'archived' : 'active'}
                onValueChange={(value) => setArchivedList(value === 'archived')}
              >
                <TabsList className="mb-1 h-auto w-full bg-transparent p-0">
                  <TabsTrigger value="active">对话</TabsTrigger>
                  <TabsTrigger value="archived">归档</TabsTrigger>
                </TabsList>
              </Tabs>
              <ul className="w-full space-y-0.5 p-0 text-sm">
                {visibleConversations.map((item, index) => (
                  <li key={item.id}>
                    {(!index ||
                      conversationGroup(item) !==
                        conversationGroup(visibleConversations[index - 1])) && (
                      <h2 className="px-3 pt-3 pb-1 text-xs font-normal text-muted-foreground">
                        {conversationGroup(item)}
                      </h2>
                    )}
                    <a
                      href={conversationUrl(item.id)}
                      onClick={(event) => {
                        if (
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        event.preventDefault();
                        select(item.id);
                      }}
                      aria-current={item.id === selected ? 'page' : undefined}
                      aria-description={
                        [
                          item.pinned ? '已置顶' : '',
                          pending.some((p) => p.conversation.id === item.id) ? '有待发送消息' : '',
                        ]
                          .filter(Boolean)
                          .join('，') || undefined
                      }
                      className="sidebar-link min-w-0 font-normal"
                    >
                      <span className="truncate">{item.title}</span>
                      {item.pinned && (
                        <Pin aria-hidden="true" className="shrink-0 h-[0.75rem] w-[0.75rem]" />
                      )}
                      {pending.some((p) => p.conversation.id === item.id) && (
                        <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                      )}
                    </a>
                  </li>
                ))}
              </ul>
              {!visibleConversations.length && libraryLoading ? (
                <div className="px-3">
                  <LoadingContent label="正在读取对话列表" />
                </div>
              ) : (
                !visibleConversations.length &&
                !libraryError && (
                  <p className="px-3 text-xs text-muted-foreground">
                    {archivedList ? '暂无归档' : '暂无对话'}
                  </p>
                )
              )}
              {libraryError && (
                <div className="flex items-center gap-2 px-3 text-xs">
                  <span role="alert">{libraryError}</span>
                  <Button variant="ghost" onClick={refreshLibrary}>
                    重试
                  </Button>
                </div>
              )}
            </div>
            <SpaceSettingsButton open={openSettings} />
          </Sidebar>
        }
        header={
          <>
            <Button
              variant="ghost"
              size="icon"
              ref={mobileSidebarTrigger}
              className={`h-11 w-11 shrink-0 ${desktop && !sidebarCollapsed ? 'hidden' : ''}`}
              onClick={toggleSidebar}
              aria-label="打开对话列表"
              aria-expanded={desktop ? !sidebarCollapsed : sidebarOpen}
            >
              <Menu className="h-[1.25rem] w-[1.25rem]" />
            </Button>
            <p
              data-testid="conversation-title"
              className="min-w-0 flex-1 truncate text-sm font-medium"
              title={currentConversation?.title}
            >
              {invalidRoute
                ? '页面不可用'
                : (currentConversation?.title ?? (selected ? '对话' : '新对话'))}
            </p>
            <div className="flex shrink-0 items-center gap-0 sm:gap-1">
              <span
                aria-live="polite"
                className="mr-3 hidden items-center gap-1.5 text-xs text-muted-foreground md:flex"
                title={
                  syncedAt
                    ? `已同步 · 上次同步 ${new Date(syncedAt).toLocaleTimeString('zh-CN')}`
                    : undefined
                }
              >
                {connection === 'offline' ? (
                  <CloudOff className="h-[0.875rem] w-[0.875rem]" />
                ) : (
                  <span
                    className="status-dot"
                    data-pending={connection !== 'connected' || hasUnconfirmed}
                  />
                )}
                <span
                  className={connection === 'connected' && !hasUnconfirmed ? 'sr-only' : undefined}
                >
                  {statusText}
                </span>
              </span>
              {canSearch && (
                <Button
                  variant="ghost"
                  size="icon"
                  ref={searchTrigger}
                  type="button"
                  aria-label="搜索当前对话"
                  aria-expanded={searchOpen}
                  aria-controls={searchOpen ? 'conversation-search' : undefined}
                  title={`搜索当前对话（${shortcutLabel('find-in-chat')}）`}
                  aria-keyshortcuts={ariaShortcut('find-in-chat')}
                  className="h-11 w-11"
                  onClick={() =>
                    searchOpen ? closeConversationSearch() : setConversationSearchFor(selected)
                  }
                >
                  <Search className="h-[1.125rem] w-[1.125rem]" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label="会话参数"
                title="会话参数"
                className="h-11 w-11 hidden md:inline-flex"
                disabled={Boolean(invalidRoute || syncError)}
                onClick={() => setConversationSettingsOpen(true)}
              >
                <SlidersHorizontal className="h-[1.125rem] w-[1.125rem]" />
              </Button>
              <ConversationActions
                key={selected ?? 'new'}
                conversation={currentConversation}
                disabled={connection === 'offline'}
                update={updateConversation}
                remove={deleteConversation}
                duplicate={duplicateConversation}
                exports={
                  <>
                    <ActionMenuItem
                      disabled={!snapshot.messages.length}
                      onSelect={() => exportChat('md')}
                    >
                      Markdown
                    </ActionMenuItem>
                    <ActionMenuItem
                      disabled={!snapshot.messages.length}
                      onSelect={() => exportChat('txt')}
                    >
                      纯文本
                    </ActionMenuItem>
                    <ActionMenuItem
                      disabled={!snapshot.messages.length}
                      onSelect={() => exportChat('html')}
                    >
                      HTML
                    </ActionMenuItem>
                    <ActionMenuSeparator />
                    <ActionMenuLabel>备份与恢复</ActionMenuLabel>
                    <ActionMenuItem
                      disabled={!currentConversation}
                      onSelect={() => void exportBackup()}
                    >
                      <Download className="size-4" />
                      下载备份
                    </ActionMenuItem>
                    <ActionMenuItem onSelect={() => backupInput.current?.click()}>
                      <Upload className="size-4" />
                      导入备份
                    </ActionMenuItem>
                  </>
                }
              >
                <ActionMenuItem
                  className="md:hidden"
                  disabled={Boolean(invalidRoute || syncError)}
                  onSelect={() => setConversationSettingsOpen(true)}
                >
                  <SlidersHorizontal className="h-[1rem] w-[1rem]" />
                  会话参数
                </ActionMenuItem>
                {session.attachmentsConfigured &&
                  selected &&
                  currentConversation &&
                  !snapshot.deletedAt && (
                    <ActionMenuItem
                      aria-label="管理对话文件"
                      onSelect={() => setAttachmentsFor(selected)}
                    >
                      <FolderOpen className="h-[1rem] w-[1rem]" />
                      对话文件
                    </ActionMenuItem>
                  )}
                {selected && latestCompletedAssistant && (
                  <ActionMenuItem
                    disabled={generationBlocked || connection === 'offline' || loading}
                    onSelect={() => {
                      setSummaryTarget(null);
                      setSummaryOpen(true);
                    }}
                  >
                    <BookOpen className="h-[1rem] w-[1rem]" />
                    压缩历史
                  </ActionMenuItem>
                )}
                <ActionMenuItem onSelect={() => setShortcutHelpOpen(true)}>
                  <Keyboard className="size-4" />
                  快捷键
                </ActionMenuItem>
              </ConversationActions>
              <input
                ref={backupInput}
                type="file"
                accept=".zip,.json,application/zip,application/json"
                className="hidden"
                onChange={(event) => void importBackup(event)}
              />
            </div>
          </>
        }
      >
        {searchOpen && (
          <ConversationSearch
            key={`${selected}:${searchJump?.token ?? ''}`}
            content={content}
            viewport={viewport}
            close={closeConversationSearch}
            initial={searchJump ?? undefined}
          />
        )}
        {connection === 'offline' && (
          <div
            role="status"
            className="flex items-center justify-center gap-2 border-b border-border bg-muted px-4 py-2 text-xs text-foreground"
          >
            <WifiOff className="h-[0.8125rem] w-[0.8125rem]" />
            你现在离线，已保存的对话仍可阅读。新消息将在联网后发送。
          </div>
        )}
        <div className="conversation-body" data-welcome={welcome}>
          <div
            ref={viewportRef}
            data-testid="message-viewport"
            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <DisclosureScope key={selected ?? 'new'}>
              {welcome ? (
                <div ref={contentRef} />
              ) : (
                <section
                  ref={contentRef}
                  aria-label="对话消息"
                  className="mx-auto w-full max-w-[49rem] space-y-6 px-4 py-4 sm:py-6"
                >
                  {loading && !snapshot.messages.length && <LoadingContent label="正在读取对话" />}
                  {branches.path.map((message) => (
                    <Fragment key={message.id}>
                      <MessageView
                        conversationId={selected!}
                        message={message}
                        busy={messageBlocked}
                        onRetry={() => void retry(message)}
                        onProviderSettings={() => {
                          setRequestedProviderId(message.providerId ?? undefined);
                          setRequestedSettingsTab('providers');
                          openSettings();
                        }}
                        onEdit={() => edit(message)}
                        onQuote={() => quote(message)}
                        onDelete={() => setMessageMutation({ id: message.id, mode: 'delete' })}
                        canRetry={liveUserIds.has(message.parentId ?? '')}
                        branch={branchNavigation(message)}
                        hasFollowing={
                          message.id === branches.head &&
                          (branches.index.children.get(message.id) ?? []).some((id) =>
                            branches.index.browsable.has(id),
                          )
                        }
                        onSelectBranch={() => selectBranch(message)}
                        onShowFollowing={() => {
                          pauseFollowing();
                          branches.choose(message.id, { descend: true });
                        }}
                        canFork={Boolean(
                          selected && connection !== 'offline' && !syncError && !loading,
                        )}
                        onFork={() => duplicateConversation(message.id)}
                      />
                      {branchSummaries.some(
                        (summary) => summary.summary!.throughId === message.id,
                      ) && (
                        <div data-testid="branch-summaries">
                          <Disclosure
                            stateKey={`summaries:${message.id}`}
                            forceOpen={branchSummaries.some(
                              (summary) =>
                                summary.summary!.throughId === message.id && isActive(summary),
                            )}
                            title={`历史摘要 · ${branchSummaries.filter((summary) => summary.summary!.throughId === message.id).length}`}
                          >
                            <div className="space-y-3">
                              {branchSummaries
                                .filter((summary) => summary.summary!.throughId === message.id)
                                .map((summary) => (
                                  <SummaryView
                                    key={summary.id}
                                    message={summary}
                                    busy={generationBlocked}
                                    onRetry={() => void retry(summary)}
                                    onProviderSettings={() => {
                                      setRequestedProviderId(summary.providerId ?? undefined);
                                      setRequestedSettingsTab('providers');
                                      openSettings();
                                    }}
                                    onDelete={() =>
                                      setMessageMutation({ id: summary.id, mode: 'delete' })
                                    }
                                    selected={previewHistory?.summary?.id === summary.id}
                                  />
                                ))}
                            </div>
                          </Disclosure>
                        </div>
                      )}
                    </Fragment>
                  ))}
                  {currentPending && pendingVisible && (
                    <article
                      data-testid="pending-message"
                      className="ml-auto max-w-[90%] rounded-2xl border border-dashed border-input bg-muted px-5 py-4"
                    >
                      <DocumentPreviews
                        conversationId={currentPending.conversation.id}
                        files={currentPending.files ?? []}
                      />
                      <ImagePreviews
                        conversationId={currentPending.conversation.id}
                        images={currentPending.images ?? []}
                      />
                      <p className="text-sm leading-7 whitespace-pre-wrap">
                        {currentPending.input.summaryThrough
                          ? '历史摘要请求'
                          : (currentPending.input.content ?? '新版本')}
                      </p>
                      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <CloudOff className="h-[0.75rem] w-[0.75rem]" />
                        {currentPending.error ? '发送失败' : '等待发送'}
                        {currentPending.modelLabel && <span>{currentPending.modelLabel}</span>}
                      </div>
                      {currentPending.error && (
                        <p className="mt-2 text-xs font-medium leading-5 text-foreground">
                          {currentPending.error}
                        </p>
                      )}
                      <div className="mt-2 flex gap-1">
                        <Button
                          variant="ghost"
                          onClick={() => {
                            const clean = { ...currentPending, error: undefined };
                            commitPending(
                              pendingRef.current.map((item) =>
                                item.input.requestId === clean.input.requestId ? clean : item,
                              ),
                            );
                            void deliver(clean);
                          }}
                        >
                          重试
                        </Button>
                        {(!currentPending.input.summaryThrough || currentPending.error) && (
                          <Button variant="ghost" onClick={() => editPending(currentPending)}>
                            {currentPending.input.summaryThrough ? '取消请求' : '编辑'}
                          </Button>
                        )}
                      </div>
                    </article>
                  )}
                </section>
              )}
            </DisclosureScope>
          </div>

          <div
            className="composer-region relative shrink-0 pt-2 pb-3"
            style={{ paddingBottom: 'max(.75rem, env(safe-area-inset-bottom))' }}
          >
            {!atBottom && (
              <Button
                variant="secondary"
                size="icon"
                className="absolute -top-12 left-1/2 z-10 border-input bg-background shadow-sm"
                aria-label="滚动到最新消息"
                onClick={scrollToBottom}
              >
                <ArrowDown className="h-[1rem] w-[1rem]" />
              </Button>
            )}
            <div className="mx-auto w-full max-w-[48.5rem]">
              {welcome && (
                <h1 className="mb-6 text-center text-xl font-semibold leading-snug sm:text-2xl">
                  今天想聊些什么？
                </h1>
              )}
              {invalidRoute && (
                <Alert variant="destructive" role="alert" className="mb-3 text-xs">
                  <span>找不到这个页面。</span>
                  <Button variant="secondary" type="button" onClick={() => select(null)}>
                    开启新对话
                  </Button>
                </Alert>
              )}
              {syncError && (
                <Alert variant="destructive" role="alert" className="mb-3 text-xs">
                  <span>{syncError}</span>
                  <Button variant="secondary" type="button" onClick={reconnect}>
                    重新同步
                  </Button>
                </Alert>
              )}
              {connectionError && !syncError && connection !== 'offline' && (
                <div className="mb-2 flex items-center gap-2 text-xs">
                  <span role="alert">{connectionError}</span>
                  <Button variant="ghost" onClick={reconnect}>
                    重新同步
                  </Button>
                </div>
              )}
              <span className="sr-only" aria-live="polite">
                {branchAnnouncement}
              </span>
              {branches.error && (
                <Alert variant="destructive" role="alert" className="mb-2 text-xs">
                  {branches.error}
                </Alert>
              )}
              {branches.notice && (
                <div role="status" className="mb-2 flex items-center gap-2 text-xs">
                  <span>{branches.notice}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="关闭分支提示"
                    onClick={branches.dismissNotice}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              )}
              {(backgroundMessage || hiddenPending) && (
                <div role="status" className="mb-2 flex items-center gap-2 text-xs">
                  <span>
                    {hiddenPending
                      ? currentPending.error
                        ? `发送失败：${currentPending.error}`
                        : currentPending.viewHeadId == null
                          ? '发送结果待确认'
                          : '另一分支等待发送'
                      : backgroundMessage && isActive(backgroundMessage)
                        ? '另一分支生成中'
                        : '另一分支已结束'}
                  </span>
                  {hiddenPending &&
                  currentPending.error &&
                  !branches.index.browsable.has(currentPending.viewHeadId ?? '') ? (
                    <Button
                      variant="ghost"
                      aria-label="编辑待发送消息"
                      onClick={() => editPending(currentPending)}
                    >
                      编辑
                    </Button>
                  ) : hiddenPending && currentPending.viewHeadId == null ? (
                    <Button variant="ghost" onClick={() => void deliver(currentPending)}>
                      重试
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const target = hiddenPending
                          ? currentPending.viewHeadId
                          : backgroundTask?.targetId;
                        if (target) {
                          pauseFollowing();
                          branches.choose(target);
                        }
                      }}
                    >
                      {backgroundMessage && !isActive(backgroundMessage) ? '查看' : '返回'}
                    </Button>
                  )}
                  {!hiddenPending && backgroundMessage && !isActive(backgroundMessage) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="关闭后台分支提示"
                      onClick={() => setBackgroundTask(null)}
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              )}
              {error && (
                <p role="alert" className="mb-3 text-xs font-medium text-foreground">
                  {error}
                </p>
              )}
              {revisionOf && (
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>编辑消息</span>
                  {!branches.ids.includes(revisionOf) && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        pauseFollowing();
                        branches.choose(revisionOf);
                      }}
                    >
                      返回原消息
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setRevisionOf(undefined);
                      writeChatCache(`draft:${selected}`, {
                        text: draft,
                        images: draftImages,
                        files: draftFiles,
                      });
                    }}
                  >
                    取消
                  </Button>
                </div>
              )}
              <form onSubmit={submit} data-testid="chat-composer" className="chat-composer">
                {selected && (draftFiles.length > 0 || draftImages.length > 0) && (
                  <div
                    data-testid="draft-previews"
                    className="draft-previews mb-2 max-h-[min(9rem,20dvh)] overflow-y-auto overscroll-contain p-1"
                  >
                    <DocumentPreviews
                      conversationId={selected}
                      files={draftFiles}
                      remove={imageProgress ? undefined : removeDocument}
                    />
                    <ImagePreviews
                      conversationId={selected}
                      images={draftImages}
                      remove={imageProgress ? undefined : removeImage}
                    />
                  </div>
                )}
                {imageProgress && (
                  <div className="flex items-center gap-2 py-2 text-xs" role="status">
                    <span className="min-w-0 flex-1 truncate">{imageProgress.name}</span>
                    <progress
                      className="progress-meter w-20 shrink-0"
                      value={imageProgress.percent}
                      max={100}
                      aria-label={imageProgress.kind === 'image' ? '图片上传进度' : '文件上传进度'}
                    />
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => imageUpload.current?.controller.abort()}
                    >
                      取消上传
                    </Button>
                  </div>
                )}
                <Textarea
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData.files);
                    if (files.length) {
                      event.preventDefault();
                      void addImages(files);
                    }
                  }}
                  ref={editor}
                  disabled={Boolean(snapshot.deletedAt)}
                  aria-label="消息"
                  className="composer-editor block min-h-11 w-full resize-none border-0 px-2 py-1 text-base leading-6 placeholder:text-muted-foreground outline-none! focus:outline-none!"
                  placeholder={active ? '生成中…' : '输入消息…'}
                  value={draft}
                  maxLength={16000}
                  rows={1}
                  onChange={(event) => updateDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                />
                <div
                  className="composer-toolbar mt-1 flex min-w-0 flex-wrap items-center gap-1"
                  data-testid="composer-toolbar"
                >
                  {session.attachmentsConfigured && (
                    <ActionMenu
                      label="添加附件"
                      icon={<Paperclip className="h-[1.125rem] w-[1.125rem]" />}
                      placement="dropdown-top dropdown-start"
                      disabled={attachmentBlocked || !navigator.onLine}
                    >
                      <ActionMenuItem
                        aria-label="添加文件"
                        disabled={draftFiles.length >= MAX_MESSAGE_DOCUMENTS}
                        onSelect={() => fileInput.current?.click()}
                      >
                        <Paperclip className="h-[1rem] w-[1rem]" />
                        文件
                      </ActionMenuItem>
                      <ActionMenuItem
                        aria-label="添加图片"
                        disabled={draftImages.length >= MAX_MESSAGE_IMAGES}
                        onSelect={() => imageInput.current?.click()}
                      >
                        <ImagePlus className="h-[1rem] w-[1rem]" />
                        图片
                      </ActionMenuItem>
                    </ActionMenu>
                  )}
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".pdf,.txt,.md,.csv,.js,.jsx,.ts,.tsx,.py,.rs,.go,.c,.cpp,.h,.css,.json,.yaml,.yml,.toml,.sh"
                    multiple
                    className="hidden"
                    aria-label="选择聊天文件"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = '';
                      void addDocuments(files);
                    }}
                  />
                  <input
                    ref={imageInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    className="hidden"
                    aria-label="选择聊天图片"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = '';
                      void addImages(files);
                    }}
                  />
                  {selectedModel ? (
                    <ModelPicker
                      focusComposer={() => editor.current?.focus({ preventScroll: true })}
                      models={models}
                      selected={selectedModel}
                      choose={(value) => {
                        setModelChoice(value);
                        write('chat-model', value);
                      }}
                    />
                  ) : (
                    <Button
                      variant="ghost"
                      type="button"
                      className="min-w-0 flex-1 text-sm"
                      onClick={() => {
                        setRequestedSettingsTab('providers');
                        openSettings();
                      }}
                    >
                      配置模型
                    </Button>
                  )}
                  {selectedModel?.reasoningSupported &&
                    selectedModel.reasoningEfforts.length > 0 && (
                      <NativeSelect
                        aria-label="思维强度"
                        title={`思维强度：${reasoningEffort ? effortLabels[reasoningEffort] : '默认'}`}
                        className="h-11 w-16 shrink-0 sm:w-24"
                        selectClassName="border-transparent pl-1 pr-5 text-xs"
                        value={reasoningEffort}
                        onChange={(event) => {
                          const value = event.target.value as ReasoningEffort | '';
                          setReasoningEffort(value);
                          write(`reasoning-effort:${modelSelectionKey(selectedModel)}`, value);
                        }}
                      >
                        <option value="">思考</option>
                        {selectedModel.reasoningEfforts.map((effort) => (
                          <option key={effort} value={effort}>
                            {effortLabels[effort]}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    className={`   h-11 w-11 shrink-0 ${conversationSettings.tools?.length ? 'bg-muted' : ''}`}
                    aria-label="联网工具"
                    aria-pressed={Boolean(conversationSettings.tools?.length)}
                    title={conversationSettings.tools?.length ? '联网已开启' : '联网工具'}
                    onClick={() => {
                      setFocusWebTools(true);
                      setConversationSettingsOpen(true);
                    }}
                  >
                    <Globe className="h-[1.125rem] w-[1.125rem]" />
                  </Button>
                  {active ? (
                    <Button
                      variant="secondary"
                      size="icon"
                      type="button"
                      className="send-button ml-auto h-11 w-11 shrink-0"
                      aria-label="停止生成"
                      title="停止生成"
                      onClick={cancel}
                      disabled={!navigator.onLine}
                    >
                      <Square className="h-[1rem] w-[1rem]" />
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      size="icon"
                      type="submit"
                      className="send-button ml-auto h-11 w-11 shrink-0"
                      aria-label="发送消息"
                      disabled={
                        (!draft.trim() && !draftImages.length && !draftFiles.length) ||
                        generationBlocked ||
                        !selectedModel
                      }
                    >
                      {sending ? <Spinner /> : <ArrowUp className="h-[1.1875rem] w-[1.1875rem]" />}
                    </Button>
                  )}
                </div>
                {contextPreview?.estimate && (
                  <ContextEstimateView
                    estimate={contextPreview.estimate}
                    compressing={contextPreview.compressing}
                  />
                )}
                {contextPreview?.error && (
                  <p className="mt-2 text-xs text-muted-foreground">{contextPreview.error}</p>
                )}
              </form>
            </div>
          </div>
        </div>
      </AppFrame>
      {globalSearchOpen && (
        <GlobalSearch
          conversations={conversations}
          loading={libraryLoading}
          error={libraryError}
          retry={refreshLibrary}
          close={() => setGlobalSearchOpen(false)}
          restoreFocus={() => {
            if (searchNavigated.current) {
              requestAnimationFrame(() => {
                const target =
                  document.querySelector<HTMLInputElement>('#conversation-search input') ??
                  editor.current;
                target?.focus({ preventScroll: true });
              });
            } else {
              const target = globalSearchReturn.current;
              if (target?.isConnected && target.checkVisibility())
                target.focus({ preventScroll: true });
              else mobileSidebarTrigger.current?.focus({ preventScroll: true });
            }
          }}
          select={(id) => {
            searchNavigated.current = true;
            setGlobalSearchOpen(false);
            select(id);
          }}
          openResult={(result, query) => {
            searchNavigated.current = true;
            setGlobalSearchOpen(false);
            openSearchResult(result, query);
          }}
        />
      )}
      <Modal open={shortcutHelpOpen} onOpenChange={setShortcutHelpOpen}>
        <div className="w-full max-w-md p-5">
          <div className="flex items-center justify-between">
            <ModalTitle>快捷键</ModalTitle>
            <Button variant="ghost" onClick={() => setShortcutHelpOpen(false)}>
              关闭
            </Button>
          </div>
          <dl className="mt-3 space-y-3 text-sm">
            {(Object.keys(commandDefinitions) as CommandId[]).map((id) => (
              <div key={id} className="flex items-center justify-between gap-3">
                <dt>{commandDefinitions[id].label}</dt>
                <dd>
                  <kbd>{shortcutLabel(id)}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Modal>
      <SettingsPanel
        open={settingsOpen}
        requestedTab={requestedSettingsTab}
        requestedProviderId={settingsOpen ? requestedProviderId : undefined}
        onTabChange={setRequestedSettingsTab}
        onSaved={providerSaved}
        themeControl={<ThemeControl />}
        onLogout={() => void logout()}
        render={(content) => (
          <SettingsDialog open={settingsOpen} close={closeSettings} restoreFocus={false}>
            {content}
          </SettingsDialog>
        )}
      />
      {backupTask && (
        <BackupProgressDialog
          title={backupTask.title}
          progress={backupTask.progress}
          cancel={() => backupOperation.current?.abort()}
          canRestoreFocus={() =>
            selectedRef.current === backupTask.route && storageEpoch() === backupTask.epoch
          }
        />
      )}
      {session?.authenticated && (
        <ConversationSettingsDialog
          key={selected ?? 'new'}
          id={selected}
          initial={
            selected
              ? (snapshot.settings ?? DEFAULT_CONVERSATION_SETTINGS)
              : newConversationSettings
          }
          model={selectedModel}
          models={models}
          effort={reasoningEffort}
          open={conversationSettingsOpen}
          focusTools={focusWebTools}
          close={() => {
            setConversationSettingsOpen(false);
            setFocusWebTools(false);
          }}
          onDraft={settingsDraftChanged}
          managePresets={() => {
            returnToConversationSettings.current = true;
            setRequestedSettingsTab('presets');
            openSettings();
          }}
          manageWebTools={() => {
            returnToConversationSettings.current = true;
            setRequestedSettingsTab('web-tools');
            openSettings();
          }}
        />
      )}
      {session.attachmentsConfigured && selected && currentConversation && !snapshot.deletedAt && (
        <AttachmentDialog
          key={`attachments:${selected}`}
          id={selected}
          open={attachmentsFor === selected}
          close={() => setAttachmentsFor(null)}
        />
      )}
      {summaryOpen && selected && (
        <SummaryDialog
          messages={snapshot.messages}
          headId={
            summaryTarget?.throughId ??
            contextSource(snapshot.messages, { parentId: branches.continuationParentId }).parentId
          }
          models={models}
          preferred={selectedModel}
          target={summaryTarget ?? undefined}
          busy={generationBlocked}
          submit={queueSummary}
          close={() => {
            setSummaryOpen(false);
            setSummaryTarget(null);
          }}
          focusComposer={() => {
            if (selectedRef.current === selected) editor.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {messageMutation && mutationMessage && (
        <MessageMutationDialog
          key={`${selected}:${messageMutation.id}:${messageMutation.mode}`}
          message={mutationMessage}
          mode={messageMutation.mode}
          affectsSummaries={snapshot.messages.some(
            (message) =>
              !message.deletedAt && message.summary?.sourceIds.includes(mutationMessage.id),
          )}
          confirm={confirmMessageMutation}
          close={() => setMessageMutation(null)}
          restoreCompletedFocus={closeMutationFocus}
        />
      )}
    </>
  );
}
