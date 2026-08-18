import { useCallback, useEffect, useRef, useState } from 'react';

export interface WorkspaceDiagnosticStats {
  mapQuery: string;
  navigationCount: number;
  visibleCount: number;
  displayCount: number;
  displayViewCount: number;
}

interface DiagnosticEntry {
  sequence: number;
  ts: number;
  event: string;
  payload: Record<string, unknown>;
}

const getHeapSnapshot = () => {
  const perf = performance as Performance & {
    memory?: {
      jsHeapSizeLimit: number;
      totalJSHeapSize: number;
      usedJSHeapSize: number;
    };
  };
  if (!perf.memory) return null;
  return {
    usedMB: Math.round((perf.memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10,
    totalMB: Math.round((perf.memory.totalJSHeapSize / (1024 * 1024)) * 10) / 10,
    limitMB: Math.round((perf.memory.jsHeapSizeLimit / (1024 * 1024)) * 10) / 10,
  };
};

const EMPTY_STATS: WorkspaceDiagnosticStats = {
  mapQuery: '',
  navigationCount: 0,
  visibleCount: 0,
  displayCount: 0,
  displayViewCount: 0,
};

export function useWorkspaceDiagnostics() {
  const authorized = window.electronAPI.debugEnabled === true;
  const [enabled, setEnabled] = useState(authorized);
  const enabledRef = useRef(enabled);
  const entriesRef = useRef<DiagnosticEntry[]>([]);
  const statsRef = useRef(EMPTY_STATS);
  const sequenceRef = useRef(0);
  const droppedRef = useRef(0);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const push = useCallback((event: string, payload: Record<string, unknown> = {}) => {
    if (!enabledRef.current) return;
    const entry: DiagnosticEntry = {
      sequence: ++sequenceRef.current,
      ts: Date.now(),
      event,
      payload: {
        ...payload,
        dom: {
          messageRows: document.querySelectorAll('.message-row[data-message-id]').length,
          mapItems: document.querySelectorAll('.content-nav-item').length,
          highlightMarks: document.querySelectorAll('mark.chat-highlight').length,
          katexNodes: document.querySelectorAll('.katex').length,
        },
        heap: getHeapSnapshot(),
      },
    };
    const entries = entriesRef.current;
    if (entries.length >= 600) {
      entries.shift();
      droppedRef.current += 1;
    }
    entries.push(entry);
    console.debug('[oom-debug]', entry.event, JSON.stringify(entry.payload));
  }, []);

  const updateStats = useCallback((stats: WorkspaceDiagnosticStats) => {
    statsRef.current = stats;
    if (!enabledRef.current) return;
    push('render-stats', {
      mapQueryLen: stats.mapQuery.length,
      navCount: stats.navigationCount,
      visibleCount: stats.visibleCount,
      displayCount: stats.displayCount,
      displayViewCount: stats.displayViewCount,
    });
  }, [push]);

  useEffect(() => {
    const api = {
      enable: () => {
        if (!authorized) {
          console.warn('[oom-debug] diagnostics are unavailable in release-minimal mode');
          return false;
        }
        enabledRef.current = true;
        setEnabled(true);
        console.info('[oom-debug] enabled');
        return true;
      },
      disable: () => {
        enabledRef.current = false;
        setEnabled(false);
        console.info('[oom-debug] disabled');
      },
      clear: () => {
        entriesRef.current = [];
        droppedRef.current = 0;
        console.info('[oom-debug] cleared');
      },
      dump: () => {
        const rows = entriesRef.current.map((entry) => ({
          iso: new Date(entry.ts).toISOString(),
          event: entry.event,
          ...entry.payload,
        }));
        console.table(rows);
        return rows;
      },
      snapshot: () => ({
        now: new Date().toISOString(),
        heap: getHeapSnapshot(),
        sequence: sequenceRef.current,
        dropped: droppedRef.current,
        ...statsRef.current,
      }),
    };
    (window as Window & { __aibackmanOomDebug?: typeof api }).__aibackmanOomDebug = api;
    return () => {
      const target = window as Window & { __aibackmanOomDebug?: typeof api };
      if (target.__aibackmanOomDebug === api) delete target.__aibackmanOomDebug;
    };
  }, [authorized]);

  useEffect(() => {
    if (!enabled || typeof PerformanceObserver === 'undefined') return;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 120) {
            push('longtask', {
              name: entry.name,
              startTime: Math.round(entry.startTime),
              durationMs: Math.round(entry.duration),
            });
          }
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // Chromium versions without long-task observation still retain explicit diagnostics.
    }
    return () => observer?.disconnect();
  }, [enabled, push]);

  useEffect(() => {
    if (!enabled) return;
    const publish = () => {
      const current = statsRef.current;
      void window.electronAPI.invoke('diagnostics:rendererSnapshot', {
        label: 'workspace',
        sequence: sequenceRef.current,
        dropped: droppedRef.current,
        stats: {
          ...current,
          mapQuery: undefined,
          mapQueryLen: current.mapQuery.length,
        },
        recent_events: entriesRef.current.slice(-20).map((entry) => ({
          sequence: entry.sequence,
          ts: entry.ts,
          event: entry.event,
          payload: entry.payload,
        })),
      }).then((result) => {
        if ((result as { accepted?: boolean } | null)?.accepted === false) {
          enabledRef.current = false;
          setEnabled(false);
        }
      }).catch(() => undefined);
    };
    publish();
    const id = window.setInterval(() => {
      const current = statsRef.current;
      push('heartbeat', {
        mapQueryLen: current.mapQuery.length,
        navCount: current.navigationCount,
        visibleCount: current.visibleCount,
        displayCount: current.displayCount,
        displayViewCount: current.displayViewCount,
      });
      publish();
    }, 2000);
    return () => window.clearInterval(id);
  }, [enabled, push]);

  return { push, updateStats };
}
