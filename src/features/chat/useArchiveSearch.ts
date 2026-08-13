import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '../../types';

export type MessageSearchResult = Pick<Message, 'id' | 'conversation_id' | 'role' | 'content'> & {
  conversation_title: string;
};

interface UseArchiveSearchOptions {
  invoke: (channel: string, payload?: Record<string, unknown>) => Promise<unknown>;
  onNavigate: (result: MessageSearchResult, query: string) => void;
}

interface SearchResponse {
  results?: unknown;
  total?: unknown;
  total_is_lower_bound?: unknown;
}

const isMessageSearchResult = (value: unknown): value is MessageSearchResult => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<MessageSearchResult>;
  return typeof row.id === 'string'
    && typeof row.conversation_id === 'string'
    && typeof row.conversation_title === 'string'
    && typeof row.content === 'string'
    && (row.role === 'user' || row.role === 'assistant');
};

export function useArchiveSearch({ invoke, onNavigate }: UseArchiveSearchOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalIsLowerBound, setTotalIsLowerBound] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const requestTokenRef = useRef(0);

  const close = useCallback(() => setIsOpen(false), []);
  const open = useCallback(() => setIsOpen(true), []);

  const search = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const trimmed = nextQuery.trim();
    if (!trimmed) {
      requestTokenRef.current += 1;
      setResults([]);
      setTotalCount(0);
      setTotalIsLowerBound(false);
      return;
    }
    const requestToken = requestTokenRef.current + 1;
    requestTokenRef.current = requestToken;
    debounceRef.current = window.setTimeout(async () => {
      try {
        const raw = await invoke('db:searchMessages', { query: trimmed });
        if (requestTokenRef.current !== requestToken) return;
        const response = raw as SearchResponse | unknown[] | null;
        const rows = Array.isArray(response) ? response : response?.results;
        const filtered = (Array.isArray(rows) ? rows : []).filter(isMessageSearchResult);
        setResults(filtered);
        setTotalCount(
          !Array.isArray(response) && typeof response?.total === 'number'
            ? response.total
            : filtered.length,
        );
        setTotalIsLowerBound(!Array.isArray(response) && response?.total_is_lower_bound === true);
      } catch (error) {
        console.warn('Search failed:', error);
      }
    }, 180);
  }, [invoke]);

  const navigate = useCallback((result: MessageSearchResult) => {
    onNavigate(result, query);
    setIsOpen(false);
  }, [onNavigate, query]);

  useEffect(() => () => {
    requestTokenRef.current += 1;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
  }, []);

  return {
    close,
    isOpen,
    navigate,
    open,
    query,
    results,
    search,
    totalCount,
    totalIsLowerBound,
  };
}
