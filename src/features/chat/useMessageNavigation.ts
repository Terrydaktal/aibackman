import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import {
  buildNativeSearchRanges,
  clearNativeSearchHighlights,
  createWhitespaceFlexibleSearchRegExp,
  getNativeSearchRangeRect,
  registerNativeSearchHighlights,
  supportsNativeSearchHighlights,
} from '../../search/nativeHighlights';
import {
  countLines,
  countNeedleHits,
  findTextOccurrenceRect,
  getDisplayMessageSearchText,
  getMessagePreview,
  isNavigableMessage,
  MAX_MAP_SEARCH_QUERY_LEN,
  sanitizeMapSearchQuery,
  type DisplayMessage,
} from './ChatPresentation';

interface UseMessageNavigationOptions {
  activeConversationId: string | null;
  displayMessages: DisplayMessage[];
  initialMessageId?: string | null;
  initialSearchQuery?: string;
  isMessageMapOpen: boolean;
  pushDebug: (event: string, payload?: Record<string, unknown>) => void;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}

interface FocusMessageOptions {
  highlightQuery?: string;
  occurrence?: number;
}

export function useMessageNavigation({
  activeConversationId,
  displayMessages,
  initialMessageId = null,
  initialSearchQuery = '',
  isMessageMapOpen,
  pushDebug,
  virtuosoRef,
}: UseMessageNavigationOptions) {
  const [mapSearchQuery, setMapSearchQuery] = useState(initialSearchQuery);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(initialMessageId);
  const [targetOccurrence, setTargetOccurrence] = useState<number | null>(null);
  const [activeHighlightQuery, setActiveHighlightQuery] = useState(initialSearchQuery);
  const [nativeHighlightRevision, setNativeHighlightRevision] = useState(0);
  const [viewportVisibleMessageIds, setViewportVisibleMessageIds] = useState<string[]>([]);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [nativeHighlightsSupported] = useState(() => supportsNativeSearchHighlights());

  const mapJumpLockUntilRef = useRef(0);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const mapListRef = useRef<HTMLDivElement | null>(null);
  const mapOpenRef = useRef(isMessageMapOpen);
  const viewportHighlightRafRef = useRef<number | null>(null);
  const updateViewportRef = useRef<() => void>(() => {});
  const nativeSearchRafRef = useRef<number | null>(null);
  const nativeSearchFallbackTimerRef = useRef<number | null>(null);
  const nativeSearchQueryRef = useRef('');
  const nativeSearchTargetRef = useRef<{ messageId: string | null; occurrence: number | null }>({
    messageId: null,
    occurrence: null,
  });
  const nativeRangesByMessageRef = useRef<Map<string, StaticRange[]>>(new Map());
  const pendingJumpRef = useRef<{ messageId: string; startedAt: number } | null>(null);
  const isNearBottomRef = useRef(true);

  const mapSearchNeedle = useDeferredValue(mapSearchQuery.trim());
  const mapSearchNeedleActive = mapSearchNeedle.length >= 2 && mapSearchNeedle.length <= 80
    ? mapSearchNeedle
    : '';
  const activeHighlightNeedleRaw = activeHighlightQuery.trim();
  const activeHighlightNeedle = activeHighlightNeedleRaw.length >= 2 && activeHighlightNeedleRaw.length <= 80
    ? activeHighlightNeedleRaw
    : '';
  const renderedSearchNeedle = mapSearchNeedleActive || (targetMessageId ? activeHighlightNeedle : '');
  const mapHighlightQuery = mapSearchQuery.trim().length >= 2 ? mapSearchQuery.trim() : '';

  const mapSearchRegex = useMemo(() => {
    if (!mapSearchNeedleActive) return null;
    try {
      return createWhitespaceFlexibleSearchRegExp(mapSearchNeedleActive, 'iu');
    } catch {
      return null;
    }
  }, [mapSearchNeedleActive]);

  const navigationMessages = useMemo(() => (
    displayMessages
      .filter(isNavigableMessage)
      .map((message, index) => ({
        ...message,
        navIndex: index + 1,
        preview: getMessagePreview(message.content),
        searchText: getDisplayMessageSearchText(message),
      }))
  ), [displayMessages]);

  const mapMatchMessageIds = useMemo(() => {
    if (!mapSearchRegex) return new Set<string>();
    const matches = new Set<string>();
    for (const message of navigationMessages) {
      if (message.searchText && mapSearchRegex.test(message.searchText)) matches.add(message.id);
    }
    return matches;
  }, [mapSearchRegex, navigationMessages]);

  const matchingOccurrences = useMemo(() => {
    if (!mapSearchNeedleActive) return [] as Array<{ messageId: string; occurrence: number }>;
    const needle = mapSearchNeedleActive.toLowerCase();
    const occurrences: Array<{ messageId: string; occurrence: number }> = [];
    for (const message of navigationMessages) {
      if (!mapMatchMessageIds.has(message.id)) continue;
      const count = countNeedleHits(message.searchText || '', needle);
      for (let occurrence = 0; occurrence < count; occurrence += 1) {
        occurrences.push({ messageId: message.id, occurrence });
      }
    }
    return occurrences;
  }, [mapMatchMessageIds, mapSearchNeedleActive, navigationMessages]);

  const currentMatchIndex = useMemo(() => {
    if (!targetMessageId) return -1;
    return matchingOccurrences.findIndex((entry) => (
      entry.messageId === targetMessageId && entry.occurrence === (targetOccurrence ?? 0)
    ));
  }, [matchingOccurrences, targetMessageId, targetOccurrence]);

  const mapMatchCount = matchingOccurrences.length;
  const mapMatchPosition = currentMatchIndex >= 0 ? currentMatchIndex + 1 : (mapMatchCount > 0 ? 1 : 0);
  const activeMapMessageIds = useMemo(() => (
    isMessageMapOpen
      ? new Set(viewportVisibleMessageIds)
      : (targetMessageId ? new Set([targetMessageId]) : new Set<string>())
  ), [isMessageMapOpen, targetMessageId, viewportVisibleMessageIds]);

  const refreshNativeHighlights = useCallback(() => {
    nativeSearchRafRef.current = null;
    if (nativeSearchFallbackTimerRef.current !== null) {
      window.clearTimeout(nativeSearchFallbackTimerRef.current);
      nativeSearchFallbackTimerRef.current = null;
    }
    if (!nativeHighlightsSupported) return;
    const query = nativeSearchQueryRef.current;
    const scroller = scrollerRef.current;
    if (!query || !scroller) {
      nativeRangesByMessageRef.current = new Map();
      clearNativeSearchHighlights();
      return;
    }
    try {
      const result = buildNativeSearchRanges(scroller, query);
      nativeRangesByMessageRef.current = result.rangesByMessage;
      const target = nativeSearchTargetRef.current;
      const ranges = target.messageId ? result.rangesByMessage.get(target.messageId) : undefined;
      registerNativeSearchHighlights(result.records, ranges?.[target.occurrence ?? 0] || null);
      setNativeHighlightRevision((revision) => revision + 1);
      pushDebug('native-search-highlights', {
        queryLen: query.length,
        ranges: result.records.length,
        scannedChars: result.scannedChars,
        scannedTextNodes: result.scannedTextNodes,
        capped: result.capped,
      });
    } catch (error) {
      nativeRangesByMessageRef.current = new Map();
      clearNativeSearchHighlights();
      pushDebug('native-search-highlights-failed', {
        error: String((error as Error)?.message || error),
      });
    }
  }, [nativeHighlightsSupported, pushDebug]);

  const scheduleNativeHighlightRefresh = useCallback(() => {
    if (
      !nativeHighlightsSupported
      || nativeSearchRafRef.current !== null
      || nativeSearchFallbackTimerRef.current !== null
    ) return;
    nativeSearchRafRef.current = window.requestAnimationFrame(refreshNativeHighlights);
    nativeSearchFallbackTimerRef.current = window.setTimeout(() => {
      if (nativeSearchRafRef.current !== null) {
        window.cancelAnimationFrame(nativeSearchRafRef.current);
        nativeSearchRafRef.current = null;
      }
      nativeSearchFallbackTimerRef.current = null;
      refreshNativeHighlights();
    }, 100);
  }, [nativeHighlightsSupported, refreshNativeHighlights]);

  const scheduleViewportUpdate = useCallback(() => {
    if (!mapOpenRef.current || viewportHighlightRafRef.current !== null) return;
    viewportHighlightRafRef.current = window.requestAnimationFrame(() => {
      viewportHighlightRafRef.current = null;
      updateViewportRef.current();
    });
  }, []);

  const updateNearBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const distance = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    const next = distance <= 120;
    if (next === isNearBottomRef.current) return;
    isNearBottomRef.current = next;
    setIsNearBottom(next);
  }, []);

  const updateViewport = useCallback(() => {
    if (!isMessageMapOpen || Date.now() < mapJumpLockUntilRef.current) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const viewport = scroller.getBoundingClientRect();
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('.message-row[data-message-id]'));
    const navigableIds = new Set(displayMessages.filter(isNavigableMessage).map((message) => message.id));
    const visibleIds: string[] = [];

    for (const row of rows) {
      const messageId = row.dataset.messageId || null;
      if (!messageId || !navigableIds.has(messageId)) continue;
      const rect = row.getBoundingClientRect();
      const visiblePixels = Math.max(0, Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top));
      const minimum = Math.min(28, Math.max(10, rect.height * 0.2));
      if (visiblePixels >= minimum) visibleIds.push(messageId);
    }
    if (visibleIds.length === 0) {
      for (const row of rows) {
        const messageId = row.dataset.messageId || null;
        if (!messageId || !navigableIds.has(messageId)) continue;
        if (row.getBoundingClientRect().top >= viewport.top) {
          visibleIds.push(messageId);
          break;
        }
      }
    }
    setViewportVisibleMessageIds((current) => {
      if (current.length === visibleIds.length && current.every((id, index) => id === visibleIds[index])) {
        return current;
      }
      pushDebug('map-visible-update', {
        prevCount: current.length,
        nextCount: visibleIds.length,
        topId: visibleIds[0] || null,
        bottomId: visibleIds[visibleIds.length - 1] || null,
      });
      return visibleIds;
    });
  }, [displayMessages, isMessageMapOpen, pushDebug]);

  const handleMessageScroll = useCallback(() => {
    scheduleViewportUpdate();
    updateNearBottom();
  }, [scheduleViewportUpdate, updateNearBottom]);

  const handleMessageScrollerRef = useCallback((value: HTMLElement | Window | null) => {
    const element = value instanceof HTMLElement ? value : null;
    if (scrollerRef.current === element) return;
    scrollerRef.current?.removeEventListener('scroll', handleMessageScroll);
    scrollerRef.current = element;
    element?.addEventListener('scroll', handleMessageScroll, { passive: true });
    handleMessageScroll();
  }, [handleMessageScroll]);

  const handleMessageRangeChanged = useCallback(() => {
    updateViewport();
    scheduleNativeHighlightRefresh();
  }, [scheduleNativeHighlightRefresh, updateViewport]);

  const focusMessage = useCallback((messageId: string, options: FocusMessageOptions = {}) => {
    const occurrence = options.occurrence ?? 0;
    const rowIndex = navigationMessages.findIndex((message) => message.id === messageId);
    const target = rowIndex >= 0 ? navigationMessages[rowIndex] : null;
    pushDebug('map-jump-click', {
      msgId: messageId,
      occurrenceInMessage: occurrence,
      rowIndex,
      scrollerTop: scrollerRef.current ? Math.round(scrollerRef.current.scrollTop) : null,
      mapQueryLen: mapSearchQuery.length,
      visibleHighlighted: viewportVisibleMessageIds.length,
      targetChars: target?.searchText.length || 0,
      targetLines: countLines(target?.searchText || ''),
    });
    mapJumpLockUntilRef.current = Date.now() + 900;
    pendingJumpRef.current = { messageId, startedAt: Date.now() };
    setViewportVisibleMessageIds([messageId]);
    setTargetMessageId(messageId);
    setTargetOccurrence(occurrence);
    setActiveHighlightQuery(options.highlightQuery || '');
  }, [mapSearchQuery.length, navigationMessages, pushDebug, viewportVisibleMessageIds.length]);

  const jumpToRelativeMatch = useCallback((direction: 1 | -1) => {
    if (matchingOccurrences.length === 0) return;
    const index = currentMatchIndex === -1
      ? (direction > 0 ? 0 : matchingOccurrences.length - 1)
      : (currentMatchIndex + direction + matchingOccurrences.length) % matchingOccurrences.length;
    const next = matchingOccurrences[index];
    focusMessage(next.messageId, { occurrence: next.occurrence });
  }, [currentMatchIndex, focusMessage, matchingOccurrences]);

  const updateMapSearchQuery = useCallback((rawQuery: string, source = 'input') => {
    const query = sanitizeMapSearchQuery(rawQuery);
    if (rawQuery.length > MAX_MAP_SEARCH_QUERY_LEN) {
      pushDebug('map-search-truncated', {
        rawLen: rawQuery.length,
        keptLen: query.length,
        source,
      });
    }
    pushDebug('map-search-change', {
      queryLen: query.length,
      navCount: navigationMessages.length,
      source,
    });
    setMapSearchQuery(query);
    setTargetMessageId(null);
    setTargetOccurrence(null);
  }, [navigationMessages.length, pushDebug]);

  const clearTarget = useCallback(() => {
    setTargetMessageId(null);
    setTargetOccurrence(null);
    setActiveHighlightQuery('');
  }, []);

  const clearVisibleMessages = useCallback(() => {
    setViewportVisibleMessageIds([]);
  }, []);

  const restoreInitialTarget = useCallback((messageId?: string | null, query = '') => {
    if (messageId) {
      setTargetMessageId(messageId);
      setTargetOccurrence(0);
    }
    if (query) {
      setMapSearchQuery(query);
      setActiveHighlightQuery(query);
    }
  }, []);

  useEffect(() => {
    if (nativeSearchQueryRef.current !== renderedSearchNeedle) {
      nativeRangesByMessageRef.current = new Map();
      clearNativeSearchHighlights();
    }
    nativeSearchQueryRef.current = renderedSearchNeedle;
    nativeSearchTargetRef.current = { messageId: targetMessageId, occurrence: targetOccurrence };
    scheduleNativeHighlightRefresh();
  }, [
    activeConversationId,
    displayMessages,
    renderedSearchNeedle,
    scheduleNativeHighlightRefresh,
    targetMessageId,
    targetOccurrence,
  ]);

  useEffect(() => {
    if (!nativeHighlightsSupported || !renderedSearchNeedle) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new MutationObserver(scheduleNativeHighlightRefresh);
    observer.observe(scroller, { childList: true, characterData: true, subtree: true });
    scheduleNativeHighlightRefresh();
    return () => observer.disconnect();
  }, [activeConversationId, nativeHighlightsSupported, renderedSearchNeedle, scheduleNativeHighlightRefresh]);

  useEffect(() => {
    if (!activeConversationId || displayMessages.length === 0 || !targetMessageId) return;
    const index = displayMessages.findIndex((message) => message.id === targetMessageId);
    if (index === -1) return;
    const timer = window.setTimeout(() => {
      const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(targetMessageId)
        : targetMessageId.replace(/"/g, '\\"');
      if (document.querySelector(`.message-row[data-message-id="${escapedId}"]`)) return;
      virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [activeConversationId, displayMessages, targetMessageId, virtuosoRef]);

  useEffect(() => {
    if (!targetMessageId || targetOccurrence == null) return;
    let cancelled = false;
    let timer: number | null = null;
    const startedAt = Date.now();
    const scrollToTarget = () => {
      if (cancelled) return;
      const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(targetMessageId)
        : targetMessageId.replace(/"/g, '\\"');
      const row = document.querySelector(`.message-row[data-message-id="${escapedId}"]`);
      if (!row) {
        if (Date.now() - startedAt < 1000) timer = window.setTimeout(scrollToTarget, 60);
        return;
      }
      document.querySelectorAll('mark.chat-highlight.active-match').forEach((node) => {
        node.classList.remove('active-match');
      });
      const marks = row.querySelectorAll('mark.chat-highlight');
      const targetMark = marks.item(targetOccurrence) as HTMLElement | null;
      const messageBody = row.querySelector('.message-content > .markdown-body') || row;
      const nativeRange = nativeHighlightsSupported
        ? nativeRangesByMessageRef.current.get(targetMessageId)?.[targetOccurrence] || null
        : null;
      const textRect = mapSearchNeedleActive
        ? findTextOccurrenceRect(messageBody, mapSearchNeedleActive, targetOccurrence)
        : null;
      const targetRect = getNativeSearchRangeRect(nativeRange)
        || textRect
        || targetMark?.getBoundingClientRect()
        || null;
      if (!targetRect) {
        if (Date.now() - startedAt < 1000) timer = window.setTimeout(scrollToTarget, 60);
        return;
      }
      targetMark?.classList.add('active-match');
      const scroller = scrollerRef.current;
      if (scroller) {
        const viewport = scroller.getBoundingClientRect();
        const nextTop = scroller.scrollTop
          + (targetRect.top - viewport.top)
          - (scroller.clientHeight / 2)
          + (targetRect.height / 2);
        scroller.scrollTo({ top: Math.max(0, nextTop), behavior: 'auto' });
      } else {
        targetMark?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      }
    };
    timer = window.setTimeout(scrollToTarget, 40);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    displayMessages,
    mapSearchNeedleActive,
    nativeHighlightRevision,
    nativeHighlightsSupported,
    targetMessageId,
    targetOccurrence,
  ]);

  useEffect(() => {
    let timer: number | undefined;
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (target?.closest('.content-nav-item') || target?.closest('.content-nav-search')) return;
      clearTarget();
    };
    if (targetMessageId) {
      timer = window.setTimeout(() => window.addEventListener('mousedown', handleMouseDown), 1000);
    }
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [clearTarget, targetMessageId]);

  useEffect(() => {
    updateViewportRef.current = updateViewport;
  }, [updateViewport]);

  useEffect(() => {
    mapOpenRef.current = isMessageMapOpen;
    if (isMessageMapOpen) scheduleViewportUpdate();
  }, [isMessageMapOpen, scheduleViewportUpdate]);

  useEffect(() => {
    window.addEventListener('resize', scheduleViewportUpdate, { passive: true });
    return () => window.removeEventListener('resize', scheduleViewportUpdate);
  }, [scheduleViewportUpdate]);

  useEffect(() => {
    updateNearBottom();
  }, [displayMessages.length, updateNearBottom]);

  useEffect(() => {
    if (!isMessageMapOpen) return;
    const timer = window.setTimeout(updateViewport, 0);
    return () => window.clearTimeout(timer);
  }, [displayMessages, isMessageMapOpen, updateViewport]);

  useEffect(() => {
    if (!isMessageMapOpen) return;
    const mapList = mapListRef.current;
    const anchorId = viewportVisibleMessageIds[0];
    if (!mapList || !anchorId) return;
    const target = mapList.querySelector<HTMLElement>(`.content-nav-item[data-message-id="${anchorId}"]`);
    if (!target) return;
    const padding = 10;
    const viewTop = mapList.scrollTop + padding;
    const viewBottom = mapList.scrollTop + mapList.clientHeight - padding;
    const itemTop = target.offsetTop;
    const itemBottom = itemTop + target.offsetHeight;
    if (itemTop < viewTop) {
      mapList.scrollTop = Math.max(0, itemTop - padding);
    } else if (itemBottom > viewBottom) {
      mapList.scrollTop = Math.max(0, itemBottom - mapList.clientHeight + padding);
    }
  }, [isMessageMapOpen, viewportVisibleMessageIds]);

  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending || !viewportVisibleMessageIds.includes(pending.messageId)) return;
    pushDebug('map-jump-settled', {
      msgId: pending.messageId,
      elapsedMs: Date.now() - pending.startedAt,
      visibleCount: viewportVisibleMessageIds.length,
    });
    pendingJumpRef.current = null;
  }, [pushDebug, viewportVisibleMessageIds]);

  useEffect(() => () => {
    if (viewportHighlightRafRef.current !== null) cancelAnimationFrame(viewportHighlightRafRef.current);
    if (nativeSearchRafRef.current !== null) window.cancelAnimationFrame(nativeSearchRafRef.current);
    if (nativeSearchFallbackTimerRef.current !== null) window.clearTimeout(nativeSearchFallbackTimerRef.current);
    scrollerRef.current?.removeEventListener('scroll', handleMessageScroll);
    nativeRangesByMessageRef.current = new Map();
    clearNativeSearchHighlights();
  }, [handleMessageScroll]);

  return {
    activeHighlightQuery,
    activeMapMessageIds,
    clearTarget,
    clearVisibleMessages,
    focusMessage,
    handleMessageRangeChanged,
    handleMessageScrollerRef,
    isNearBottom,
    jumpToRelativeMatch,
    mapHighlightQuery,
    mapListRef,
    mapMatchCount,
    mapMatchMessageIds,
    mapMatchPosition,
    mapSearchNeedle,
    mapSearchQuery,
    nativeHighlightsSupported,
    navigationMessages,
    restoreInitialTarget,
    scheduleViewportUpdate,
    scrollerRef,
    targetMessageId,
    updateMapSearchQuery,
    updateViewport,
    viewportVisibleMessageIds,
  };
}
