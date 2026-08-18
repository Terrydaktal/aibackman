import { useCallback, useEffect, useState } from 'react';

interface CacheProgress {
  stage?: unknown;
  processed?: unknown;
  failed?: unknown;
  inspected?: unknown;
  total?: unknown;
  pauseMs?: unknown;
}

interface CacheDiagnosticsResponse {
  uncachedCount?: unknown;
  failedCount?: unknown;
  unknownCount?: unknown;
  newMessagesCount?: unknown;
  resyncCount?: unknown;
  dirtyCount?: unknown;
  uncachedRows?: Array<{ id?: unknown }>;
  newMessageRows?: Array<{ id?: unknown }>;
  resyncRows?: Array<{ id?: unknown }>;
}

interface CacheRunResult {
  success?: unknown;
  cancelled?: unknown;
  processed?: unknown;
  failed?: unknown;
  reason?: unknown;
}

interface UseCacheManagementOptions {
  enabled: boolean;
  invoke: (channel: string, payload?: Record<string, unknown>) => Promise<unknown>;
  refreshRevision: unknown;
}

const idsFromRows = (rows: unknown) => (
  Array.isArray(rows)
    ? rows.map((row: { id?: unknown }) => String(row?.id || '')).filter(Boolean)
    : []
);

export function useCacheManagement({ enabled, invoke, refreshRevision }: UseCacheManagementOptions) {
  const [stats, setStats] = useState({ localCount: 0, cachedCount: 0 });
  const [diagnostics, setDiagnostics] = useState({
    uncachedCount: 0,
    failedCount: 0,
    unknownCount: 0,
    newMessagesCount: 0,
    resyncCount: 0,
    dirtyCount: 0,
  });
  const [uncachedConversationIds, setUncachedConversationIds] = useState<Set<string>>(new Set());
  const [dirtyConversationIds, setDirtyConversationIds] = useState<Set<string>>(new Set());
  const [newMessageConversationIds, setNewMessageConversationIds] = useState<Set<string>>(new Set());
  const [resyncConversationIds, setResyncConversationIds] = useState<Set<string>>(new Set());
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState('');

  const refreshStats = useCallback(async () => {
    const value = await invoke('db:getStats') as { localCount?: unknown; cachedCount?: unknown } | null;
    setStats({
      localCount: Number(value?.localCount || 0),
      cachedCount: Number(value?.cachedCount || 0),
    });
  }, [invoke]);

  const refreshDiagnostics = useCallback(async () => {
    const value = await invoke('db:getCacheDiagnostics') as CacheDiagnosticsResponse | null;
    if (!value) return;
    setDiagnostics({
      uncachedCount: Number(value.uncachedCount || 0),
      failedCount: Number(value.failedCount || 0),
      unknownCount: Number(value.unknownCount || 0),
      newMessagesCount: Number(value.newMessagesCount || 0),
      resyncCount: Number(value.resyncCount || 0),
      dirtyCount: Number(value.dirtyCount || 0),
    });
    const uncachedIds = new Set(idsFromRows(value.uncachedRows));
    const newMessageIds = new Set(idsFromRows(value.newMessageRows));
    const resyncIds = new Set(idsFromRows(value.resyncRows));
    setUncachedConversationIds(uncachedIds);
    setNewMessageConversationIds(newMessageIds);
    setResyncConversationIds(resyncIds);
    setDirtyConversationIds(new Set([...newMessageIds, ...resyncIds]));
  }, [invoke]);

  const clearUncached = useCallback((conversationId: string) => {
    setUncachedConversationIds((current) => {
      if (!current.has(conversationId)) return current;
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
  }, []);

  const clearDirty = useCallback((conversationId: string) => {
    setDirtyConversationIds((current) => {
      if (!current.has(conversationId)) return current;
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
    setNewMessageConversationIds((current) => {
      if (!current.has(conversationId)) return current;
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
    setResyncConversationIds((current) => {
      if (!current.has(conversationId)) return current;
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
  }, []);

  const refreshCounts = useCallback(async () => {
    await Promise.all([refreshStats(), refreshDiagnostics()]);
  }, [refreshDiagnostics, refreshStats]);

  const runCache = useCallback(async (retryFailed: boolean) => {
    if (!enabled || isRunning || (retryFailed && diagnostics.failedCount === 0)) return;
    setIsRunning(true);
    setStatus(retryFailed ? 'Retrying failed chats...' : 'Starting cache run...');
    try {
      const result = await invoke(retryFailed ? 'api:cacheFailed' : 'api:cacheAll') as CacheRunResult | null;
      if (result?.cancelled) {
        await refreshCounts();
        setStatus(`${retryFailed ? 'Retry' : 'Cache run'} stopped: ${Number(result.processed || 0)} synced, ${Number(result.failed || 0)} failed.`);
        return;
      }
      if (result && result.success === false) {
        const reason = String(result.reason || 'unknown reason');
        console.error(`${retryFailed ? 'Retry failed-cache' : 'Cache All'} rejected:`, reason);
        setStatus(`${retryFailed ? 'Retry' : 'Cache'} rejected: ${reason}`);
        return;
      }
      await refreshCounts();
      setStatus(`${retryFailed ? 'Retry' : 'Cache run'} complete: ${Number(result?.processed || 0)} cached, ${Number(result?.failed || 0)} failed.`);
    } catch (error) {
      console.error(retryFailed ? 'Retry failed-cache pass failed' : 'Cache All failed', error);
      setStatus(`${retryFailed ? 'Retry' : 'Cache run'} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRunning(false);
    }
  }, [diagnostics.failedCount, enabled, invoke, isRunning, refreshCounts]);

  const cacheAll = useCallback(() => runCache(false), [runCache]);
  const retryFailed = useCallback(() => runCache(true), [runCache]);

  const stop = useCallback(async () => {
    if (!isRunning) return;
    setStatus('Stopping cache run...');
    try {
      await invoke('api:cancelCache');
    } catch (error) {
      console.error('Failed to stop cache run', error);
      setStatus(`Could not stop cache run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [invoke, isRunning]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshCounts(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshCounts, refreshRevision]);

  useEffect(() => {
    if (!window.electronAPI.onCacheProgress) return;
    const unsubscribe = window.electronAPI.onCacheProgress((payload?: unknown) => {
      if (payload && typeof payload === 'object') {
        const progress = payload as CacheProgress;
        const stage = String(progress.stage || '');
        const processed = Number(progress.processed || 0);
        const failed = Number(progress.failed || 0);
        const inspected = Number(progress.inspected || 0);
        const total = Number(progress.total || 0);
        if (stage === 'run-start') setStatus(`Cache run started: 0/${total} processed.`);
        else if (stage === 'chat-start') setStatus(`Syncing chat ${inspected}/${total}...`);
        else if (stage === 'chat-success') setStatus(`Synced ${processed}/${total} chats (${failed} failed).`);
        else if (stage === 'chat-fail') setStatus(`Failed ${failed} chats so far (${processed}/${total} synced).`);
        else if (stage === 'chat-pause') setStatus(`Waiting ${(Number(progress.pauseMs || 0) / 1000).toFixed(1)}s before next chat...`);
        else if (stage === 'run-complete') setStatus(`Cache run complete: ${processed} synced, ${failed} failed.`);
        else if (stage === 'run-cancelled') setStatus(`Cache run stopped: ${processed} synced, ${failed} failed.`);
      }
      void refreshCounts();
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, [refreshCounts]);

  return {
    cacheAll,
    clearDirty,
    clearUncached,
    diagnostics,
    dirtyConversationIds,
    newMessageConversationIds,
    resyncConversationIds,
    isRunning,
    refreshDiagnostics,
    refreshStats,
    retryFailed,
    stats,
    status,
    stop,
    uncachedConversationIds,
  };
}
