import {
  canContinueAnswer,
  CONTINUE_REQUEST,
  localAnswerText,
} from '../../shared/conversation/continuation';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp,
  BookOpen,
  CloudOff,
  Download,
  FolderOpen,
  ImagePlus,
  Keyboard,
  Menu,
  Paperclip,
  Search,
  SlidersHorizontal,
  Square,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SubmitEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import * as v from 'valibot';
import { identityKey } from '../../shared/auth/types';
import { parentKey, summariesOnBranch } from '../../shared/conversation/branches';
import { messageFiles, messageImages, messageText } from '../../shared/conversation/content';
import { contextSource } from '../../shared/conversation/context-budget';
import {
  jsonTextBytes,
  MAX_MESSAGE_TEXT_BYTES,
  messageTextFits,
  textWithinBytes,
} from '../../shared/conversation/limits';
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
import { modelSelectionKey } from '../../shared/models/selection';
import { type ModelSelection, type ReasoningEffort } from '../../shared/models/types';
import type { SearchResult } from '../../shared/search/query';
import { assertWebToolSupport, WEB_TOOL_NAMES } from '../../shared/web-tools/tasks';
import {
  ActionMenu,
  ActionMenuItem,
  ActionMenuLabel,
  ActionMenuGroup,
  ActionMenuSeparator,
} from '../components/ActionMenu';
import { Disclosure, DisclosureScope } from '../components/Disclosure';
import { hasOpenModal, Modal, ModalTitle } from '../components/Modal';
import { AttachmentDialog } from '../features/attachments/AttachmentDialog';
import { DocumentPreviews } from '../features/attachments/DocumentPreviews';
import { ImagePreviews } from '../features/attachments/ImagePreviews';
import { useChatAttachments } from '../features/attachments/useChatAttachments';
import { useFileDrop } from '../features/attachments/useFileDrop';
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
import { ChatComposer } from '../features/chat/ChatComposer';
import { AttachmentUpload } from '../features/attachments/AttachmentUpload';
import { ComposerParameters } from '../features/chat/ComposerParameters';
import { ContextEstimateNotices } from '../features/chat/ContextEstimate';
import { ConversationActions } from '../features/chat/ConversationActions';
import { ConversationNavigation } from '../features/chat/ConversationNavigation';
import { ConversationSearch } from '../features/chat/ConversationSearch';
import { ConversationSettingsDialog } from '../features/chat/ConversationSettings';
import { MessageDeleteDialog } from '../features/chat/MessageDeleteDialog';
import { MessageView } from '../features/chat/MessageView';
import { SummaryDialog } from '../features/chat/SummaryDialog';
import { SummaryView } from '../features/chat/SummaryView';
import { useBranchScrollAnchor } from '../features/chat/useBranchScrollAnchor';
import { useChatDraft } from '../features/chat/useChatDraft';
import { useChatModel } from '../features/chat/useChatModel';
import { useComposerLayout } from '../features/chat/useComposerLayout';
import { useComposerSize } from '../features/chat/useComposerSize';
import { usePromptHistory } from '../features/chat/usePromptHistory';
import { useContextPreview } from '../features/chat/useContextPreview';
import { useConversation } from '../features/chat/useConversation';
import {
  ConversationActionDialogs,
  useConversationActions,
} from '../features/chat/useConversationActions';
import { useConversationBranches } from '../features/chat/useConversationBranches';
import { ChatScrollProvider, messageScrollId, useChatScroll } from '../features/chat/ChatScroll';
import {
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
} from '@/components/ui/message-scroller';
import { useMessageNavigation } from '../features/chat/useMessageNavigation';
import { useMutationFocus } from '../features/chat/useMutationFocus';
import { useOutbox } from '../features/chat/useOutbox';
import { ConversationListItem } from '../features/library/ConversationListItem';
import { GlobalSearch } from '../features/library/GlobalSearch';
import { conversationGroup, conversationGroupLabel } from '../features/library/group-conversations';
import { Sidebar } from '../features/library/Sidebar';
import { useLibraryIndex } from '../features/library/useLibraryIndex';
import { PromptPresetPicker } from '../features/presets/PromptPresets';
import { ModelPicker } from '../features/providers/ModelPicker';
import {
  loadWebToolSettings,
  useWebToolSettings,
  WEB_TOOL_SETTINGS_KEY,
} from '../features/web-tools/web-tool-settings';
import { api, ApiError } from '../platform/api';
import { completeSignOut, pendingLogout } from '../platform/auth';
import { formatDateTime } from '../platform/i18n/format';
import {
  errorMessage,
  renderUiMessage,
  UiError,
  uiMessage,
  type UiMessage,
} from '../platform/i18n/messages';
import { useLocale } from '../platform/i18n/react';
import {
  disableNotificationsForLogout,
  startNotifications,
} from '../platform/notifications/controller';
import { useReloadBlocker } from '../platform/pwa/useReloadBlocker';
import { clearLocal, read, remove, storageEpoch, write } from '../platform/storage';
import { useMediaQuery } from '../platform/useMediaQuery';
import { AccessGate } from './AccessGate';
import { AppFrame, LoadingContent, SidebarHeader, SpaceSettingsButton } from './AppFrame';
import {
  ariaShortcut,
  commandDefinitions,
  shortcutLabel,
  useAppCommands,
  type CommandId,
} from './commands';
import './locales';
import { SettingsDialog } from './SettingsDialog';
import { SettingsPanel, type SettingsTab } from './SettingsPanel';
import { ThemeControl } from './ThemeControl';
import { conversationUrl, useConversationRoute } from './useConversationRoute';
import { useSession } from './useSession';
import { useSidebar } from './useSidebar';

const ShareDialog = lazy(() => import('../features/sharing/ShareDialog'));

type AppProps = { initialSettings?: { open: boolean; tab?: SettingsTab } };

export function App(props: AppProps = {}) {
  return (
    <ChatScrollProvider>
      <AppContent {...props} />
    </ChatScrollProvider>
  );
}

function AppContent({ initialSettings }: AppProps) {
  const { t } = useTranslation('app', { useSuspense: false });
  const { t: chatT } = useTranslation('chat', { useSuspense: false });
  useLocale();

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
  const notificationOwner = session?.identity ? identityKey(session.identity) : null;
  useEffect(
    () =>
      startNotifications(notificationOwner, (id, messageId) => {
        setSettingsOpen(false);
        setGlobalSearchOpen(false);
        setSidebarOpen(false);
        navigate(id, false, messageId);
      }),
    [notificationOwner, navigate],
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const pendingContinuations = useRef(new Set<string>());
  const { pending, pendingRef, setPending, followRequests, commitPending, deliver } = useOutbox({
    authenticated: Boolean(session?.authenticated),
    sessionRef,
    selectedRef,
    getView: () => ({ head: branches.head, version: branches.navigationVersion.current }),
    onAccepted: (accepted, item) => {
      if (item.input.continueOf) pendingContinuations.current.add(accepted.assistantId);
      branches.choose(accepted.assistantId, { automatic: true });
      if (!item.input.continueOf) scrollToBottom();
      if (item.input.revisionOf) {
        prepareMutationFocus(
          item.conversation.id,
          accepted.userId,
          'visible',
          branches.navigationVersion.current,
        );
        closeMutationFocus();
      }
    },
    onActivity: (id, activity) => observeActivity(id, activity),
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
    updateDraft,
    removeImage,
    removeDocument,
    updateDocument,
  } = chatDraft;
  const fileInput = useRef<HTMLInputElement>(null),
    imageInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setError('');
  }, [selected]);
  const [error, setError] = useState<UiMessage>('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const globalSearchReturn = useRef<HTMLElement | null>(null);
  const searchNavigated = useRef(false);
  const [sending, setSending] = useState(false);
  const { viewportRef, contentRef, viewport, content, scrollToBottom, pauseFollowing } =
    useChatScroll(selected);
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
  const touchPrimary = useMediaQuery('(hover: none) and (pointer: coarse)');
  const { toolbarRef, compact: compactComposer } = useComposerLayout();
  const [editorFocusTarget, setEditorFocusTarget] = useState<{ id: string | null } | null>(null);
  const mobileSidebarTrigger = useRef<HTMLButtonElement>(null);
  const pendingGlobalSearch = useRef(false);
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
  const [shareFor, setShareFor] = useState<string | null>(null);
  useEffect(() => {
    const open = () => {
      setRequestedSettingsTab('usage');
      openSettings();
      setSidebarOpen(false);
    };
    window.addEventListener('everchat:open-usage', open);
    return () => window.removeEventListener('everchat:open-usage', open);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(initialSettings?.open ?? false);
  const [requestedSettingsTab, setRequestedSettingsTab] = useState<SettingsTab | undefined>(
    initialSettings?.tab,
  );
  const returnToConversationSettings = useRef(false);
  const [requestedProviderId, setRequestedProviderId] = useState<string | undefined>();
  const [branchAnnouncement, setBranchAnnouncement] = useState('');
  const [backgroundTask, setBackgroundTask] = useState<{
    conversationId: string;
    messageId: string;
    targetId: string;
  } | null>(null);
  const [messageMutation, setMessageMutation] = useState<
    | {
        id: string;
        mode: 'delete';
      }
    | {
        id: string;
        mode: 'edit';
        content: string;
        requestId: string;
      }
    | null
  >(null);
  const messageMutationRef = useRef(messageMutation);
  messageMutationRef.current = messageMutation;
  const [conversationSettingsOpen, setConversationSettingsOpen] = useState(false);
  const [focusWebTools, setFocusWebTools] = useState(false);
  const toolsToggleRef = useRef<(() => void) | null>(null);
  const presetChangeRef = useRef<((prompt: string | null) => void) | null>(null);
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
    savedIds,
    activities,
    observeActivity,
    activityFresh,
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
  const { selectedModel, chooseModel } = useChatModel({
    id: selected,
    models,
    defaultSelection: session?.activeProviderId
      ? { providerId: session.activeProviderId, model: session.model }
      : undefined,
    messages: snapshot.messages,
    ready: snapshotFor === selected,
    pending: currentPending,
  });
  useEffect(() => {
    if (
      selected &&
      snapshotFor === selected &&
      authoritative &&
      connection === 'connected' &&
      durableSnapshot.activity &&
      session?.authenticated
    )
      observeActivity(selected, durableSnapshot.activity);
  }, [
    selected,
    snapshotFor,
    authoritative,
    connection,
    durableSnapshot.activity,
    observeActivity,
    session?.authenticated,
  ]);
  const branches = useConversationBranches({
    id: selected,
    messages: snapshot.messages,
    ready: snapshotFor === selected,
    authoritative,
    routeHead: routeBranch,
    navigate,
  });
  const readingNavigation = useMessageNavigation({
    conversationId: selected,
    ids: branches.ids,
    nodes: branches.index.nodes,
    viewport,
    content,
    pauseFollowing,
    scrollToBottom,
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
    draftImages,
    draftFiles,
    conversationSettings,
    selectedModel,
    models,
    reasoningEffort,
    session,
  });
  const visibleConversations = conversations;

  const { backupOperation, backupTask, exportBackup, importBackup, cancelBackup } = useBackup({
    selected,
    selectedRef,
    setError,
    providerSaved,
    refreshLibrary,
    navigate: (id) => select(id),
  });

  const editPending = (item: Pending) => {
    const original = snapshot.messages.find((message) => message.id === item.input.revisionOf);
    if (original) {
      pauseFollowing();
      branches.choose(original.id);
      beginMessageEdit(original, item.input.content ?? '');
    } else if (!item.input.summaryThrough && !item.input.retryOf && !item.input.continueOf) {
      setDraft(item.input.content ?? '');
      setDraftImages(item.images ?? []);
      setDraftFiles(item.files ?? []);
      writeChatCache(`draft:${item.conversation.id}`, {
        text: item.input.content ?? '',
        images: item.images ?? [],
        files: item.files ?? [],
      });
    }
    followRequests.current.delete(item.input.requestId);
    commitPending(
      pendingRef.current.filter((next) => next.input.requestId !== item.input.requestId),
    );
    if (!original) editor.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    setConversationSettingsOpen(false);
    setFocusWebTools(false);
  }, [selected]);
  useEffect(() => {
    setSummaryOpen(false);
    setSummaryTarget(null);
    setMessageMutation(
      selected && !deletedAt(selected)
        ? read<Extract<NonNullable<typeof messageMutation>, { mode: 'edit' }> | null>(
            `message-edit:${selected}`,
            null,
          )
        : null,
    );
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
  const promptHistory = usePromptHistory(
    `${selected ?? 'new'}:${branches.head ?? ''}`,
    branches.path,
    updateDraft,
  );
  const {
    imageUpload,
    imageProgress,
    addImages,
    addDocuments,
    addFiles,
    attachmentError,
    clearAttachmentError,
  } = useChatAttachments({
    selected,
    selectedRef,
    currentConversation,
    session,
    selectedModel,
    isBusy: () => attachmentBlocked,
    chatDraft,
    conversationSettings,
    resetNewTools,
    select: (id) => select(id, false),
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
  const draggingFiles = useFileDrop({
    canDrop: () =>
      Boolean(
        session?.authenticated &&
        session.attachmentsConfigured &&
        navigator.onLine &&
        !attachmentBlocked &&
        !messageMutation &&
        !sidebarOpen &&
        !hasOpenModal(),
      ),
    onFiles: (files) => void addFiles(files),
    onRejected: setError,
  });
  const generationBlocked =
    messageBlocked || Boolean(imageProgress) || messageMutation?.mode === 'edit';
  useReloadBlocker(
    imageProgress
      ? 'uploadBusy'
      : sending
        ? 'sendBusy'
        : backupTask
          ? 'backupBusy'
          : messageMutation
            ? 'editBusy'
            : null,
  );
  const select = (id: string | null, focusComposer = true) => {
    if (id === null) resetNewTools();
    setSearchJump(null);
    if (focusComposer) setEditorFocusTarget({ id });
    branches.navigationVersion.current++;
    navigate(id);
    setSidebarOpen(false);
  };
  const openGlobalSearch = () => {
    if (globalSearchOpen) {
      document.querySelector<HTMLInputElement>('[data-testid="global-search"] input')?.focus();
      return;
    }
    if (pendingGlobalSearch.current) return;
    globalSearchReturn.current =
      sidebarOpen && !desktop
        ? mobileSidebarTrigger.current
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    searchNavigated.current = false;
    if (sidebarOpen && !desktop) {
      pendingGlobalSearch.current = true;
      setSidebarOpen(false);
    } else setGlobalSearchOpen(true);
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
    pauseFollowing();
    if (top !== undefined) anchorBranch(selector, top, direction);
    branches.choose(target, { descend: true });
    const role = branches.index.roles.get(message.parentId),
      label =
        role === 'assistant'
          ? t(($) => $.answerVersion)
          : role === 'user'
            ? t(($) => $.questionVersion)
            : t(($) => $.branch);
    setBranchAnnouncement(
      t(($) => $.branchPosition, {
        label,
        position: position + direction + 1,
        count: choices.length,
      }),
    );
  };
  const branchNavigation = (message: Message): BranchNavigation => {
    const choices = branches.choices(message.id),
      role = branches.index.roles.get(message.parentId);
    return {
      count: choices.length,
      position: branches.index.positions.get(message.id) ?? 0,
      parent: parentKey(message.parentId),
      label:
        role === 'user'
          ? t(($) => $.questionVersion)
          : role === 'assistant'
            ? t(($) => $.answerVersion)
            : t(($) => $.branch),
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

  const queue = async (input: SubmitInput, inline = false) => {
    const reject = (message: UiMessage) => {
      if (inline) throw new UiError(message);
      setError(message);
      return false;
    };
    if (input.content !== undefined && !messageTextFits(input.content.trim())) {
      return reject(uiMessage('common', 'messageLimit'));
    }
    const origin = selected,
      epoch = storageEpoch();
    const settings = v.safeParse(conversationSettingsSchema, conversationSettings);
    if (!settings.success) {
      return reject(uiMessage('app', 'fixParameters'));
    }
    input = {
      ...input,
      settings: {
        ...settings.output,
        tools: settings.output.tools.length ? [...WEB_TOOL_NAMES] : [],
      },
      tools: settings.output.tools.length ? [...WEB_TOOL_NAMES] : undefined,
    };
    if (!input.selection && selectedModel)
      input = {
        ...input,
        selection: { providerId: selectedModel.providerId, model: selectedModel.model },
      };
    if (input.content !== undefined && !input.revisionOf && input.parentId === undefined) {
      if (branches.index.order.length && !branches.continuationParentId) {
        return reject(uiMessage('app', 'chooseBranch'));
      }
      input = { ...input, parentId: branches.continuationParentId };
    }
    const source = contextSource(snapshot.messages, input);
    const images = inline ? (source.images ?? []) : draftImages;
    const files = inline ? (source.files ?? []) : draftFiles;
    const requestView = input.revisionOf ?? input.continueOf ?? input.retryOf ?? branches.head;
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
        if (!service?.hasApiKey) throw new UiError(uiMessage('app', 'configureWebTools'));
      } catch (error) {
        if (selectedRef.current === origin && storageEpoch() === epoch)
          return reject(errorMessage(error, uiMessage('app', 'webSettingsFailed')));
        return false;
      }
      if (
        selectedRef.current !== origin ||
        storageEpoch() !== epoch ||
        !sessionRef.current?.authenticated
      )
        return false;
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
        const continuationSource = input.continueOf
          ? snapshot.messages.find((message) => message.id === input.continueOf)
          : undefined;
        const continuationQuestion = continuationSource
          ? snapshot.messages.find((message) => message.id === continuationSource.parentId)
          : undefined;
        if (
          input.continueOf &&
          (!continuationSource || !continuationQuestion || !canContinueAnswer(continuationSource))
        )
          return reject(uiMessage('chat', 'continueUnavailable'));
        const prepared = prepareChatContext(
          snapshot.messages,
          source.parentId,
          input.continueOf ? CONTINUE_REQUEST : source.content,
          config,
          settings.output,
          input.continueOf ? [] : input.retryOf ? source.images : images,
          input.continueOf ? [] : input.retryOf ? source.files : files,
          input.continueOf ? { kind: 'generated' } : undefined,
          continuationSource && continuationQuestion
            ? [
                {
                  role: 'user',
                  content: messageText(continuationQuestion),
                  images: source.images,
                  files: source.files,
                  source: { kind: 'message', messageId: continuationQuestion.id },
                },
                {
                  role: 'assistant',
                  content: messageText(continuationSource),
                  source: { kind: 'message', messageId: continuationSource.id },
                },
              ]
            : [],
        );
        if (prepared.automatic) {
          const selection = settings.output.autoCompression.model;
          const model = selection
            ? models.find((item) => modelSelectionKey(item) === modelSelectionKey(selection))
            : generationModel;
          if (!model) throw new UiError(uiMessage('app', 'compressionModelUnavailable'));
          summaryGeneration(snapshot.messages, prepared.automatic.throughId, {
            ...model,
            systemPrompt: '',
            maxOutputTokens: null,
            modelMetadata: model.metadata,
          });
        }
      } catch (error) {
        return reject(errorMessage(error, uiMessage('app', 'invalidParameters')));
      }
    }
    const conversation: ConversationInfo = currentConversation ?? {
      id: selected ?? crypto.randomUUID(),
      title: (
        input.content?.trim() ||
        draftImages[0]?.name ||
        draftFiles[0]?.name ||
        t(($) => $.untitledChat)
      ).slice(0, 26),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
    };
    const item: Pending = {
      owner: identityKey(sessionRef.current!.identity),
      conversation,
      input,
      viewHeadId: requestView,
      modelLabel: generationModel
        ? `${generationModel.providerName} · ${generationModel.name}`
        : input.selection?.model,
      images: input.retryOf || input.continueOf ? undefined : images,
      files: input.retryOf || input.continueOf ? undefined : files,
    };
    if (!commitPending([...pendingRef.current, item]))
      return reject(uiMessage('app', 'storageFull'));
    if (!selected && input.selection)
      writeChatCache(`chat-model:${conversation.id}`, modelSelectionKey(input.selection));
    if (!conversations.some((item) => item.id === conversation.id)) {
      rememberConversation(conversation);
    }
    if (!input.retryOf && !input.continueOf && !inline) {
      writeChatCache(`draft:${selected ?? 'new'}`, { text: '' });
      setDraft('');
      setDraftImages([]);
      setDraftFiles([]);
    }
    if (!selected) resetNewTools();
    if (!selected) navigate(conversation.id, true);
    followRequests.current.set(input.requestId, {
      id: conversation.id,
      version: navigationVersion,
    });
    if (!input.continueOf && branches.navigationVersion.current === navigationVersion) {
      scrollToBottom();
      if (!inline) editor.current?.focus({ preventScroll: true });
    }
    await deliver(item);
    return true;
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
    clearAttachmentError();
    setSending(true);
    try {
      await queue({
        requestId: crypto.randomUUID(),
        content: draft.trim(),
        ...(draftFiles.length
          ? {
              fileIds: draftFiles.map((file) => file.attachmentId),
              fileSelections: Object.fromEntries(
                draftFiles
                  .filter((file) => file.selection)
                  .map((file) => [file.attachmentId, file.selection!.ranges]),
              ),
            }
          : {}),
        ...(draftImages.length ? { imageIds: draftImages.map((image) => image.attachmentId) } : {}),
      });
    } finally {
      setSending(false);
    }
  };
  const queueSummary = async (input: SubmitInput) => {
    if (!selected || !currentConversation || generationBlocked || !input.summaryThrough)
      throw new UiError(uiMessage('app', 'compactionNotReady'));
    const model = models.find(
      (model) =>
        model.providerId === input.selection?.providerId && model.model === input.selection?.model,
    );
    if (!model) throw new UiError(uiMessage('app', 'summaryModelUnavailable'));
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
    if (!commitPending([...pendingRef.current, item]))
      throw new UiError(uiMessage('app', 'pendingSaveFailed'));
    await deliver(item);
  };
  const cancel = async () => {
    if (!active?.runId || !selected) return;
    try {
      await api(`/conversations/${selected}/cancel`, 'POST', { runId: active.runId });
    } catch (error) {
      setError(errorMessage(error, uiMessage('app', 'stopFailed')));
    }
  };
  useEffect(() => {
    for (const answer of snapshot.messages) {
      if (!pendingContinuations.current.has(answer.id) || isActive(answer)) continue;
      pendingContinuations.current.delete(answer.id);
      if (
        answer.id === branches.head &&
        answer.continuation &&
        (answer.status === 'failed' || answer.status === 'cancelled') &&
        !localAnswerText(answer).trim()
      ) {
        const source = snapshot.messages.find(
          (message) => message.id === answer.continuation!.sourceId,
        );
        if (source && !source.deletedAt) branches.choose(source.id, { automatic: true });
      }
    }
  }, [snapshot.messages, branches.head]);
  const continueLocks = useRef(new Set<string>());
  const continueAnswer = async (message: Message) => {
    if (generationBlocked || !navigator.onLine || !canContinueAnswer(message)) return;
    if (!selectedModel) {
      setRequestedSettingsTab('providers');
      openSettings();
      return;
    }
    if (continueLocks.current.has(message.id)) return;
    continueLocks.current.add(message.id);
    const navigationVersion = branches.navigationVersion.current;
    try {
      const bytes = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(messageText(message)),
      );
      const sourceTextSha256 = Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      if (
        selectedRef.current !== selected ||
        branches.navigationVersion.current !== navigationVersion
      )
        return;
      await queue({ requestId: crypto.randomUUID(), continueOf: message.id, sourceTextSha256 });
    } catch (error) {
      if (selectedRef.current === selected)
        setError(errorMessage(error, uiMessage('app', 'sendFailed')));
    } finally {
      continueLocks.current.delete(message.id);
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
  const beginMessageEdit = (message: Message, content = messageText(message)) => {
    const value = {
      id: message.id,
      mode: 'edit' as const,
      content,
      requestId: crypto.randomUUID(),
    };
    setMessageMutation(value);
    writeChatCache(`message-edit:${selected}`, value);
  };
  const edit = (message: Message) => {
    pauseFollowing();
    beginMessageEdit(message);
  };
  const closeMessageEdit = () => {
    const id = messageMutation?.id;
    remove([`message-edit:${selected}`]);
    setMessageMutation(null);
    requestAnimationFrame(() => {
      if (selectedRef.current === selected) {
        const target =
          document.querySelector<HTMLButtonElement>(
            `[data-message-id="${id}"] [data-message-edit]`,
          ) ?? editor.current;
        target?.focus({ preventScroll: true });
      }
    });
  };
  const confirmMessageMutation = async (content: string, requestId: string) => {
    if (!selected || !messageMutation) return;
    if (messageMutation.mode === 'edit') {
      if (mutationMessage?.role === 'user') {
        if (messageBlocked || !selectedModel)
          throw new UiError(uiMessage('app', 'waitForSyncAndModel'));
        if (
          !(await queue(
            {
              requestId,
              content,
              revisionOf: messageMutation.id,
              imageIds: messageImages(mutationMessage).map((image) => image.attachmentId),
              fileIds: messageFiles(mutationMessage).map((file) => file.attachmentId),
              fileSelections: Object.fromEntries(
                messageFiles(mutationMessage)
                  .filter((file) => file.selection)
                  .map((file) => [file.attachmentId, file.selection!.ranges]),
              ),
            },
            true,
          ))
        )
          throw new UiError(uiMessage('app', 'conversationChanged'));
        return;
      }
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
    }
  };
  const quote = (message: Message) => {
    const source = messageText(message).trim();
    if (!source) return;
    const prefix = draft.trim() ? `${draft.trim()}\n\n` : '';
    const available = Math.max(0, MAX_MESSAGE_TEXT_BYTES - jsonTextBytes(prefix));
    const quoted = source
      .split(/\r?\n/u)
      .map((line) => `> ${line}`)
      .join('\n');
    const next = `${prefix}${textWithinBytes(quoted, available)}`;
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
    setSettingsDraft(null);
    setMessageMutation(null);
    setNewConversationSettings({ ...DEFAULT_CONVERSATION_SETTINGS });
    setSettingsOpen(false);
    setConversationSettingsOpen(false);
  }, [status]);
  const logout = async () => {
    try {
      cancelBackup();
      const target = session?.logoutUrl ?? logoutTarget;
      setLogoutTarget(target);
      await disableNotificationsForLogout();
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
      setNewConversationSettings({ ...DEFAULT_CONVERSATION_SETTINGS });
      setSettingsDraft(null);
      setConversationSettingsOpen(false);
      returnToConversationSettings.current = false;
      setSettingsOpen(false);
      if (navigator.onLine) completeSignOut(target);
    } catch (error) {
      reportSignOutError(errorMessage(error, uiMessage('app', 'clearDataFailed')));
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
  const updateConversation = async (
    id: string,
    patch: {
      title?: string;
      pinned?: boolean;
    },
  ) => {
    const epoch = storageEpoch();
    const result = await api<ConversationInfo>(`/conversations/${id}`, 'PATCH', patch);
    if (epoch !== storageEpoch()) return;
    queryClient.setQueryData<ConversationInfo[]>(['conversations'], (items) =>
      items?.map((item) => (item.id === result.id ? result : item)),
    );
    refreshLibrary();
  };
  const deleteConversation = async (id: string) => {
    const epoch = storageEpoch();
    const result = await api<{ deletedAt: number }>(`/conversations/${id}`, 'DELETE');
    if (epoch !== storageEpoch()) return;
    rememberDeletion(id, result.deletedAt);
    const deletedCurrent = selectedRef.current === id;
    if (deletedCurrent) select(null);
    refreshLibrary();
    if (deletedCurrent) return 'composer' as const;
  };
  const duplicateConversation = async (sourceId: string, messageId?: string) => {
    const origin = selectedRef.current,
      version = branches.navigationVersion.current,
      head =
        messageId ??
        (sourceId === origin
          ? branches.head
          : read<string | null>(`branch-view:${sourceId}`, null));
    const path = messageId ? `/messages/${messageId}/duplicate` : '/duplicate';
    const epoch = storageEpoch(),
      key = `copy:${sourceId}:${head ?? 'all'}`,
      requestId = read<string | null>(key, null) ?? crypto.randomUUID();
    write(key, requestId);
    let result: { id: string; viewHeadId: string | null };
    try {
      result = await api<{ id: string; viewHeadId: string | null }>(
        `/conversations/${sourceId}${path}`,
        'POST',
        {
          requestId,
          ...(head ? { viewHeadId: head } : {}),
        },
      );
    } catch (error) {
      if (
        epoch === storageEpoch() &&
        error instanceof ApiError &&
        (error.code === 'copy-stopped' || (error.status >= 400 && error.status < 500))
      )
        write(key, null);
      throw error instanceof ApiError ? error : new UiError(uiMessage('app', 'copyUnconfirmed'));
    }
    if (epoch !== storageEpoch()) return;
    write(key, null);
    refreshLibrary();
    if (selectedRef.current === origin && branches.navigationVersion.current === version) {
      branches.navigationVersion.current++;
      setEditorFocusTarget({ id: result.id });
      navigate(result.id, false, result.viewHeadId);
    }
  };

  const conversationActions = useConversationActions({
    share: (id) => {
      if (id !== selected) select(id, false);
      setShareFor(id);
      setSidebarOpen(false);
    },
    enabled: Boolean(session?.authenticated),
    update: updateConversation,
    remove: deleteConversation,
    duplicate: duplicateConversation,
    titleConfigured: session?.titleModelConfigured,
    generateTitle: async (id) => {
      await api(`/conversations/${id}/title`, 'POST', { requestId: crypto.randomUUID() });
      refreshLibrary();
    },
    copyLink: async (id) => {
      const head = id === selected ? branches.head : read<string | null>(`branch-view:${id}`, null);
      await navigator.clipboard.writeText(`${location.origin}${conversationUrl(id, head)}`);
    },
    viewTask: (id, activity) => {
      branches.navigationVersion.current++;
      pauseFollowing();
      setSearchJump(null);
      navigate(id, false, activity.messageId);
      setSidebarOpen(false);
    },
    stopTask: async (id, activity) => {
      const epoch = storageEpoch();
      const result = await api<{
        activity?: import('../../shared/conversation/activity').ConversationActivity;
      }>(`/conversations/${id}/cancel`, 'POST', { runId: activity.runId });
      if (epoch !== storageEpoch()) return;
      if (result.activity) observeActivity(id, result.activity);
      refreshLibrary();
    },
    beforeDialog: () => setSidebarOpen(false),
    restoreFocus: (preferComposer) => {
      const target = preferComposer
        ? editor.current
        : !desktop
          ? mobileSidebarTrigger.current
          : (document.querySelector<HTMLElement>('[data-conversation-row] a') ?? editor.current);
      target?.focus({ preventScroll: true });
    },
  });

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
      ? t(($) => $.syncFailed)
      : connection === 'offline'
        ? t(($) => $.offline)
        : connection === 'connecting'
          ? t(($) => $.connecting)
          : hasUnconfirmed
            ? t(($) => $.savingShort)
            : t(($) => $.synced);
  const welcome =
    !invalidRoute &&
    !syncError &&
    (!selected || (!snapshot.messages.length && !currentPending && !loading));
  return (
    <>
      <AppFrame
        dropOverlay={
          draggingFiles ? (
            <div className="file-drop-overlay" role="status" data-testid="file-drop-overlay">
              <div>{t(($) => $.dropFiles)}</div>
            </div>
          ) : undefined
        }
        sidebar={
          <Sidebar
            desktop={desktop}
            collapsed={sidebarCollapsed}
            open={sidebarOpen}
            onOpenChange={setSidebarOpen}
            trigger={mobileSidebarTrigger}
            onClosed={() => {
              if (!pendingGlobalSearch.current) return false;
              pendingGlobalSearch.current = false;
              setGlobalSearchOpen(true);
              return true;
            }}
          >
            <SidebarHeader toggle={toggleSidebar} create={() => select(null)} />
            <Button
              variant="ghost"
              className="mx-3 mt-1 min-h-[44px] h-auto shrink-0 justify-start gap-2 px-3 py-1"
              onClick={openGlobalSearch}
              aria-label={t(($) => $.globalSearch)}
              aria-keyshortcuts={ariaShortcut('global-search')}
              title={t(($) => $.globalSearchShortcut, { shortcut: shortcutLabel('global-search') })}
            >
              <Search className="h-[0.875rem] w-[0.875rem]" />
              <span className="min-w-0 flex-1 truncate text-left">{t(($) => $.search)}</span>
              <kbd className="shrink-0 text-xs text-muted-foreground">
                {shortcutLabel('global-search')}
              </kbd>
            </Button>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2">
              <ul className="w-full space-y-0.5 p-0 text-sm">
                {visibleConversations.map((item, index) => (
                  <li key={item.id} data-conversation-row={item.id}>
                    {(!index ||
                      conversationGroup(item) !==
                        conversationGroup(visibleConversations[index - 1])) && (
                      <h2 className="px-3 pt-3 pb-1 text-xs font-normal text-muted-foreground">
                        {conversationGroupLabel(conversationGroup(item))}
                      </h2>
                    )}
                    <ConversationListItem
                      conversation={item}
                      selected={item.id === selected}
                      pending={pending.find((p) => p.conversation.id === item.id)}
                      saved={savedIds.has(item.id)}
                      activity={activities[item.id]}
                      fresh={
                        activityFresh(item.id) ||
                        Boolean(
                          item.id === selected &&
                          snapshotFor === selected &&
                          authoritative &&
                          connection === 'connected' &&
                          durableSnapshot.activity?.version === activities[item.id]?.version,
                        )
                      }
                      disabled={!navigator.onLine || !session.authenticated}
                      actions={conversationActions}
                      select={() => select(item.id)}
                    />
                  </li>
                ))}
              </ul>
              {!visibleConversations.length && libraryLoading ? (
                <div className="px-3">
                  <LoadingContent label={t(($) => $.loadingConversations)} />
                </div>
              ) : (
                !visibleConversations.length &&
                !libraryError && (
                  <p className="px-3 text-xs text-muted-foreground">{t(($) => $.noChats)}</p>
                )
              )}
              {libraryError && (
                <div className="flex items-center gap-2 px-3 text-xs">
                  <span role="alert">{renderUiMessage(libraryError)}</span>
                  <Button variant="ghost" onClick={refreshLibrary}>
                    {t(($) => $.retry)}
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
              aria-label={t(($) => $.openSidebar)}
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
                ? t(($) => $.pageUnavailable)
                : (currentConversation?.title ??
                  (selected ? t(($) => $.chat) : t(($) => $.untitledChat)))}
            </p>
            {!selected && !invalidRoute && session?.authenticated && (
              <PromptPresetPicker
                compact
                open
                prompt={conversationSettings.systemPrompt}
                apply={(prompt) => presetChangeRef.current?.(prompt)}
                manage={() => {
                  setRequestedSettingsTab('presets');
                  openSettings();
                }}
              />
            )}
            <div className="flex shrink-0 items-center gap-0 sm:gap-1">
              <span
                aria-live="polite"
                className="mr-3 hidden items-center gap-1.5 text-xs text-muted-foreground md:flex"
                title={
                  syncedAt
                    ? t(($) => $.lastSynced, {
                        time: formatDateTime(syncedAt, {
                          hour: 'numeric',
                          minute: '2-digit',
                          second: '2-digit',
                        }),
                      })
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
                  aria-label={t(($) => $.findInChat)}
                  aria-expanded={searchOpen}
                  aria-controls={searchOpen ? 'conversation-search' : undefined}
                  title={t(($) => $.findInChatShortcut, {
                    shortcut: shortcutLabel('find-in-chat'),
                  })}
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
                aria-label={t(($) => $.parameters)}
                title={t(($) => $.parameters)}
                className="h-11 w-11 hidden md:inline-flex"
                disabled={Boolean(invalidRoute || syncError)}
                onClick={() => setConversationSettingsOpen(true)}
              >
                <SlidersHorizontal className="h-[1.125rem] w-[1.125rem]" />
              </Button>
              <ConversationActions
                key={selected ?? 'new'}
                conversation={currentConversation}
                activity={selected ? activities[selected] : undefined}
                disabled={!navigator.onLine || !session.authenticated}
                actions={conversationActions}
                exports={
                  <>
                    <ActionMenuGroup>
                      <ActionMenuLabel>{chatT(($) => $.export)}</ActionMenuLabel>
                      <ActionMenuItem
                        disabled={!snapshot.messages.length}
                        onClick={() => exportChat('md')}
                      >
                        Markdown
                      </ActionMenuItem>
                      <ActionMenuItem
                        disabled={!snapshot.messages.length}
                        onClick={() => exportChat('txt')}
                      >
                        {t(($) => $.plainText)}
                      </ActionMenuItem>
                      <ActionMenuItem
                        disabled={!snapshot.messages.length}
                        onClick={() => exportChat('html')}
                      >
                        HTML
                      </ActionMenuItem>
                    </ActionMenuGroup>
                    <ActionMenuSeparator />
                    <ActionMenuGroup>
                      <ActionMenuLabel>{t(($) => $.backupRestore)}</ActionMenuLabel>
                      <ActionMenuItem
                        disabled={!currentConversation}
                        onClick={() => void exportBackup()}
                      >
                        <Download className="size-4" />
                        {t(($) => $.downloadBackup)}
                      </ActionMenuItem>
                      <ActionMenuItem onClick={() => backupInput.current?.click()}>
                        <Upload className="size-4" />
                        {t(($) => $.importBackup)}
                      </ActionMenuItem>
                    </ActionMenuGroup>
                  </>
                }
              >
                <ActionMenuItem
                  className="md:hidden"
                  disabled={Boolean(invalidRoute || syncError)}
                  onClick={() => setConversationSettingsOpen(true)}
                >
                  <SlidersHorizontal className="h-[1rem] w-[1rem]" />
                  {t(($) => $.parameters)}
                </ActionMenuItem>
                {session.attachmentsConfigured &&
                  selected &&
                  currentConversation &&
                  !snapshot.deletedAt && (
                    <ActionMenuItem
                      aria-label={t(($) => $.manageFiles)}
                      onClick={() => setAttachmentsFor(selected)}
                    >
                      <FolderOpen className="h-[1rem] w-[1rem]" />
                      {t(($) => $.chatFiles)}
                    </ActionMenuItem>
                  )}
                {selected && latestCompletedAssistant && (
                  <ActionMenuItem
                    disabled={generationBlocked || connection === 'offline' || loading}
                    onClick={() => {
                      setSummaryTarget(null);
                      setSummaryOpen(true);
                    }}
                  >
                    <BookOpen className="h-[1rem] w-[1rem]" />
                    {t(($) => $.compactHistory)}
                  </ActionMenuItem>
                )}
                <ActionMenuItem onClick={() => setShortcutHelpOpen(true)}>
                  <Keyboard className="size-4" />
                  {t(($) => $.shortcuts)}
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
            {t(($) => $.offlineHint)}
          </div>
        )}
        <div className="conversation-body" data-welcome={welcome}>
          <MessageScroller
            className="conversation-viewport relative min-h-0 flex-1"
            data-navigation={readingNavigation.visible || undefined}
          >
            <MessageScrollerViewport
              ref={viewportRef}
              aria-label={t(($) => $.chatMessages)}
              data-testid="message-viewport"
              className="relative h-full min-h-0 overflow-y-auto overscroll-contain"
            >
              <DisclosureScope key={selected ?? 'new'}>
                {welcome ? (
                  <MessageScrollerContent ref={contentRef} role="presentation" />
                ) : (
                  <MessageScrollerContent
                    ref={contentRef}
                    role="presentation"
                    className="conversation-messages mx-auto w-full max-w-[49rem] gap-6 px-4"
                  >
                    {loading && !snapshot.messages.length && (
                      <MessageScrollerItem messageId="loading">
                        <LoadingContent label={t(($) => $.loadingChat)} />
                      </MessageScrollerItem>
                    )}
                    {branches.path.map((message) => (
                      <Fragment key={message.id}>
                        <MessageScrollerItem
                          messageId={messageScrollId(message.id)}
                          data-scroll-id={messageScrollId(message.id)}
                        >
                          <MessageView
                            navigationRef={
                              message.role === 'assistant' && !message.deletedAt
                                ? readingNavigation.refFor(message.id)
                                : undefined
                            }
                            conversationId={selected!}
                            message={message}
                            providerName={session?.providerNames?.[message.providerId ?? '']}
                            providerNames={session?.providerNames}
                            busy={messageBlocked || Boolean(messageMutation)}
                            onRetry={() => void retry(message)}
                            onContinue={() => void continueAnswer(message)}
                            onProviderSettings={() => {
                              setRequestedProviderId(message.providerId ?? undefined);
                              setRequestedSettingsTab('providers');
                              openSettings();
                            }}
                            onEdit={() => edit(message)}
                            editing={
                              messageMutation?.mode === 'edit' && messageMutation.id === message.id
                                ? {
                                    content: messageMutation.content,
                                    change: (content) => {
                                      const value = {
                                        ...messageMutation,
                                        content,
                                        requestId: crypto.randomUUID(),
                                      };
                                      setMessageMutation(value);
                                      writeChatCache(`message-edit:${selected}`, value);
                                    },
                                    save: async () => {
                                      await confirmMessageMutation(
                                        messageMutation.content,
                                        messageMutation.requestId,
                                      );
                                      if (
                                        read<{ requestId?: string }>(`message-edit:${selected}`, {})
                                          .requestId === messageMutation.requestId
                                      )
                                        remove([`message-edit:${selected}`]);
                                      if (
                                        selectedRef.current === selected &&
                                        messageMutationRef.current?.mode === 'edit' &&
                                        messageMutationRef.current.requestId ===
                                          messageMutation.requestId
                                      ) {
                                        setMessageMutation(null);
                                      }
                                      closeMutationFocus();
                                    },
                                    cancel: closeMessageEdit,
                                  }
                                : undefined
                            }
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
                            onFork={() =>
                              selected
                                ? duplicateConversation(selected, message.id)
                                : Promise.resolve()
                            }
                          />
                        </MessageScrollerItem>
                        {branchSummaries.some(
                          (summary) => summary.summary!.throughId === message.id,
                        ) && (
                          <>
                            <MessageScrollerItem messageId={`marker:${message.id}`}>
                              <Marker
                                variant="separator"
                                className="my-3"
                                data-testid="history-compressed"
                              >
                                <MarkerContent>{t(($) => $.historyCompressed)}</MarkerContent>
                              </Marker>
                            </MessageScrollerItem>
                            {branchSummaries
                              .filter((summary) => summary.summary!.throughId === message.id)
                              .map((summary) => (
                                <MessageScrollerItem
                                  key={summary.id}
                                  messageId={`summary:${summary.id}`}
                                  data-scroll-id={`summary:${summary.id}`}
                                >
                                  <SummaryView
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
                                </MessageScrollerItem>
                              ))}
                          </>
                        )}
                      </Fragment>
                    ))}
                    {currentPending && pendingVisible && (
                      <MessageScrollerItem messageId={`pending:${currentPending.input.requestId}`}>
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
                              ? t(($) => $.summaryRequest)
                              : currentPending.input.continueOf
                                ? renderUiMessage(uiMessage('chat', 'continueAnswer'))
                                : (currentPending.input.content ?? t(($) => $.newVersion))}
                          </p>
                          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                            <CloudOff className="h-[0.75rem] w-[0.75rem]" />
                            <span>
                              {currentPending.error
                                ? t(($) => $.sendFailed)
                                : t(($) => $.waitingToSend)}
                            </span>
                            {currentPending.modelLabel && <span>{currentPending.modelLabel}</span>}
                          </div>
                          {currentPending.error && (
                            <p className="mt-2 text-xs font-medium leading-5 text-foreground">
                              {renderUiMessage(currentPending.error)}
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
                              {t(($) => $.retry)}
                            </Button>
                            {(!currentPending.input.summaryThrough || currentPending.error) && (
                              <Button variant="ghost" onClick={() => editPending(currentPending)}>
                                {currentPending.input.summaryThrough
                                  ? t(($) => $.cancelRequest)
                                  : t(($) => $.edit)}
                              </Button>
                            )}
                          </div>
                        </article>
                      </MessageScrollerItem>
                    )}
                  </MessageScrollerContent>
                )}
              </DisclosureScope>
            </MessageScrollerViewport>
            <ConversationNavigation
              key={selected ?? 'new'}
              viewport={viewport}
              {...readingNavigation}
            />
          </MessageScroller>

          <div
            className="composer-region relative shrink-0 pt-2 pb-3"
            style={{ paddingBottom: 'max(.75rem, env(safe-area-inset-bottom))' }}
          >
            <div className="mx-auto w-full max-w-[48.5rem]">
              {welcome && (
                <h1 className="mb-6 text-center text-xl font-semibold leading-snug sm:text-2xl">
                  {t(($) => $.welcome)}
                </h1>
              )}
              {invalidRoute && (
                <Alert variant="destructive" role="alert" className="mb-3 text-xs">
                  <span>{t(($) => $.pageNotFound)}</span>
                  <Button variant="secondary" type="button" onClick={() => select(null)}>
                    {t(($) => $.newChat)}
                  </Button>
                </Alert>
              )}
              {syncError && (
                <Alert variant="destructive" role="alert" className="mb-3 text-xs">
                  <span>{renderUiMessage(syncError)}</span>
                  <Button variant="secondary" type="button" onClick={reconnect}>
                    {t(($) => $.resync)}
                  </Button>
                </Alert>
              )}
              {connectionError && !syncError && connection !== 'offline' && (
                <div className="mb-2 flex items-center gap-2 text-xs">
                  <span role="alert">{renderUiMessage(connectionError)}</span>
                  <Button variant="ghost" onClick={reconnect}>
                    {t(($) => $.resync)}
                  </Button>
                </div>
              )}
              <span className="sr-only" aria-live="polite">
                {branchAnnouncement}
              </span>
              {branches.error && (
                <Alert variant="destructive" role="alert" className="mb-2 text-xs">
                  {renderUiMessage(branches.error)}
                </Alert>
              )}
              {branches.notice && (
                <div role="status" className="mb-2 flex items-center gap-2 text-xs">
                  <span>{renderUiMessage(branches.notice)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t(($) => $.closeBranchNotice)}
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
                        ? t(($) => $.sendFailedDetail, {
                            error: renderUiMessage(currentPending.error),
                          })
                        : currentPending.viewHeadId == null
                          ? t(($) => $.sendUnconfirmed)
                          : t(($) => $.otherBranchPending)
                      : backgroundMessage && isActive(backgroundMessage)
                        ? t(($) => $.otherBranchGenerating)
                        : t(($) => $.otherBranchFinished)}
                  </span>
                  {hiddenPending &&
                  currentPending.error &&
                  !branches.index.browsable.has(currentPending.viewHeadId ?? '') ? (
                    <Button
                      variant="ghost"
                      aria-label={t(($) => $.editPendingMessage)}
                      onClick={() => editPending(currentPending)}
                    >
                      {t(($) => $.edit)}
                    </Button>
                  ) : hiddenPending && currentPending.viewHeadId == null ? (
                    <Button variant="ghost" onClick={() => void deliver(currentPending)}>
                      {t(($) => $.retry)}
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
                      {backgroundMessage && !isActive(backgroundMessage)
                        ? t(($) => $.view)
                        : t(($) => $.return)}
                    </Button>
                  )}
                  {!hiddenPending && backgroundMessage && !isActive(backgroundMessage) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t(($) => $.closeBackgroundNotice)}
                      onClick={() => setBackgroundTask(null)}
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              )}
              {(error || attachmentError) && (
                <p role="alert" className="mb-3 text-xs font-medium text-foreground">
                  {renderUiMessage(error || attachmentError)}
                </p>
              )}
              {messageMutation?.mode === 'edit' &&
                (!branches.ids.includes(messageMutation.id) || mutationMessage?.deletedAt) && (
                  <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {mutationMessage?.deletedAt
                        ? t(($) => $.originalDeleted)
                        : t(($) => $.editingUnfinished)}
                    </span>
                    <Button
                      variant="ghost"
                      disabled={Boolean(mutationMessage?.deletedAt)}
                      onClick={() => {
                        pauseFollowing();
                        branches.choose(messageMutation.id);
                      }}
                    >
                      {t(($) => $.returnToOriginal)}
                    </Button>
                    <Button variant="ghost" onClick={closeMessageEdit}>
                      {t(($) => $.cancelEditing)}
                    </Button>
                  </div>
                )}
              <ChatComposer
                onSubmit={submit}
                attachments={
                  selected &&
                  (draftFiles.length > 0 || draftImages.length > 0) && (
                    <div
                      data-testid="draft-previews"
                      className="draft-previews mb-2 max-h-[min(9rem,20dvh)] overflow-y-auto overscroll-contain p-1"
                    >
                      <DocumentPreviews
                        conversationId={selected}
                        files={draftFiles}
                        onChange={imageProgress ? undefined : updateDocument}
                        budgetFor={(file) =>
                          contextPreview?.estimate
                            ? Math.max(
                                0,
                                file.tokens +
                                  contextPreview.estimate.inputBudget -
                                  contextPreview.estimate.totalTokens,
                              )
                            : undefined
                        }
                        remove={imageProgress ? undefined : removeDocument}
                      />
                      <ImagePreviews
                        conversationId={selected}
                        images={draftImages}
                        remove={imageProgress ? undefined : removeImage}
                      />
                    </div>
                  )
                }
                upload={
                  imageProgress && (
                    <AttachmentUpload
                      progress={imageProgress}
                      cancel={() => imageUpload.current?.controller.abort()}
                    />
                  )
                }
                input={
                  <InputGroupTextarea
                    onPaste={(event) => {
                      const files = Array.from(event.clipboardData.files);
                      if (files.length) {
                        event.preventDefault();
                        void addImages(files);
                      }
                    }}
                    ref={editor}
                    disabled={Boolean(snapshot.deletedAt)}
                    aria-label={t(($) => $.message)}
                    className="composer-editor block min-h-11 w-full resize-none border-0 px-2 py-1 text-base leading-6 placeholder:text-muted-foreground outline-none! focus:outline-none!"
                    placeholder={active ? t(($) => $.generating) : t(($) => $.messagePlaceholder)}
                    value={draft}
                    maxLength={MAX_MESSAGE_TEXT_BYTES}
                    rows={1}
                    enterKeyHint={touchPrimary ? 'enter' : 'send'}
                    onChange={promptHistory.onChange}
                    onKeyDown={(event) => {
                      if (promptHistory.onKeyDown(event)) return;
                      if (
                        !touchPrimary &&
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing &&
                        // WebKit may clear isComposing before the IME confirmation keydown.
                        event.nativeEvent.keyCode !== 229
                      ) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                  />
                }
                toolbarRef={toolbarRef}
                compact={compactComposer}
                toolbar={
                  <>
                    {session.attachmentsConfigured && (
                      <ActionMenu
                        label={t(($) => $.addAttachment)}
                        icon={<Paperclip className="h-[1.125rem] w-[1.125rem]" />}
                        placement="dropdown-top dropdown-start"
                        className="composer-icon"
                        disabled={attachmentBlocked || !navigator.onLine}
                      >
                        <ActionMenuItem
                          aria-label={t(($) => $.addFile)}
                          onClick={() => fileInput.current?.click()}
                        >
                          <Paperclip className="h-[1rem] w-[1rem]" />
                          {t(($) => $.file)}
                        </ActionMenuItem>
                        <ActionMenuItem
                          aria-label={t(($) => $.addImage)}
                          onClick={() => imageInput.current?.click()}
                        >
                          <ImagePlus className="h-[1rem] w-[1rem]" />
                          {t(($) => $.image)}
                        </ActionMenuItem>
                      </ActionMenu>
                    )}
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".pdf,.txt,.typ,.md,.csv,.js,.jsx,.ts,.tsx,.py,.rs,.go,.c,.cpp,.h,.css,.json,.yaml,.yml,.toml,.sh"
                      multiple
                      className="hidden"
                      aria-label={t(($) => $.chooseChatFiles)}
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
                      aria-label={t(($) => $.chooseChatImages)}
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
                        choose={chooseModel}
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
                        {t(($) => $.configureModels)}
                      </Button>
                    )}
                    <ComposerParameters
                      compact={compactComposer}
                      model={selectedModel}
                      effort={reasoningEffort}
                      chooseEffort={(value) => {
                        setReasoningEffort(value);
                        if (selectedModel)
                          write(`reasoning-effort:${modelSelectionKey(selectedModel)}`, value);
                      }}
                      webEnabled={Boolean(conversationSettings.tools?.length)}
                      toggleWeb={() => toolsToggleRef.current?.()}
                      estimate={contextPreview?.estimate}
                      focusComposer={() => editor.current?.focus({ preventScroll: true })}
                    />
                    {active ? (
                      <InputGroupButton
                        variant="secondary"
                        size="icon-sm"
                        type="button"
                        className="composer-icon send-button ml-auto"
                        aria-label={t(($) => $.stopGenerating)}
                        title={t(($) => $.stopGenerating)}
                        onClick={cancel}
                        disabled={!navigator.onLine}
                      >
                        <Square className="h-[1rem] w-[1rem]" />
                      </InputGroupButton>
                    ) : (
                      <InputGroupButton
                        variant="default"
                        size="icon-sm"
                        type="submit"
                        className="composer-icon send-button ml-auto"
                        aria-label={t(($) => $.sendMessage)}
                        disabled={
                          (!draft.trim() && !draftImages.length && !draftFiles.length) ||
                          generationBlocked ||
                          !selectedModel
                        }
                      >
                        {sending ? (
                          <Spinner />
                        ) : (
                          <ArrowUp className="h-[1.1875rem] w-[1.1875rem]" />
                        )}
                      </InputGroupButton>
                    )}
                  </>
                }
                notices={
                  <>
                    {contextPreview?.estimate && (
                      <ContextEstimateNotices
                        estimate={contextPreview.estimate}
                        compressing={contextPreview.compressing}
                      />
                    )}
                    {contextPreview?.error && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {renderUiMessage(contextPreview.error)}
                      </p>
                    )}
                  </>
                }
              />
            </div>
          </div>
        </div>
      </AppFrame>
      <ConversationActionDialogs
        actions={conversationActions}
        disabled={!navigator.onLine || !session.authenticated}
      />
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
            <ModalTitle>{t(($) => $.shortcuts)}</ModalTitle>
            <Button variant="ghost" onClick={() => setShortcutHelpOpen(false)}>
              {t(($) => $.close)}
            </Button>
          </div>
          <dl className="mt-3 space-y-3 text-sm">
            {(Object.keys(commandDefinitions) as CommandId[]).map((id) => (
              <div key={id} className="flex items-center justify-between gap-3">
                <dt>{t(($) => $[commandDefinitions[id].labelKey])}</dt>
                <dd>
                  <kbd>{shortcutLabel(id)}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Modal>
      {shareFor && session?.authenticated && (
        <Suspense
          fallback={
            <Modal
              open
              onOpenChange={(open) => {
                if (!open) setShareFor(null);
              }}
              showCloseButton
            >
              <div>
                <ModalTitle>{t(($) => $.shareBranch)}</ModalTitle>
                <LoadingContent label={t(($) => $.reading)} />
              </div>
            </Modal>
          }
        >
          {shareFor === selected && snapshotFor === selected && branches.head ? (
            <ShareDialog
              key={shareFor}
              conversationId={shareFor}
              headId={branches.head}
              close={() => setShareFor(null)}
            />
          ) : (
            <Modal
              open
              onOpenChange={(open) => {
                if (!open) setShareFor(null);
              }}
              showCloseButton
            >
              <div>
                <ModalTitle>{t(($) => $.shareBranch)}</ModalTitle>
                {syncError || invalidRoute ? (
                  <p role="alert">{t(($) => $.chatReadFailed)}</p>
                ) : snapshotFor === shareFor && !snapshot.messages.length ? (
                  <p>{t(($) => $.nothingToShare)}</p>
                ) : (
                  <LoadingContent label={t(($) => $.loadingBranch)} />
                )}
              </div>
            </Modal>
          )}
        </Suspense>
      )}
      <SettingsPanel
        open={settingsOpen}
        requestedTab={requestedSettingsTab}
        requestedProviderId={settingsOpen ? requestedProviderId : undefined}
        onTabChange={setRequestedSettingsTab}
        onSaved={providerSaved}
        onLocate={(id, messageId) => {
          setSettingsOpen(false);
          setRequestedSettingsTab(undefined);
          navigate(id, false, messageId);
        }}
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
          toolsToggleRef={toolsToggleRef}
          presetChangeRef={presetChangeRef}
          defaultOutputBudget={session.maxOutputTokens}
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
      {messageMutation?.mode === 'delete' && mutationMessage && (
        <MessageDeleteDialog
          key={`${selected}:${messageMutation.id}:${messageMutation.mode}`}
          message={mutationMessage}
          affectsSummaries={snapshot.messages.some(
            (message) =>
              !message.deletedAt && message.summary?.sourceIds.includes(mutationMessage.id),
          )}
          confirm={() => confirmMessageMutation('', '')}
          close={() => setMessageMutation(null)}
          restoreCompletedFocus={closeMutationFocus}
        />
      )}
    </>
  );
}
