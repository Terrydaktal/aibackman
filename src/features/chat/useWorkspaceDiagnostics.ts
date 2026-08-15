import { useCallback, useEffect, useRef } from 'react';

export interface WorkspaceDiagnosticStats {
  mapQuery: string;
  navigationCount: number;
  visibleCount: number;
  displayCount: number;
  displayViewCount: number;
}

interface DiagnosticEntry {
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
  const enabledRef = useRef(
    localStorage.getItem('oomDebug') === '1' || window.electronAPI.debugEnabled === true,
  );
  const entriesRef = useRef<DiagnosticEntry[]>([]);
  const statsRef = useRef(EMPTY_STATS);

  const push = useCallback((event: string, payload: Record<string, unknown> = {}) => {
    if (!enabledRef.current) return;
    const entry: DiagnosticEntry = {
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
    entries.push(entry);
    if (entries.length > 600) entries.splice(0, entries.length - 600);
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
        localStorage.setItem('oomDebug', '1');
        enabledRef.current = true;
        console.info('[oom-debug] enabled');
      },
      disable: () => {
        localStorage.removeItem('oomDebug');
        enabledRef.current = false;
        console.info('[oom-debug] disabled');
      },
      clear: () => {
        entriesRef.current = [];
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
        ...statsRef.current,
      }),
    };
    (window as Window & { __aibackmanOomDebug?: typeof api }).__aibackmanOomDebug = api;
    return () => {
      const target = window as Window & { __aibackmanOomDebug?: typeof api };
      if (target.__aibackmanOomDebug === api) delete target.__aibackmanOomDebug;
    };
  }, []);

  useEffect(() => {
    if (!enabledRef.current || typeof PerformanceObserver === 'undefined') return;
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
  }, [push]);

  useEffect(() => {
    if (!enabledRef.current) return;
    const id = window.setInterval(() => {
      const current = statsRef.current;
      push('heartbeat', {
        mapQueryLen: current.mapQuery.length,
        navCount: current.navigationCount,
        visibleCount: current.visibleCount,
        displayCount: current.displayCount,
        displayViewCount: current.displayViewCount,
      });
    }, 2000);
    return () => window.clearInterval(id);
  }, [push]);

  return { push, updateStats };
}
