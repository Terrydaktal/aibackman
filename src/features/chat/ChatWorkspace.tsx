import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { AgentAccount, Conversation, Message } from '../../types';
import { archiveItemLabel } from '../archiveLabels';
import { Virtuoso, type StateSnapshot, type VirtuosoHandle } from 'react-virtuoso';
import {
  buildCitationRegistry,
  buildDisplayMessages,
  buildLinearConversationPath,
  countNeedleHits,
  ConversationItem,
  DEEP_RESEARCH_SNAPSHOT_FORMAT_VERSION,
  escapeRegExp,
  formatSendError,
  getEmbeddedUiEntries,
  getDisplayMessageSearchText,
  matchesSentUserContent,
  MAX_MESSAGE_HIGHLIGHT_HITS,
  MessageRow,
  sleep,
  type BridgeComposerStatus,
  type DisplayMessage,
} from '../../archive/standard/UniversalArchivePresenter';
import { useWorkspaceDiagnostics } from './useWorkspaceDiagnostics';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, useWorkspaceLayout } from './useWorkspaceLayout';
import { useMessageNavigation } from './useMessageNavigation';
import { useArchiveSearch } from './useArchiveSearch';
import { useCacheManagement } from './useCacheManagement';
import { orderConversations } from './conversationOrdering';
import 'katex/dist/katex.min.css';
import '../../index.css';

interface ChatWorkspaceProps {
  account: AgentAccount;
  onGoHome: () => void;
  initialConversationId?: string | null;
  initialMessageId?: string | null;
  initialSearchQuery?: string;
}

const mergeConversationPage = (
  existing: Conversation[],
  incoming: Conversation[]
) => {
  const byId = new Map(existing.map((conversation) => [conversation.id, conversation]));
  incoming.forEach((conversation) => byId.set(conversation.id, conversation));
  return [...byId.values()];
};

const mergeRemoteConversationPositions = (
  existing: Map<string, number>,
  incoming: Conversation[],
  offset: number,
  reset = false
) => {
  const positions = reset ? new Map<string, number>() : new Map(existing);
  incoming.forEach((conversation, index) => positions.set(conversation.id, offset + index));
  return positions;
};

export function ChatWorkspace({
  account,
  onGoHome,
  initialConversationId = null,
  initialMessageId = null,
  initialSearchQuery = '',
}: ChatWorkspaceProps) {
  const isAiMode = account.agentId === 'google-ai-mode';
  const itemLabel = archiveItemLabel(account.agentId, true);
  const itemLabelSingular = archiveItemLabel(account.agentId);
  const isLiveChatGPT = account.agentId === 'chatgpt' && account.capabilities.liveSync;
  const canLiveSync = account.capabilities.liveSync;
  const canSend = account.capabilities.send;
  const canCacheAll = account.capabilities.cacheAll;
  const canRefreshLocal = account.capabilities.localBackup;
  const lastConvStorageKey = account.isDefault && account.agentId === 'chatgpt'
    ? 'lastConvId'
    : account.isDefault && isAiMode
      ? 'lastConvId:aimode'
      : `lastConvId:${account.id}`;
  const selectedModelStorageKey = account.isDefault && account.agentId === 'chatgpt'
    ? 'selectedModel'
    : `selectedModel:${account.id}`;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(initialConversationId || localStorage.getItem(lastConvStorageKey));
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationCurrentNodeId, setConversationCurrentNodeId] = useState<string | null>(null);
  const [branchSelectionsByConversation, setBranchSelectionsByConversation] = useState<Record<string, Record<string, string>>>({});
  const [isAuth, setIsAuth] = useState<boolean | null>(isLiveChatGPT ? null : true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(localStorage.getItem(selectedModelStorageKey) || 'Auto');
  const [pastedImage, setPastedImage] = useState<string | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ id: string; name: string; mimeType: string; dataUrl: string; sizeBytes: number }>>([]);
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isReauthenticating, setIsReauthenticating] = useState(false);
  const [bridgeComposerStatus, setBridgeComposerStatus] = useState<BridgeComposerStatus | null>(null);

  const {
    activeResizer,
    chatWidth,
    containerStyle: appContainerStyle,
    fontSize,
    handleMapResizeStart,
    handleSidebarResizeStart,
    isMessageMapOpen,
    isSidebarOpen,
    setChatWidth,
    setFontSize,
    setIsMessageMapOpen,
    toggleSidebar,
  } = useWorkspaceLayout();
  const [showSettings, setShowSettings] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);

  const [hasMoreConvs, setHasMoreConvs] = useState(true);
  const [isLoadingMoreConvs, setIsLoadingMoreConvs] = useState(false);
  const [remoteConversationPositions, setRemoteConversationPositions] = useState(new Map<string, number>());
  const [conversationContextMenu, setConversationContextMenu] = useState<{ x: number; y: number; conversationId: string } | null>(null);

  const [isPanning, setIsPanning] = useState(false);
  const [panPosition, setPanPosition] = useState({ x: 0, y: 0 });
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number } | null>(null);
  const panStart = useRef({ x: 0, y: 0 });
  const panCurrent = useRef({ x: 0, y: 0 });
  const panRaf = useRef<number | null>(null);
  const panScrollTargetRef = useRef<HTMLElement | null>(null);
  const conversationsScrollerRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suppressMiddlePasteRef = useRef(false);
  const suppressMiddlePasteUntilRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastConversationListSyncAtRef = useRef(0);
  const conversationListSyncInFlightRef = useRef(false);
	  const nextConversationOffsetRef = useRef(0);
	  const conversationSelectionTokenRef = useRef(0);
	  const selectConversationRef = useRef<(id: string, forceSync?: boolean, shouldSync?: boolean) => Promise<void>>(async () => {});
  const initializationStartedRef = useRef(false);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const activeConvIdRef = useRef<string | null>(initialConversationId || localStorage.getItem(lastConvStorageKey));
  const bridgeComposerStatusRef = useRef<BridgeComposerStatus | null>(null);
  const virtuosoStateByConversationRef = useRef<Record<string, StateSnapshot>>({});
  const [restoreVirtuosoState, setRestoreVirtuosoState] = useState<StateSnapshot | null>(null);
  const invokeMode = useCallback((channel: string, payload: Record<string, unknown> = {}) => (
    window.electronAPI.invoke(channel, {
      ...payload,
      accountId: account.id,
      mode: account.legacyMode || account.agentId,
    })
  ), [account.agentId, account.id, account.legacyMode]);
  const reloadLocalConversationIndex = useCallback(async () => {
    const refreshedLocalConversations = await invokeMode('db:getConversations');
    if (Array.isArray(refreshedLocalConversations)) {
      setConversations(refreshedLocalConversations);
    }
  }, [invokeMode]);
  const {
    cacheAll: handleCacheAll,
    clearUncached: clearUncachedConversationMarker,
    diagnostics: cacheDiagnostics,
    dirtyConversationIds,
    isRunning: isCachingAll,
    newMessageConversationIds,
    refreshDiagnostics: updateCacheDiagnostics,
    refreshStats: updateStats,
    resyncConversationIds,
    retryFailed: handleRetryFailedCache,
    stats: cacheStats,
    status: cacheRunStatus,
    stop: handleStopCache,
    uncachedConversationIds,
  } = useCacheManagement({
    enabled: canCacheAll,
    invoke: invokeMode,
    refreshRevision: conversations,
  });
  const orderedConversations = useMemo(() => orderConversations(
    conversations,
    remoteConversationPositions,
    isLiveChatGPT ? newMessageConversationIds : new Set<string>()
  ), [conversations, isLiveChatGPT, newMessageConversationIds, remoteConversationPositions]);
  const activeBranchSelections = useMemo(() => (
    activeConvId ? (branchSelectionsByConversation[activeConvId] || {}) : {}
  ), [activeConvId, branchSelectionsByConversation]);
  const { pathMessages } = useMemo(() => (
    buildLinearConversationPath(messages, conversationCurrentNodeId, activeBranchSelections)
  ), [messages, conversationCurrentNodeId, activeBranchSelections]);
  const displayMessages = useMemo(() => buildDisplayMessages(pathMessages, account.agentId), [account.agentId, pathMessages]);
  const citationRegistry = useMemo(() => buildCitationRegistry(pathMessages), [pathMessages]);
  const { push: pushOomDebug, updateStats: updateDiagnosticStats } = useWorkspaceDiagnostics();
  const {
    activeHighlightQuery,
    activeMapMessageIds,
    clearTarget: clearMessageTarget,
    clearVisibleMessages,
    focusMessage: jumpToMessageInCurrentChat,
    handleMessageRangeChanged,
    handleMessageScrollerRef,
    isNearBottom,
    jumpToRelativeMatch: jumpToRelativeMapMatch,
    mapHighlightQuery,
    mapListRef,
    mapMatchCount,
    mapMatchMessageIds,
    mapMatchPosition,
    mapSearchNeedle,
    mapSearchQuery,
    nativeHighlightsSupported: nativeSearchHighlightsSupported,
    navigationMessages,
    restoreInitialTarget,
    scheduleViewportUpdate: scheduleViewportHighlightUpdate,
    scrollerRef,
    targetMessageId,
    updateMapSearchQuery,
    updateViewport: updateViewportNavHighlight,
    viewportVisibleMessageIds,
  } = useMessageNavigation({
    activeConversationId: activeConvId,
    displayMessages,
    initialMessageId,
    initialSearchQuery,
    isMessageMapOpen,
    pushDebug: pushOomDebug,
    virtuosoRef,
  });
  const isBridgeReadyForActiveConversation = useMemo(() => {
    if (!canSend) return false;
    if (!bridgeComposerStatus?.ready) return false;
    return (bridgeComposerStatus.conversationId || null) === (activeConvId || null);
  }, [activeConvId, bridgeComposerStatus, canSend]);
  const bridgeActivityLabel = useMemo(() => {
    if (!canSend) return '';
    const status = bridgeComposerStatus;
    if (!status) return '';
    const sameConversation = (status.conversationId || null) === (activeConvId || null);
    if (!sameConversation) return '';
    if (status.state === 'sending') return 'Sending...';
    if (status.state === 'thinking') return 'Thinking...';
    if (status.state === 'warming') return 'Preparing chat...';
    if (status.state === 'ready') return 'Ready';
    if (status.state === 'error' && status.reason) return status.reason;
    return '';
  }, [activeConvId, bridgeComposerStatus, canSend]);
  const bridgeMessageStatus = useMemo(() => {
    if (!canSend) return null;
    const status = bridgeComposerStatus;
    if (!status) return null;
    if (!isNearBottom) return null;
    const sameConversation = (status.conversationId || null) === (activeConvId || null);
    if (!sameConversation) return null;
    if (status.state === 'sending') return { state: status.state, text: 'Thinking...' };
    if (status.state === 'thinking') return { state: status.state, text: status.reason?.trim() || 'Thinking...' };
    // Intentionally exclude "warming" so "Preparing chat..." is not injected into the message list.
    return null;
  }, [activeConvId, bridgeComposerStatus, canSend, isNearBottom]);
  const displayMessagesForView = useMemo(() => {
    if (!bridgeMessageStatus) return displayMessages;
    const bridgeStatusMessage: DisplayMessage = {
      id: `__bridge-status__${activeConvId || 'new'}`,
      conversation_id: activeConvId || '',
      role: 'assistant',
      content: bridgeMessageStatus.text,
      created_at: Number(bridgeComposerStatus?.updatedAt || 0) / 1000,
      isBridgeStatus: true,
      bridgeStatusState: bridgeMessageStatus.state,
    };
    return [...displayMessages, bridgeStatusMessage];
  }, [activeConvId, bridgeComposerStatus?.updatedAt, bridgeMessageStatus, displayMessages]);
  useEffect(() => {
    updateDiagnosticStats({
      mapQuery: mapSearchQuery,
      navigationCount: navigationMessages.length,
      visibleCount: viewportVisibleMessageIds.length,
      displayCount: displayMessages.length,
      displayViewCount: displayMessagesForView.length,
    });
  }, [
    displayMessages.length,
    displayMessagesForView.length,
    mapSearchQuery,
    navigationMessages.length,
    updateDiagnosticStats,
    viewportVisibleMessageIds.length,
  ]);
  const handleConversationsScrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    conversationsScrollerRef.current = ref instanceof HTMLElement ? ref : null;
  }, []);
  const markMiddlePasteSuppressed = useCallback(() => {
    suppressMiddlePasteRef.current = true;
    suppressMiddlePasteUntilRef.current = Date.now() + 1500;
  }, []);

  const saveVirtuosoState = useCallback((conversationId: string | null) => {
    if (!conversationId || !virtuosoRef.current?.getState) return;
    virtuosoRef.current.getState((state: StateSnapshot) => {
      virtuosoStateByConversationRef.current[conversationId] = state;
    });
  }, []);

  const loadConversations = useCallback(async () => {
    const localConvs = await invokeMode('db:getConversations');
    setConversations(localConvs);
    nextConversationOffsetRef.current = 0;
    setRemoteConversationPositions(new Map());
    try {
      const result = await invokeMode('api:syncConversations', { offset: 0, limit: 20 });
      const remoteConversations = Array.isArray(result?.conversations) ? result.conversations : [];
      if (!result?.remoteUnavailable) {
        setConversations(mergeConversationPage(localConvs, remoteConversations));
        setRemoteConversationPositions((previous) => mergeRemoteConversationPositions(
          previous,
          remoteConversations,
          0,
          true
        ));
        nextConversationOffsetRef.current = Number(result?.nextOffset ?? remoteConversations.length);
      }
      setHasMoreConvs(!result?.remoteUnavailable && !!result?.hasMore);
      lastConversationListSyncAtRef.current = Date.now();
    } catch (e) {
      console.error('Failed to sync conversations', e);
    }
  }, [invokeMode]);

  const checkAuth = useCallback(async () => {
    if (!isLiveChatGPT) {
      setIsAuth(true);
      await loadConversations();
      return;
    }
    const authed = await window.electronAPI.invoke('auth:check');
    setIsAuth(authed);
    if (authed) {
      loadConversations();
    }
  }, [isLiveChatGPT, loadConversations]);

  const handleLogin = async () => {
    const success = await window.electronAPI.invoke('auth:login');
    if (success) {
      setIsAuth(true);
      loadConversations();
    }
  };

  const loadMoreConversations = useCallback(async () => {
    if (isLoadingMoreConvs || !hasMoreConvs) return;
    setIsLoadingMoreConvs(true);
    try {
      const offset = nextConversationOffsetRef.current;
      const result = await invokeMode('api:syncConversations', {
        offset,
        limit: 20
      });
      const remoteConversations = Array.isArray(result?.conversations) ? result.conversations : [];
      if (!result?.remoteUnavailable) {
        setConversations((previous) => mergeConversationPage(previous, remoteConversations));
        setRemoteConversationPositions((previous) => mergeRemoteConversationPositions(
          previous,
          remoteConversations,
          offset
        ));
        nextConversationOffsetRef.current = Number(result?.nextOffset ?? (offset + remoteConversations.length));
      }
      setHasMoreConvs(!result?.remoteUnavailable && !!result?.hasMore);
    } catch (e) {
      console.error('Failed to load more conversations', e);
    } finally {
      setIsLoadingMoreConvs(false);
    }
  }, [hasMoreConvs, invokeMode, isLoadingMoreConvs]);

  const loadConversationState = useCallback(async (conversationId: string) => {
    return invokeMode('db:getConversationState', { conversationId });
  }, [invokeMode]);

  const handleSwitchBranch = useCallback((parentId: string, childId: string) => {
    if (!activeConvId) return;
    setBranchSelectionsByConversation((prev) => ({
      ...prev,
      [activeConvId]: {
        ...(prev[activeConvId] || {}),
        [parentId]: childId,
      },
    }));
  }, [activeConvId]);

  const refreshConversationList = useCallback(async (force = false) => {
    if (!isLiveChatGPT || conversationListSyncInFlightRef.current) return;
    if (!force && Date.now() - lastConversationListSyncAtRef.current < 30000) return;

    conversationListSyncInFlightRef.current = true;
    lastConversationListSyncAtRef.current = Date.now();
    try {
      const result = await invokeMode('api:syncConversations', { offset: 0, limit: 20 });
      if (Array.isArray(result?.conversations) && !result?.remoteUnavailable) {
        setConversations((previous) => mergeConversationPage(previous, result.conversations));
        setRemoteConversationPositions((previous) => mergeRemoteConversationPositions(
          previous,
          result.conversations,
          0,
          true
        ));
        nextConversationOffsetRef.current = Number(result?.nextOffset ?? result.conversations.length);
      }
      setHasMoreConvs(!result?.remoteUnavailable && !!result?.hasMore);
      await updateCacheDiagnostics();
      await reloadLocalConversationIndex();
    } catch (error) {
      console.error('Failed to refresh conversation list', error);
    } finally {
      conversationListSyncInFlightRef.current = false;
    }
  }, [invokeMode, isLiveChatGPT, reloadLocalConversationIndex, updateCacheDiagnostics]);

  const refreshConversationListOnSwitch = useCallback(() => {
    void refreshConversationList(false);
  }, [refreshConversationList]);

  const selectConversation = useCallback(async (id: string, forceSync = false, shouldSync = false, forceBridgeReload = false) => {
    if (id === activeConvIdRef.current && !forceSync && !dirtyConversationIds.has(id)) return;
    const selectionToken = ++conversationSelectionTokenRef.current;

    if (activeConvIdRef.current && activeConvIdRef.current !== id) {
      saveVirtuosoState(activeConvIdRef.current);
      refreshConversationListOnSwitch();
    }

    setRestoreVirtuosoState(virtuosoStateByConversationRef.current[id] || null);
    clearVisibleMessages();
    setActiveConvId(id);
    activeConvIdRef.current = id;
    const localState = await loadConversationState(id);
    const localMsgs: Message[] = Array.isArray(localState?.allMessages) ? localState.allMessages : [];
    const localCurrentMsgs: Message[] = Array.isArray(localState?.currentMessages) ? localState.currentMessages : [];
    if (activeConvIdRef.current !== id || conversationSelectionTokenRef.current !== selectionToken) return;
    setMessages(localMsgs);
    setConversationCurrentNodeId(localState?.currentNodeId || null);
    if (Array.isArray(localMsgs) && localMsgs.length > 0) {
      clearUncachedConversationMarker(id);
    }
    if (forceSync && localCurrentMsgs.length > 0) {
      setTimeout(() => {
        if (activeConvIdRef.current !== id) return;
        virtuosoRef.current?.scrollToIndex({ index: localCurrentMsgs.length - 1, align: 'end', behavior: 'auto' });
      }, 0);
    }
    const isDirty = dirtyConversationIds.has(id);
    const cachedEmbeddedUiEntries = localMsgs.flatMap((message) => getEmbeddedUiEntries(message));
    const hasCachedEmbeddedUi = cachedEmbeddedUiEntries.length > 0;
    const hasIncompleteEmbeddedUi = cachedEmbeddedUiEntries.some((entry) => (
      !entry.text?.trim() || Number(entry.formatVersion || 0) < DEEP_RESEARCH_SNAPSHOT_FORMAT_VERSION
    ));
    const hasEmbeddedUiPlaceholder = localMsgs.some((message) => (
      message.role !== 'user'
      && /the tool included embedded ui|deep research experience|deep[-_]research/i.test(String(message.content || ''))
    ));
    const needsEmbeddedUiSync = isLiveChatGPT && (
      hasIncompleteEmbeddedUi
      || (!hasCachedEmbeddedUi && hasEmbeddedUiPlaceholder)
    );
    const shouldSyncNow = canLiveSync && (isAiMode || shouldSync || isDirty || localMsgs.length === 0 || needsEmbeddedUiSync);
    const bridgePrewarmPromise = isLiveChatGPT
      ? invokeMode('api:prewarmConversation', {
        conversationId: id,
        forceReload: forceBridgeReload,
        requireComposer: false,
      })
        .catch((error) => {
          console.warn(`Failed to prewarm ${account.agentName} bridge conversation`, error);
          return null;
        })
      : Promise.resolve(null);
    if (needsEmbeddedUiSync) {
      await bridgePrewarmPromise;
    }
    if (!shouldSyncNow) {
      setIsSyncing(false);
      return;
    }
    setIsSyncing(true);
    try {
      if (needsEmbeddedUiSync) await bridgePrewarmPromise;
      await invokeMode('api:syncMessages', { conversationId: id, force: forceSync || isDirty });
      const syncedState = await loadConversationState(id);
      const syncedMsgs: Message[] = Array.isArray(syncedState?.allMessages) ? syncedState.allMessages : [];
      const syncedCurrentMsgs: Message[] = Array.isArray(syncedState?.currentMessages) ? syncedState.currentMessages : [];
      const displaySyncedMsgs = syncedMsgs.length > 0 ? syncedMsgs : localMsgs;
      const displayCurrentMsgs = syncedCurrentMsgs.length > 0 ? syncedCurrentMsgs : localCurrentMsgs;
      if (activeConvIdRef.current === id && conversationSelectionTokenRef.current === selectionToken) {
        setMessages(displaySyncedMsgs);
        setConversationCurrentNodeId(syncedState?.currentNodeId || localState?.currentNodeId || null);
        if (displaySyncedMsgs.length > 0) {
          clearUncachedConversationMarker(id);
        }
        if ((forceSync || isDirty) && displayCurrentMsgs.length > 0) {
          setTimeout(() => {
            if (activeConvIdRef.current !== id) return;
            virtuosoRef.current?.scrollToIndex({ index: displayCurrentMsgs.length - 1, align: 'end', behavior: 'auto' });
          }, 0);
        }
      }
      await updateCacheDiagnostics();
      await reloadLocalConversationIndex();
    } catch (error) {
      console.error('Failed to sync messages', error);
    } finally {
      if (activeConvIdRef.current === id && conversationSelectionTokenRef.current === selectionToken) {
        setIsSyncing(false);
      }
    }
  }, [account.agentName, canLiveSync, clearUncachedConversationMarker, clearVisibleMessages, dirtyConversationIds, invokeMode, isAiMode, isLiveChatGPT, loadConversationState, refreshConversationListOnSwitch, reloadLocalConversationIndex, saveVirtuosoState, updateCacheDiagnostics]);
  useEffect(() => {
    selectConversationRef.current = selectConversation;
  }, [selectConversation]);
  const handleArchiveSearchNavigation = useCallback((result: { id: string; conversation_id: string }, query: string) => {
    jumpToMessageInCurrentChat(result.id, { highlightQuery: query, occurrence: 0 });
    void selectConversation(result.conversation_id);
  }, [jumpToMessageInCurrentChat, selectConversation]);
  const {
    close: closeSearch,
    isOpen: showSearch,
    navigate: jumpToSearchResult,
    open: openSearch,
    query: searchQuery,
    results: searchResults,
    search: handleSearch,
    totalCount: searchTotalCount,
    totalIsLowerBound: searchTotalIsLowerBound,
  } = useArchiveSearch({
    invoke: invokeMode,
    onNavigate: handleArchiveSearchNavigation,
  });

  const handleReauth = useCallback(async () => {
    if (!isLiveChatGPT) return;
    if (isReauthenticating) return;
    setIsReauthenticating(true);
    try {
      const success = await window.electronAPI.invoke('auth:reauth');
      if (!success) {
        setSendError('Re-authentication was cancelled or failed.');
        return;
      }
      await checkAuth();
      if (activeConvIdRef.current) {
        await selectConversation(activeConvIdRef.current, true, true);
      }
      setSendError(null);
    } catch (error) {
      console.error('Re-authentication failed', error);
      setSendError('Re-authentication failed. Please try again.');
    } finally {
      setIsReauthenticating(false);
    }
  }, [checkAuth, isLiveChatGPT, isReauthenticating, selectConversation]);

  const handleRefreshCurrentChat = useCallback(async () => {
    const conversationId = activeConvIdRef.current;
    if (!conversationId) return;
    if (canRefreshLocal) {
      setIsSyncing(true);
      try {
        await invokeMode('archive:refreshLocal');
        await loadConversations();
        await selectConversation(conversationId, false, false, false);
      } finally {
        setIsSyncing(false);
      }
      return;
    }
    await refreshConversationList(true);
    await selectConversation(conversationId, canLiveSync, canLiveSync, isLiveChatGPT);
    await updateCacheDiagnostics();
  }, [canLiveSync, canRefreshLocal, invokeMode, isLiveChatGPT, loadConversations, refreshConversationList, selectConversation, updateCacheDiagnostics]);

  const handleSend = async () => {
    if (!canSend) {
      setSendError(`${account.label} is read-only.`);
      return;
    }
    if (isSending || (!inputValue.trim() && !pastedImage && attachedFiles.length === 0)) return;
    if (!isBridgeReadyForActiveConversation) {
      setSendError('Bridge chat is still loading. Wait for the send button to turn green.');
      return;
    }

    const outgoingContent = inputValue;
    const currentImage = pastedImage;
    const currentFiles = attachedFiles;
    const modelMap: Record<string, string> = {
      'Auto': 'auto', 'Instant 5.3': 'gpt-4o', 'Thinking 5.4 Standard': 'o1-mini',
      'Thinking 5.4 Extended': 'o1', 'Thinking 5.5 Standard': 'o3-mini', 'Thinking 5.5 Extended': 'o1',
    };
    const baselineMessageIds = new Set(pathMessages.map((m) => m.id));

    setSendError(null);
    setIsSending(true);

    // Optimistically clear the input
    setInputValue('');
    setPastedImage(null);
    setAttachedFiles([]);

    // Create a temporary optimistic message
    const tempId = `temp-${Date.now()}`;
    const optimisticMsg: Message = {
      id: tempId,
      conversation_id: activeConvId || '',
      role: 'user',
      content: outgoingContent,
      created_at: Date.now() / 1000,
      parent_id: pathMessages.length > 0 ? pathMessages[pathMessages.length - 1].id : undefined,
    };

    // Add to list immediately
    setMessages(prev => [...prev, optimisticMsg]);

    try {
      await invokeMode('api:sendMessage', {
        conversationId: activeConvId,
        content: outgoingContent,
        model: modelMap[selectedModel] || 'auto',
        image: currentImage,
        files: currentFiles.map((f) => ({
          name: f.name,
          mimeType: f.mimeType,
          dataUrl: f.dataUrl,
          sizeBytes: f.sizeBytes,
        })),
      });

      if (activeConvId) {
        // Pull updates repeatedly while ChatGPT is thinking to mimic web streaming.
        const syncDeadline = Date.now() + 120000;
        let latestMsgs: Message[] = [];
        let stableAssistantPasses = 0;
        let lastAssistantFingerprint = '';

        while (Date.now() < syncDeadline) {
          await invokeMode('api:syncMessages', { conversationId: activeConvId, force: true });
          const syncedState = await loadConversationState(activeConvId);
          latestMsgs = Array.isArray(syncedState?.currentMessages) ? syncedState.currentMessages : [];
          setMessages((prev) => {
            const nextRawMessages = Array.isArray(syncedState?.allMessages) ? syncedState.allMessages : [];
            if (JSON.stringify(prev) === JSON.stringify(nextRawMessages)) return prev;
            return nextRawMessages;
          });
          setConversationCurrentNodeId(syncedState?.currentNodeId || null);

          const lastAssistant = [...latestMsgs].reverse().find((m) => m.role === 'assistant');
          const assistantFingerprint = lastAssistant
            ? `${lastAssistant.id}|${lastAssistant.content || ''}`
            : '';
          if (assistantFingerprint && assistantFingerprint === lastAssistantFingerprint) {
            stableAssistantPasses += 1;
          } else {
            stableAssistantPasses = 0;
            lastAssistantFingerprint = assistantFingerprint;
          }

          const bridgeState = bridgeComposerStatusRef.current?.state || '';
          const stillGenerating = bridgeState === 'sending' || bridgeState === 'thinking' || bridgeState === 'warming';
          if (!stillGenerating && stableAssistantPasses >= 2) break;

          await sleep(350);
        }

        const textNeedle = outgoingContent.trim();
        const userMessageConfirmed = !textNeedle || latestMsgs.some((m: Message) => {
          if (m.role !== 'user') return false;
          return matchesSentUserContent(m.content || '', textNeedle);
        });
        const hasNewUserTurn = latestMsgs.some((m: Message) => m.role === 'user' && !baselineMessageIds.has(m.id));
        const hasNewAssistantTurn = latestMsgs.some((m: Message) =>
          m.role === 'assistant' &&
          !baselineMessageIds.has(m.id) &&
          !!(m.content || '').trim()
        );
        const sendLikelySucceeded = userMessageConfirmed || hasNewUserTurn || hasNewAssistantTurn;

        if (!sendLikelySucceeded) {
          setSendError('Send could not be verified in this chat. Your draft was kept so you can retry.');
          setInputValue(outgoingContent);
          setPastedImage(currentImage);
          setAttachedFiles(currentFiles);
        }
        await reloadLocalConversationIndex();
        await updateCacheDiagnostics();
      } else {
        // New conversation, need to refresh the list to find the new ID
        loadConversations();
      }
    } catch (error) {
      console.error('Failed to send message', error);
      setSendError(formatSendError(error));

      // Restore state on failure
      setInputValue(outgoingContent);
      setPastedImage(currentImage);
      setAttachedFiles(currentFiles);

      // Remove the optimistic message
      setMessages(prev => prev.filter(m => m.id !== tempId));
    } finally {
      setIsSending(false);
    }
  };

  const handleAttachFiles = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const fileArray = Array.from(list);
    const mapped = await Promise.all(fileArray.map(async (file) => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
      return {
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataUrl,
        sizeBytes: file.size,
      };
    }));
    setAttachedFiles((prev) => [...prev, ...mapped]);
  }, []);

  const handleDeleteConversation = async (id: string) => {
    if (window.confirm(`Remove this ${itemLabelSingular} from the local archive? An immutable recovery copy and audit record will be retained.`)) {
      await invokeMode('db:deleteConversation', {
        id,
        confirmation: id,
        reason: 'User confirmed removal from the archive viewer.',
      });
      if (activeConvId === id) {
        setActiveConvId(null);
        setMessages([]);
        setConversationCurrentNodeId(null);
        clearVisibleMessages();
        clearMessageTarget();
      }
      setConversationContextMenu(null);
      loadConversations();
    }
  };

  const handleAudit = async () => {
    if (!canCacheAll) return;
    setIsSyncing(true);
    try {
      const result = await invokeMode('api:auditDeletions');
      if (result.success) {
        loadConversations();
        updateStats();
      }
    } catch (e) {
      console.error('Audit failed', e);
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    localStorage.setItem(selectedModelStorageKey, selectedModel);
  }, [selectedModel, selectedModelStorageKey]);

  useEffect(() => {
    const handleRefreshShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 'r') return;
      event.preventDefault();
      event.stopPropagation();
      void handleRefreshCurrentChat();
    };
    window.addEventListener('keydown', handleRefreshShortcut, true);
    return () => window.removeEventListener('keydown', handleRefreshShortcut, true);
  }, [handleRefreshCurrentChat]);

  useEffect(() => {
    const handleGlobalMiddleDown = (event: MouseEvent) => {
      if (event.button !== 1) return;
      markMiddlePasteSuppressed();
    };
    window.addEventListener('mousedown', handleGlobalMiddleDown, true);
    return () => window.removeEventListener('mousedown', handleGlobalMiddleDown, true);
  }, [markMiddlePasteSuppressed]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [inputValue]);

  useEffect(() => {
    if (activeConvId) {
      localStorage.setItem(lastConvStorageKey, activeConvId);
      activeConvIdRef.current = activeConvId;
    } else {
      localStorage.removeItem(lastConvStorageKey);
      activeConvIdRef.current = null;
    }
  }, [activeConvId, lastConvStorageKey]);

  useEffect(() => {
    if (!isPanning) {
      if (panRaf.current) cancelAnimationFrame(panRaf.current);
      panScrollTargetRef.current = null;
      return;
    }
    const handleMouseMove = (e: MouseEvent) => { panCurrent.current = { x: e.clientX, y: e.clientY }; };
    const handleMouseUp = (e: MouseEvent) => { if (e.button === 1) setIsPanning(false); };
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseup', handleMouseUp, { passive: true });
    const scrollLoop = () => {
      if (panScrollTargetRef.current) {
        const dy = panCurrent.current.y - panStart.current.y;
        if (Math.abs(dy) > 5) {
          const speed = (dy - Math.sign(dy) * 5) * 0.15;
          panScrollTargetRef.current.scrollBy(0, speed);
        }
      }
      panRaf.current = requestAnimationFrame(scrollLoop);
    };
    panRaf.current = requestAnimationFrame(scrollLoop);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (panRaf.current) cancelAnimationFrame(panRaf.current);
    };
  }, [isPanning]);

  const handleOpenImage = useCallback((src: string) => {
    setImageMenu(null);
    setFullscreenImage(src);
  }, [setFullscreenImage, setImageMenu]);

  useEffect(() => {
    if (!fullscreenImage) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (imageMenu) setImageMenu(null);
        else setFullscreenImage(null);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [fullscreenImage, imageMenu]);

  const handleCopyFullscreenImage = useCallback(async () => {
    if (!fullscreenImage) return;
    const result = await window.electronAPI.invoke('api:copyImageToClipboard', {
      src: fullscreenImage,
      conversationId: activeConvId || undefined,
    });
    if (!result?.success) {
      console.error('Copy image failed:', result?.error || 'unknown error');
    }
    setImageMenu(null);
  }, [activeConvId, fullscreenImage, setImageMenu]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    if (!canSend) return;
    if (window.electronAPI.onBridgeComposerStatus) {
      const maybeUnsub = window.electronAPI.onBridgeComposerStatus((status: BridgeComposerStatus) => {
        setBridgeComposerStatus(status || null);
      });
      if (typeof maybeUnsub === 'function') unsubscribe = maybeUnsub;
    }
    window.electronAPI.invoke('api:getBridgeComposerStatus')
      .then((status: BridgeComposerStatus) => setBridgeComposerStatus(status || null))
      .catch((error) => console.warn('Failed to get initial bridge status', error));
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [canSend]);

  useEffect(() => {
    bridgeComposerStatusRef.current = bridgeComposerStatus;
  }, [bridgeComposerStatus]);

  useEffect(() => {
    if (initializationStartedRef.current) return;
    initializationStartedRef.current = true;

    const init = async () => {
      try {
        await checkAuth();
        const selectedId = initialConversationId || localStorage.getItem(lastConvStorageKey);
        if (selectedId) {
          await selectConversationRef.current(selectedId, canLiveSync, canLiveSync);
          restoreInitialTarget(initialMessageId, initialSearchQuery);
        } else if (canSend) {
          invokeMode('api:prewarmConversation', { conversationId: null })
            .catch((error) => console.warn('Failed to prewarm new chat bridge', error));
        }
      } catch (error) {
        console.error('Workspace initialization failed', error);
        setSendError(`Workspace initialization failed: ${String((error as Error)?.message || error)}`);
      }
    };
    void init();
  }, [canLiveSync, canSend, checkAuth, initialConversationId, initialMessageId, initialSearchQuery, invokeMode, lastConvStorageKey, restoreInitialTarget]);

  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('image') !== -1) {
            const blob = items[i].getAsFile();
            if (blob) {
              const reader = new FileReader();
              reader.onload = (event) => { setPastedImage(event.target?.result as string); };
              reader.readAsDataURL(blob);
            }
          }
        }
      }
    };
    window.addEventListener('paste', handleGlobalPaste);
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (showModelMenu && !target.closest('.model-picker-container')) {
        setShowModelMenu(false);
      }
      if (conversationContextMenu && !target.closest('.conversation-context-menu')) {
        setConversationContextMenu(null);
      }
    };
    const handleAnyScroll = () => {
      setConversationContextMenu(null);
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleAnyScroll, true);
    return () => {
      window.removeEventListener('paste', handleGlobalPaste);
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleAnyScroll, true);
    };
  }, [showModelMenu, conversationContextMenu]);

  const startPanning = (e: React.MouseEvent, scrollTarget?: HTMLElement | null) => {
    if (e.button === 1) {
      e.preventDefault();
      setIsPanning(true);
      panScrollTargetRef.current = scrollTarget || scrollerRef.current;
      setPanPosition({ x: e.clientX, y: e.clientY });
      panStart.current = { x: e.clientX, y: e.clientY };
      panCurrent.current = { x: e.clientX, y: e.clientY };
    }
  };

  if (isLiveChatGPT && isAuth === null) return <div className="auth-overlay">Loading...</div>;
  if (isLiveChatGPT && isAuth === false) return (
    <div className="auth-overlay">
      <h1>AIBackman</h1>
      <p>Please log in to your ChatGPT Plus account</p>
      <button className="login-btn" onClick={handleLogin}>Login with Browser</button>
    </div>
  );

  const trimmedSearchQuery = searchQuery.trim();
  const searchMatchCount = trimmedSearchQuery ? searchTotalCount : 0;
  const searchMatchCountLabel = `${searchMatchCount}${searchTotalIsLowerBound ? '+' : ''}`;
  const hasSendableInput = !!inputValue.trim() || !!pastedImage || attachedFiles.length > 0;
  const isSendDisabled = !canSend || isSending || !hasSendableInput || !isBridgeReadyForActiveConversation;
  return (
    <div className="app-container" style={appContainerStyle}>
      {isPanning && (
        <div className="pan-overlay">
          <div className="pan-center" style={{ left: panPosition.x, top: panPosition.y }} />
        </div>
      )}
      {isSidebarOpen ? (
        <div className="sidebar">
          <div className="sidebar-header">
            <div style={{ display: 'flex', gap: '8px' }}>
              {canSend ? <button className="new-chat-btn" onClick={() => {
                saveVirtuosoState(activeConvIdRef.current);
                setActiveConvId(null);
                setMessages([]);
                setConversationCurrentNodeId(null);
                clearVisibleMessages();
                clearMessageTarget();
                activeConvIdRef.current = null;
                setRestoreVirtuosoState(null);
                invokeMode('api:prewarmConversation', { conversationId: null }).catch((error) => console.warn('Failed to prewarm new chat bridge', error));
              }}>+ New Chat</button> : <div className="sidebar-account-name" title={account.label}>{account.label}</div>}
              <button className="search-trigger-btn" onClick={openSearch} title={`Search ${itemLabel}`}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
              </button>
            </div>
          </div>
          <div className="conversations-list" onMouseDown={(e) => startPanning(e, conversationsScrollerRef.current || (e.currentTarget as HTMLElement))}>
            <Virtuoso
              data={orderedConversations}
              endReached={loadMoreConversations}
              scrollerRef={handleConversationsScrollerRef}
              itemContent={(_index, conv) => (
                <ConversationItem
                  key={conv.id}
                  conv={conv}
                  markerState={canCacheAll
                    ? (resyncConversationIds.has(conv.id)
                      ? 'resync'
                      : newMessageConversationIds.has(conv.id)
                        ? 'new-messages'
                        : uncachedConversationIds.has(conv.id)
                          ? 'uncached'
                          : 'none')
                    : 'none'}
                  active={activeConvId === conv.id}
                  onClick={() => selectConversation(conv.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setConversationContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      conversationId: conv.id,
                    });
                  }}
                />
              )}
              components={{ Footer: () => isLoadingMoreConvs ? <div style={{ padding: '10px', textAlign: 'center', fontSize: '12px', color: '#c5c5d2' }}>Loading more...</div> : null }}
            />
          </div>
          <div className="sidebar-footer">
            <div className="cache-stats-container">
              <div className="cache-stats-text">
                <div className="cache-stats-line">
                  <span className="stats-label">Cached:</span>
                  <span className="stats-value">{cacheStats.cachedCount} / {cacheStats.localCount}</span>
                </div>
                <div className="cache-stats-line" title="Uncached conversations split by known failed fetches vs unknown/no-data cases">
                  <span className="stats-label">Uncached:</span>
                  <span className="stats-value">{cacheDiagnostics.uncachedCount}</span>
                  <span className="stats-subvalue">fail {cacheDiagnostics.failedCount} · unknown {cacheDiagnostics.unknownCount}</span>
                </div>
                <div className="cache-stats-line" title="Cached conversations with messages that have not been synced locally yet">
                  <span className="stats-label">New messages:</span>
                  <span className="stats-value">{cacheDiagnostics.newMessagesCount}</span>
                </div>
                <div className="cache-stats-line" title="Conversations whose local cache metadata is incomplete and needs a full sync">
                  <span className="stats-label">Full resync:</span>
                  <span className="stats-value">{cacheDiagnostics.resyncCount}</span>
                </div>
                {cacheRunStatus ? (
                  <div className="cache-stats-line" title={cacheRunStatus}>
                    <span className="stats-label">Status:</span>
                    <span className="stats-subvalue">{cacheRunStatus}</span>
                  </div>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                {canCacheAll ? (
                  <>
                    {isCachingAll ? (
                      <button
                        className="cache-all-btn"
                        onClick={handleStopCache}
                        title="Stop the active cache sync"
                      >
                        Stop
                      </button>
                    ) : null}
                    <button
                      className="cache-all-btn"
                      onClick={handleRetryFailedCache}
                      disabled={isCachingAll || cacheDiagnostics.failedCount === 0}
                      title="Retry only conversations with known cache failures"
                    >
                      Retry failed
                    </button>
                    <button
                      className={`cache-all-btn ${isCachingAll ? 'spinning' : ''}`}
                      onClick={handleCacheAll}
                      disabled={isCachingAll || (cacheDiagnostics.uncachedCount === 0 && cacheDiagnostics.dirtyCount === 0)}
                      title="Cache missing conversations and refresh conversations that need a full sync"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                      </svg>
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="footer-actions">
              <button className="sync-btn-sidebar" onClick={() => void handleRefreshCurrentChat()} disabled={!activeConvId} title={canRefreshLocal ? 'Refresh local backup' : canLiveSync ? `Sync current ${itemLabelSingular}` : `Reload cached ${itemLabelSingular}`}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
              </button>
              <button
                className="workspace-home-btn"
                onClick={onGoHome}
                title="Return to the start menu"
                aria-label="Return to the start menu"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
                  <path d="M12 3l9 8.5-1.4 1.5L18 11.4V21h-5v-6H11v6H6v-9.6L4.4 13 3 11.5 12 3z" />
                </svg>
                <span>Start menu</span>
              </button>
              <button className="settings-btn" onClick={() => setShowSettings(true)}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
                Settings
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {isSidebarOpen ? (
        <div
          className={`panel-resizer sidebar-resizer ${activeResizer === 'sidebar' ? 'active' : ''}`}
          onMouseDown={handleSidebarResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${itemLabel} list panel`}
        />
      ) : null}
      <div className={`main-content ${isSidebarOpen ? 'sidebar-open' : 'sidebar-closed'} ${isMessageMapOpen ? 'map-open' : 'map-closed'}`}>
        <button
          className={`sidebar-toggle ${isSidebarOpen ? 'open' : 'closed'}`}
          onClick={toggleSidebar}
          title={isSidebarOpen ? `Hide ${itemLabel} list` : `Show ${itemLabel} list`}
          aria-label={isSidebarOpen ? `Hide ${itemLabel} list` : `Show ${itemLabel} list`}
        >
          {isSidebarOpen ? '‹' : '›'}
        </button>
        <div className="chat-body">
          <div className="chat-pane">
            {isSyncing && <div className="sync-indicator">Syncing...</div>}
            <div className="messages-container" onMouseDown={(e) => startPanning(e, scrollerRef.current)}>
              <Virtuoso key={activeConvId || '__new_chat__'} ref={virtuosoRef} scrollerRef={handleMessageScrollerRef} data={displayMessagesForView} initialTopMostItemIndex={displayMessagesForView.length > 0 ? displayMessagesForView.length - 1 : 0} restoreStateFrom={restoreVirtuosoState || undefined} followOutput={false} defaultItemHeight={180} increaseViewportBy={{ top: mapSearchNeedle ? 420 : 1200, bottom: mapSearchNeedle ? 240 : 400 }} overscan={mapSearchNeedle ? { main: 260, reverse: 320 } : { main: 1000, reverse: 1400 }} isScrolling={(isScrolling) => { if (isScrolling) scheduleViewportHighlightUpdate(); else updateViewportNavHighlight(); }} rangeChanged={handleMessageRangeChanged}
                itemContent={(_index, msg) => {
                  const isTarget = targetMessageId === msg.id;
                  const shouldMapHighlight = !!mapHighlightQuery && mapMatchMessageIds.has(msg.id);
                  const messageIsHighlightSafe = shouldMapHighlight
                    ? countNeedleHits(getDisplayMessageSearchText(msg), mapHighlightQuery.toLowerCase()) <= MAX_MESSAGE_HIGHLIGHT_HITS
                    : true;
                  const highlightQuery = nativeSearchHighlightsSupported
                    ? ''
                    : ((shouldMapHighlight && messageIsHighlightSafe) ? mapHighlightQuery : (isTarget ? activeHighlightQuery : ''));
                  const highlightCodeBlocks = !nativeSearchHighlightsSupported
                    && isTarget
                    && shouldMapHighlight
                    && messageIsHighlightSafe;
                  return (
                    <MessageRow
                      key={msg.id}
                      msg={msg}
                      assistantLabel={account.agentName}
                      highlightQuery={highlightQuery}
                      highlightCodeBlocks={highlightCodeBlocks}
                      isTarget={isTarget}
                      onOpenImage={handleOpenImage}
                      citationRegistry={citationRegistry}
                      onSwitchBranch={handleSwitchBranch}
                    />
                  );
                }}
              />
            </div>
          </div>
          {isMessageMapOpen ? (
            <div
              className={`panel-resizer content-nav-resizer ${activeResizer === 'map' ? 'active' : ''}`}
              onMouseDown={handleMapResizeStart}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize message map panel"
            />
          ) : null}
          <button
            className={`content-nav-toggle ${isMessageMapOpen ? 'open' : 'closed'}`}
            onClick={() => setIsMessageMapOpen((prev) => !prev)}
            title={isMessageMapOpen ? 'Hide message map' : 'Show message map'}
            aria-label={isMessageMapOpen ? 'Hide message map' : 'Show message map'}
          >
            {isMessageMapOpen ? '›' : '‹'}
          </button>
          <aside className={`content-nav ${isMessageMapOpen ? '' : 'collapsed'}`} aria-label={`${itemLabelSingular[0].toUpperCase()}${itemLabelSingular.slice(1)} message navigation`}>
            <div className="content-nav-header">
              <span>Message Map</span>
            </div>
            <div ref={mapListRef} className="content-nav-list" onMouseDown={(e) => startPanning(e, e.currentTarget as HTMLElement)}>
              {navigationMessages.map((msg) => (
                <button
                  key={msg.id}
                  data-message-id={msg.id}
                  className={`content-nav-item ${msg.role === 'user' ? 'role-user' : 'role-assistant'} ${activeMapMessageIds.has(msg.id) ? 'active' : ''} ${mapMatchMessageIds.has(msg.id) ? 'match' : ''}`}
                  onClick={() => jumpToMessageInCurrentChat(msg.id)}
                  title={msg.preview}
                >
                  <span className="content-nav-index">{msg.navIndex}</span>
                  <span className="content-nav-text">{msg.preview}</span>
                </button>
              ))}
            </div>
            <div className="content-nav-search">
              <div className="content-nav-search-row">
                <input
                  type="text"
                  className="content-nav-search-input"
                  placeholder={`Find in this ${itemLabelSingular}...`}
                  value={mapSearchQuery}
                  onMouseDown={(e) => {
                    if (e.button === 1) e.preventDefault();
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) e.preventDefault();
                  }}
                  onPaste={(e) => {
                    const text = e.clipboardData?.getData('text') || '';
                    if (!text) return;
                    e.preventDefault();
                    updateMapSearchQuery(text, 'paste');
                  }}
                  onChange={(e) => updateMapSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    jumpToRelativeMapMatch(e.shiftKey ? -1 : 1);
                  }}
                />
                <div className="content-nav-search-tools">
                  <span className="content-nav-search-count" title={mapSearchQuery.trim() ? 'Current match / total matching messages' : 'Enter at least 2 characters to search'}>
                    {mapSearchQuery.trim().length >= 2 ? `${mapMatchPosition}/${mapMatchCount}` : '0/0'}
                  </span>
                  <div className="content-nav-search-nav-stack">
                    <button
                      type="button"
                      className="content-nav-search-nav"
                      onClick={() => jumpToRelativeMapMatch(-1)}
                      disabled={mapMatchCount === 0}
                      title="Previous match"
                      aria-label="Previous match"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="content-nav-search-nav"
                      onClick={() => jumpToRelativeMapMatch(1)}
                      disabled={mapMatchCount === 0}
                      title="Next match"
                      aria-label="Next match"
                    >
                      ▼
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
        <div className="input-area">
            <div className="input-container">
              {sendError && (
                <div className="send-error-banner">
                  <span>{sendError}</span>
                  <button className="send-error-dismiss" onClick={() => setSendError(null)} aria-label="Dismiss send error">×</button>
                </div>
              )}
              {pastedImage && <div className="image-preview"><img src={pastedImage} alt="Pasted" /><button className="remove-image" onClick={() => setPastedImage(null)}>×</button></div>}
              {attachedFiles.length > 0 && (
                <div className="file-preview-list">
                  {attachedFiles.map((file) => (
                    <div key={file.id} className="file-preview-chip" title={file.name}>
                      <span className="file-preview-name">{file.name}</span>
                      <button className="file-preview-remove" onClick={() => setAttachedFiles((prev) => prev.filter((f) => f.id !== file.id))}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  handleAttachFiles(e.target.files).catch((err) => console.error('Attach failed', err));
                  e.currentTarget.value = '';
                }}
              />
	              <div className="input-wrapper">
	                {canSend ? (
	                  <div className="model-picker-container">
	                    <button className={`model-picker-trigger ${showModelMenu ? 'active' : ''}`} onClick={() => setShowModelMenu(!showModelMenu)} title="Select Model"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M7 14l5-5 5 5z"/></svg></button>
	                    <button className="attach-btn" onClick={() => fileInputRef.current?.click()} title="Attach files">
	                      <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M16.5 6.5l-7.79 7.79a2 2 0 1 0 2.83 2.83l7.08-7.08a4 4 0 1 0-5.66-5.66L5.17 12.17a6 6 0 1 0 8.49 8.49l6.36-6.36-1.41-1.41-6.36 6.36a4 4 0 1 1-5.66-5.66l7.79-7.79a2 2 0 1 1 2.83 2.83l-7.08 7.08-.71-.71 6.72-6.72 1.41 1.41-6.72 6.72a2 2 0 0 1-2.83-2.83l7.79-7.79 1.41 1.41z"/></svg>
	                    </button>
	                    {showModelMenu && <div className="model-picker-menu">{['Auto', 'Instant 5.3', 'Thinking 5.4 Standard', 'Thinking 5.4 Extended', 'Thinking 5.5 Standard', 'Thinking 5.5 Extended'].map(m => <button key={m} className={`model-picker-option ${selectedModel === m ? 'active' : ''}`} onClick={() => { setSelectedModel(m); setShowModelMenu(false); }}>{m}</button>)}</div>}
	                  </div>
	                ) : null}
			              <textarea
			                ref={textareaRef}
			                className="chat-input"
	                placeholder={canSend ? 'Send a message...' : `${account.label} archive (read-only)`}
		                rows={1}
			                value={inputValue}
	                disabled={!canSend}
			                onChange={(e) => setInputValue(e.target.value)}
		                onPointerDownCapture={(e) => {
		                  if (e.button !== 1) return;
		                  markMiddlePasteSuppressed();
		                  e.preventDefault();
		                }}
		                onMouseDown={(e) => {
		                  if (e.button !== 1) return;
		                  markMiddlePasteSuppressed();
		                  e.preventDefault();
		                }}
		                onMouseUp={(e) => {
		                  if (e.button !== 1) return;
		                  e.preventDefault();
		                }}
		                onAuxClick={(e) => {
		                  if (e.button !== 1) return;
		                  e.preventDefault();
		                }}
		                onPaste={(e) => {
		                  const shouldSuppress = suppressMiddlePasteRef.current || Date.now() < suppressMiddlePasteUntilRef.current;
		                  if (!shouldSuppress) return;
		                  e.preventDefault();
		                  suppressMiddlePasteRef.current = false;
		                  suppressMiddlePasteUntilRef.current = 0;
		                }}
		                onKeyDown={(e) => {
		                  if (e.key === 'Enter' && !e.shiftKey) {
		                    e.preventDefault();
		                    handleSend();
		                  }
		                }}
		                onBlur={() => {
		                  suppressMiddlePasteRef.current = false;
		                  suppressMiddlePasteUntilRef.current = 0;
		                }}
		              />
	              {bridgeActivityLabel && !sendError && (
	                <span className={`bridge-status-inline ${bridgeComposerStatus?.state === 'error' ? 'error' : ''}`}>
	                  {bridgeActivityLabel}
	                </span>
	              )}
	              <button className={`send-btn ${isBridgeReadyForActiveConversation ? 'ready' : 'not-ready'}`} onClick={handleSend} disabled={isSendDisabled}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
	            </div>
          </div>
        </div>
      </div>
      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Settings</h2>
              <button className="close-modal" onClick={() => setShowSettings(false)}>×</button>
            </div>
            <div className="setting-item">
              <label>Font Size <span className="setting-value">{fontSize}pt</span></label>
              <input type="range" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} value={fontSize} onChange={(e) => setFontSize(parseInt(e.target.value, 10))} />
            </div>
            <div className="setting-item">
              <label>Content Column Width <span className="setting-value">{chatWidth}px</span></label>
              <input type="range" min="400" max="5000" step="50" value={chatWidth} onChange={(e) => setChatWidth(parseInt(e.target.value))} />
            </div>
            <div className="setting-item">
              <label>Account & Sync</label>
              <div className="settings-action-list">
	                {isLiveChatGPT ? (
	                  <>
	                    <button className="settings-action-btn" onClick={handleAudit} title="Check for chats deleted on web and mark local cache accordingly">
	                      Check for auto deletions
	                    </button>
	                    <button className="settings-action-btn" onClick={handleReauth} disabled={isReauthenticating} title="Clear ChatGPT session data and log in again">
	                      {isReauthenticating ? 'Re-authenticating...' : 'Re-authenticate'}
	                    </button>
	                  </>
	                ) : (
	                  <div className="settings-note">
	                    {canRefreshLocal
	                      ? 'This account is populated from local session files.'
	                      : canLiveSync
	                        ? `${account.agentName} uses its live bridge and local cache.`
	                        : 'This account is populated from an imported backup.'}
	                  </div>
	                )}
	              </div>
	            </div>
          </div>
        </div>
      )}
      {showSearch && (
        <div className="modal-backdrop" onClick={closeSearch}>
          <div className="search-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{`Search ${itemLabel[0].toUpperCase()}${itemLabel.slice(1)}`}</h2>
              <button className="close-modal" onClick={closeSearch}>×</button>
            </div>
            <div className="search-input-container">
              <input
                autoFocus
                type="text"
                placeholder="Search all messages..."
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
              />
            </div>
	            {trimmedSearchQuery && (
	              <div className="search-results-meta">
	                {searchMatchCountLabel} match{searchMatchCount === 1 && !searchTotalIsLowerBound ? '' : 'es'}
	              </div>
	            )}
	            <div className="search-results">
	              {searchResults.length === 0 && trimmedSearchQuery !== '' && (
	                <div className="no-results">No messages found matching "{searchQuery}"</div>
	              )}
              {searchResults.map(res => (
                <div key={res.id} className="search-result-item" onClick={() => jumpToSearchResult(res)}>
                  <div className="search-result-header">
                    <span className="search-result-title">{res.conversation_title}</span>
                    <span className="search-result-role">{res.role}</span>
                  </div>
	                  <div className="search-result-content">
	                    {(() => {
		                      const text = res.content;
		                      const terms = searchQuery
		                        .toLowerCase()
		                        .split(/\s+/)
		                        .map(term => term.trim())
		                        .filter(Boolean);
		                      const lowered = text.toLowerCase();
		                      const phraseTerms = terms.map(term => escapeRegExp(term));
		                      const escapedTerms = terms
		                        .map(term => escapeRegExp(term))
		                        .sort((a, b) => b.length - a.length);
		                      const phrasePattern = phraseTerms.length > 1
		                        ? new RegExp(phraseTerms.map(term => `${term}[a-z0-9_-]*`).join('[^a-z0-9]+'), 'i')
		                        : null;
		                      const phraseMatch = phrasePattern ? lowered.match(phrasePattern) : null;
		                      const indices = escapedTerms
		                        .map(term => lowered.search(new RegExp(`${term}[a-z0-9_-]*`, 'i')))
		                        .filter(idx => idx >= 0);
		                      const idx = phraseMatch?.index ?? (indices.length > 0 ? Math.min(...indices) : lowered.indexOf(searchQuery.toLowerCase()));
		                      const previewIndex = Math.max(0, idx);
		                      const start = Math.max(0, previewIndex - 60);
		                      const end = Math.min(text.length, previewIndex + 100);
		                      const preview = (start > 0 ? '...' : '') + text.substring(start, end) + (end < text.length ? '...' : '');
		                      if (terms.length === 0) {
		                        return preview;
		                      }
		                      const parts = preview.split(new RegExp(`(${escapedTerms.map(term => `${term}[a-z0-9_-]*`).join('|')})`, 'gi'));
		                      return parts.map((part, i) => terms.some(term => part.toLowerCase().startsWith(term)) ? <span key={i} className="search-highlight">{part}</span> : part);
		                    })()}
	                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {conversationContextMenu && (
        <div
          className="conversation-context-menu"
          style={{ left: conversationContextMenu.x, top: conversationContextMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="conversation-context-menu-item"
            onClick={() => handleDeleteConversation(conversationContextMenu.conversationId)}
          >
            Delete locally
          </button>
        </div>
      )}
      {fullscreenImage && (
        <div className="image-lightbox" onClick={() => { setImageMenu(null); setFullscreenImage(null); }}>
          <button className="image-lightbox-close" onClick={() => setFullscreenImage(null)} aria-label="Close image preview">×</button>
          <img
            className="image-lightbox-content"
            src={fullscreenImage}
            alt="Full size chat image"
            onClick={(e) => { e.stopPropagation(); setImageMenu(null); }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setImageMenu({ x: e.clientX, y: e.clientY });
            }}
          />
          {imageMenu && (
            <div
              className="image-context-menu"
              style={{ left: imageMenu.x, top: imageMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <button className="image-context-menu-item" onClick={handleCopyFullscreenImage}>Copy image</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
