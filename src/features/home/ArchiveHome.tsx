import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentAccount, AgentOverview, ArchiveOverview, GlobalSearchResult } from '../../types';

export interface ArchiveNavigationTarget {
  conversationId?: string;
  messageId?: string;
  query?: string;
}

interface ArchiveHomeProps {
  onOpenAccount: (account: AgentAccount, target?: ArchiveNavigationTarget) => void;
}

const resultPreview = (content: string, query: string) => {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();
  const index = normalized.toLowerCase().indexOf(query.trim().toLowerCase());
  const start = Math.max(0, index < 0 ? 0 : index - 80);
  const end = Math.min(normalized.length, start + 240);
  return `${start > 0 ? '...' : ''}${normalized.slice(start, end)}${end < normalized.length ? '...' : ''}`;
};

const formatCount = (value: number | undefined) => new Intl.NumberFormat().format(Number(value || 0));

const summarizeRefresh = (label: string, result: unknown) => {
  const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : null;
  const rows = Array.isArray(resultRecord?.results) ? resultRecord.results : [result];
  const readNumber = (row: unknown, key: string) => (
    row && typeof row === 'object' ? Number((row as Record<string, unknown>)[key] || 0) : 0
  );
  const importedConversations = rows.reduce((sum, row) => sum + readNumber(row, 'importedConversations'), 0);
  const importedMessages = rows.reduce((sum, row) => sum + readNumber(row, 'importedMessages'), 0);
  const skippedFiles = rows.reduce((sum, row) => sum + readNumber(row, 'skippedFiles'), 0);
  const parseErrors = rows.reduce((sum, row) => sum + readNumber(row, 'parseErrors'), 0);
  if (importedConversations || importedMessages) {
    return `${label}: imported ${formatCount(importedConversations)} chats and ${formatCount(importedMessages)} messages${skippedFiles ? `; skipped ${formatCount(skippedFiles)} unchanged files` : ''}${parseErrors ? `; ${formatCount(parseErrors)} parse errors` : ''}.`;
  }
  return `${label}: no changes found${skippedFiles ? `; ${formatCount(skippedFiles)} files were unchanged` : ''}${parseErrors ? `; ${formatCount(parseErrors)} parse errors` : ''}.`;
};

export function ArchiveHome({ onOpenAccount }: ArchiveHomeProps) {
  const [overview, setOverview] = useState<ArchiveOverview | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GlobalSearchResult[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [addingAgent, setAddingAgent] = useState<AgentOverview | null>(null);
  const [newAccountLabel, setNewAccountLabel] = useState('');
  const [renamingAccount, setRenamingAccount] = useState<AgentAccount | null>(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [actionStatus, setActionStatus] = useState('');
  const searchTokenRef = useRef(0);

  const loadOverview = useCallback(async () => {
    try {
      const next = await window.electronAPI.invoke('archive:getOverview');
      setOverview(next);
      setError('');
    } catch (loadError) {
      setError(String((loadError as Error)?.message || loadError));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOverview(), 0);
    return () => window.clearTimeout(timer);
  }, [loadOverview]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onArchiveChanged?.(() => void loadOverview());
    return () => unsubscribe?.();
  }, [loadOverview]);

  useEffect(() => {
    const trimmed = query.trim();
    const token = ++searchTokenRef.current;
    if (!trimmed) return;
    const timer = window.setTimeout(async () => {
      try {
        const output = await window.electronAPI.invoke('archive:globalSearch', { query: trimmed, limit: 200 });
        if (searchTokenRef.current !== token) return;
        setSearchResults(Array.isArray(output?.results) ? output.results : []);
        setSearchTotal(Number(output?.total || 0));
        setError('');
      } catch (searchError) {
        if (searchTokenRef.current === token) setError(String((searchError as Error)?.message || searchError));
      } finally {
        if (searchTokenRef.current === token) setSearching(false);
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (value.trim()) {
      setSearching(true);
      return;
    }
    searchTokenRef.current += 1;
    setSearchResults([]);
    setSearchTotal(0);
    setSearching(false);
  };

  const accountsById = useMemo(() => new Map(
    (overview?.agents || []).flatMap((agent) => agent.accounts).map((account) => [account.id, account])
  ), [overview]);

  const chooseBackupPath = async () => window.electronAPI.invoke('archive:chooseBackupPath');

  const importIntoAccount = async (account: AgentAccount) => {
    const selectedPath = await chooseBackupPath();
    if (!selectedPath) return;
    setBusyAccountId(account.id);
    try {
      await window.electronAPI.invoke('archive:importBackup', { accountId: account.id, path: selectedPath });
      await loadOverview();
    } catch (importError) {
      setError(String((importError as Error)?.message || importError));
    } finally {
      setBusyAccountId(null);
    }
  };

  const createBackupAccount = async () => {
    if (!addingAgent) return;
    const selectedPath = await chooseBackupPath();
    if (!selectedPath) return;
    setBusyAccountId(`new:${addingAgent.id}`);
    try {
      const account = await window.electronAPI.invoke('archive:createAccount', {
        agentId: addingAgent.id,
        label: newAccountLabel.trim() || `${addingAgent.name} backup`,
        sourceKind: 'backup',
      });
      await window.electronAPI.invoke('archive:importBackup', { accountId: account.id, path: selectedPath });
      setAddingAgent(null);
      setNewAccountLabel('');
      await loadOverview();
    } catch (createError) {
      setError(String((createError as Error)?.message || createError));
    } finally {
      setBusyAccountId(null);
    }
  };

  const refreshLocal = async (account: AgentAccount) => {
    setBusyAccountId(account.id);
    setActionStatus('');
    try {
      const result = await window.electronAPI.invoke('archive:refreshLocal', { accountId: account.id });
      setActionStatus(summarizeRefresh(account.label, result));
      await loadOverview();
    } catch (refreshError) {
      setError(String((refreshError as Error)?.message || refreshError));
    } finally {
      setBusyAccountId(null);
    }
  };

  const refreshAllLocal = async (agent: AgentOverview) => {
    const busyId = `agent:${agent.id}`;
    setBusyAccountId(busyId);
    setActionStatus('');
    try {
      const result = await window.electronAPI.invoke('archive:refreshAllLocal', { agentId: agent.id });
      setActionStatus(summarizeRefresh(`${agent.name} local accounts`, result));
      await loadOverview();
    } catch (refreshError) {
      setError(String((refreshError as Error)?.message || refreshError));
    } finally {
      setBusyAccountId(null);
    }
  };

  const renameAccount = async () => {
    if (!renamingAccount) return;
    try {
      const next = await window.electronAPI.invoke('archive:renameAccount', {
        accountId: renamingAccount.id,
        label: renameLabel,
      });
      setRenamingAccount(null);
      setRenameLabel('');
      setActionStatus(`Renamed account to ${next.label}.`);
      await loadOverview();
    } catch (renameError) {
      setError(String((renameError as Error)?.message || renameError));
    }
  };

  const openComparator = async () => {
    setBusyAccountId('comparator');
    try {
      const result = await window.electronAPI.invoke('archive:openComparator');
      setActionStatus(result?.alreadyRunning
        ? 'The backup comparator is already open.'
        : 'Opened the backup comparator.');
    } catch (comparatorError) {
      setError(String((comparatorError as Error)?.message || comparatorError));
    } finally {
      setBusyAccountId(null);
    }
  };

  const openSearchResult = (result: GlobalSearchResult) => {
    const account = accountsById.get(result.account_id);
    if (!account) return;
    onOpenAccount(account, {
      conversationId: result.conversation_id,
      messageId: result.id,
      query: query.trim(),
    });
  };

  return (
    <main className="archive-home">
      <header className="archive-home-header">
        <div>
          <div className="archive-kicker">AI archive</div>
          <h1>Conversations</h1>
        </div>
        <div className="archive-totals" aria-label="Archive totals">
          <span><strong>{formatCount(overview?.totals.accounts)}</strong> accounts</span>
          <span><strong>{formatCount(overview?.totals.conversations)}</strong> chats</span>
          <span><strong>{formatCount(overview?.totals.messages)}</strong> messages</span>
        </div>
      </header>

      <section className="global-search-region" aria-label="Global conversation search">
        <div className="global-search-field">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 20-5.6-5.6a7 7 0 1 0-1.4 1.4L19.6 21 21 20ZM5 10.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0Z" /></svg>
          <input
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            placeholder="Search every account"
            aria-label="Search every account"
          />
          {query ? <button onClick={() => handleQueryChange('')} title="Clear search" aria-label="Clear search">×</button> : null}
        </div>
        {query.trim() ? (
          <div className="global-search-summary">{searching ? 'Searching...' : `${formatCount(searchTotal)} matches`}</div>
        ) : null}
      </section>

      {error ? <div className="archive-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss">×</button></div> : null}
      {actionStatus ? <div className="archive-action-status" role="status">{actionStatus}</div> : null}

      {query.trim() ? (
        <section className="global-search-results" aria-label="Global search results">
          {searchResults.map((result) => (
            <button key={`${result.account_id}:${result.id}`} className="global-search-result" onClick={() => openSearchResult(result)}>
              <span className="global-result-source">
                <i style={{ background: result.agent_accent }} />
                {result.agent_name} / {result.account_label}
              </span>
              <strong>{result.conversation_title || 'Untitled chat'}</strong>
              <span className="global-result-preview">{resultPreview(result.content, query)}</span>
              <span className="global-result-role">{result.role}</span>
            </button>
          ))}
          {!searching && searchResults.length === 0 ? <div className="archive-empty">No matching messages.</div> : null}
        </section>
      ) : (
        <div className="agent-directory">
          {(overview?.agents || []).map((agent) => (
            <section key={agent.id} className="agent-section">
              <div className="agent-section-header">
                <div className="agent-heading">
                  <i style={{ background: agent.accent }} />
                  <div><h2>{agent.name}</h2><p>{agent.description}</p></div>
                </div>
                <div className="agent-header-actions">
                  {agent.accounts.some((account) => account.capabilities.localBackup) ? (
                    <button
                      className="archive-secondary-button"
                      disabled={busyAccountId === `agent:${agent.id}`}
                      onClick={() => void refreshAllLocal(agent)}
                    >
                      {busyAccountId === `agent:${agent.id}` ? 'Refreshing...' : 'Refresh all local'}
                    </button>
                  ) : null}
                  {agent.capabilities.importBackup ? (
                    <button className="archive-secondary-button" onClick={() => { setAddingAgent(agent); setNewAccountLabel(''); }}>
                      Add backup
                    </button>
                  ) : null}
                  {agent.id === 'google-ai-mode' ? (
                    <button
                      className="archive-secondary-button"
                      disabled={busyAccountId === 'comparator'}
                      onClick={() => void openComparator()}
                    >
                      {busyAccountId === 'comparator' ? 'Opening...' : 'Compare backups'}
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="account-grid">
                {agent.accounts.map((account) => (
                  <article key={account.id} className="account-card">
                    <button className="account-card-main" onClick={() => onOpenAccount(account)}>
                      <span className="account-card-title">{account.label}</span>
                      <span className="account-card-kind">{account.sourceKind}</span>
                      <span className="account-card-stats">
                        {formatCount(account.stats?.conversationCount)} chats · {formatCount(account.stats?.messageCount)} messages
                      </span>
                    </button>
                    <div className="account-card-actions">
                      {account.capabilities.localBackup ? (
                        <button disabled={busyAccountId === account.id || busyAccountId === `agent:${agent.id}`} onClick={() => void refreshLocal(account)}>
                          {busyAccountId === account.id ? 'Refreshing...' : 'Refresh local'}
                        </button>
                      ) : null}
                      {account.capabilities.importBackup ? (
                        <button disabled={busyAccountId === account.id} onClick={() => void importIntoAccount(account)}>
                          {busyAccountId === account.id ? 'Importing...' : 'Import backup'}
                        </button>
                      ) : null}
                      <button onClick={() => { setRenamingAccount(account); setRenameLabel(account.label); }}>
                        Rename
                      </button>
                    </div>
                  </article>
                ))}
                {agent.accounts.length === 0 ? <div className="archive-empty compact">No accounts yet.</div> : null}
              </div>
            </section>
          ))}
        </div>
      )}

      {addingAgent ? (
        <div className="modal-backdrop" onClick={() => setAddingAgent(null)}>
          <div className="archive-add-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header"><h2>Add {addingAgent.name} backup</h2><button className="close-modal" onClick={() => setAddingAgent(null)}>×</button></div>
            <label htmlFor="archive-account-label">Account label</label>
            <input
              id="archive-account-label"
              autoFocus
              value={newAccountLabel}
              onChange={(event) => setNewAccountLabel(event.target.value)}
              placeholder={`${addingAgent.name} backup`}
            />
            <div className="archive-modal-actions">
              <button className="archive-secondary-button" onClick={() => setAddingAgent(null)}>Cancel</button>
              <button className="archive-primary-button" disabled={busyAccountId === `new:${addingAgent.id}`} onClick={() => void createBackupAccount()}>
                Select backup
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {renamingAccount ? (
        <div className="modal-backdrop" onClick={() => setRenamingAccount(null)}>
          <div className="archive-add-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header"><h2>Rename account</h2><button className="close-modal" onClick={() => setRenamingAccount(null)}>×</button></div>
            <label htmlFor="archive-rename-label">Account label</label>
            <input
              id="archive-rename-label"
              autoFocus
              value={renameLabel}
              onChange={(event) => setRenameLabel(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void renameAccount(); }}
            />
            <div className="archive-modal-actions">
              <button className="archive-secondary-button" onClick={() => setRenamingAccount(null)}>Cancel</button>
              <button className="archive-primary-button" onClick={() => void renameAccount()}>Rename</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
