const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AccountCatalog = require('./catalog.cjs');
const ChatDatabase = require('../database.cjs');
const { runArchiveWorker } = require('../providers/shared/archive-worker.cjs');
const { getAgentPlugin, listAgentPlugins } = require('../agents/registry.cjs');
const { stableId } = require('../agents/utils.cjs');
const {
  ArchiveRecoveryManager,
  DurableAuditJournal,
} = require('../archive/safety/journal.cjs');

class AccountManager {
  constructor({ userDataPath, legacyDatabases, legacyIdentities = {}, diagnostics = null }) {
    this.userDataPath = userDataPath;
    this.accountsPath = path.join(userDataPath, 'accounts');
    fs.mkdirSync(this.userDataPath, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.userDataPath, 0o700);
    fs.mkdirSync(this.accountsPath, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.accountsPath, 0o700);
    this.auditJournal = new DurableAuditJournal(userDataPath, {
      buildInfo: diagnostics?.getBuildInfo?.() || null,
      maxBytes: Number(process.env.AIBACKMAN_AUDIT_MAX_BYTES || 256 * 1024 * 1024),
    });
    this.recoveryManager = new ArchiveRecoveryManager(userDataPath, this.auditJournal);
    this.catalog = new AccountCatalog(path.join(userDataPath, 'archive-catalog.db'));
    this.databases = new Map();
    this.legacyDatabases = legacyDatabases;
    this.legacyIdentities = legacyIdentities;
    this.diagnostics = diagnostics;
    this.overviewRevision = 0;
    this.overviewPending = null;
    this.migrateLegacyDatabasePaths();
  }

  migrateLegacyDatabasePaths() {
    const currentRoot = path.resolve(this.userDataPath);
    const legacyRoot = path.resolve(path.join(path.dirname(this.userDataPath), 'chatgpt'));
    if (currentRoot === legacyRoot) return;

    const legacyPrefix = `${legacyRoot}${path.sep}`;
    for (const account of this.catalog.listAccounts()) {
      const accountPath = path.resolve(account.db_path);
      if (!accountPath.startsWith(legacyPrefix)) continue;

      const migratedPath = path.join(currentRoot, path.relative(legacyRoot, accountPath));
      if (!fs.existsSync(migratedPath)) continue;

      this.catalog.updateDatabasePath(account.id, migratedPath);
      console.info(`[storage] Migrated archive database path for ${account.id}: ${migratedPath}`);
    }
  }

  async initialize() {
    this.seedLegacyAccount({
      id: 'chatgpt-default',
      agentId: 'chatgpt',
      label: this.legacyIdentities.chatgpt?.email || this.legacyIdentities.chatgpt?.name || 'ChatGPT',
      legacyMode: 'chatgpt',
      db: this.legacyDatabases.chatgpt,
      identity: this.legacyIdentities.chatgpt,
    });
    this.seedLegacyAccount({
      id: 'google-ai-mode-default',
      agentId: 'google-ai-mode',
      label: this.legacyIdentities['google-ai-mode']?.email || this.legacyIdentities['google-ai-mode']?.name || 'Google AI Mode',
      legacyMode: 'aimode',
      db: this.legacyDatabases.aimode,
      identity: this.legacyIdentities['google-ai-mode'],
    });

    for (const plugin of listAgentPlugins()) {
      if (typeof plugin.discoverAccounts !== 'function') continue;
      const discovered = await plugin.discoverAccounts();
      for (const account of discovered) {
        const existing = this.catalog.getAccount(account.id);
        let existingConfig = {};
        try {
          existingConfig = existing?.source_config_json ? JSON.parse(existing.source_config_json) : {};
        } catch {}
        this.catalog.upsertAccount({
          id: account.id,
          agentId: plugin.id,
          label: existingConfig.customLabel ? existing.label : account.label,
          dbPath: existing?.db_path || this.databasePathFor(account.id),
          sourceKind: account.sourceKind || 'local',
          sourceConfig: {
            ...(account.sourceConfig || {}),
            ...(existingConfig.customLabel ? { customLabel: true } : {}),
          },
          legacyMode: null,
          isDefault: false,
        });
      }
    }
  }

  seedLegacyAccount({ id, agentId, label, legacyMode, db, identity }) {
    const existing = this.catalog.getAccount(id);
    let existingConfig = {};
    try {
      existingConfig = existing?.source_config_json ? JSON.parse(existing.source_config_json) : {};
    } catch {}
    const identityEmail = String(identity?.email || '').trim();
    const identityName = String(identity?.name || '').trim();
    this.catalog.upsertAccount({
      id,
      agentId,
      label: existingConfig.customLabel ? existing.label : (identityEmail || identityName || label),
      dbPath: db.dbPath,
      sourceKind: 'live',
      sourceConfig: {
        ...existingConfig,
        ...(identityEmail ? { identityEmail } : {}),
        ...(identityName ? { identityName } : {}),
      },
      legacyMode,
      isDefault: true,
    });
    this.databases.set(id, db);
  }

  databasePathFor(accountId) {
    return path.join(this.accountsPath, `${stableId('account', accountId)}.db`);
  }

  parseRow(row) {
    if (!row) return null;
    let sourceConfig = {};
    try {
      sourceConfig = row.source_config_json ? JSON.parse(row.source_config_json) : {};
    } catch {
      sourceConfig = {};
    }
    const plugin = getAgentPlugin(row.agent_id);
    if (!plugin) return null;
    const live = row.source_kind === 'live';
    const local = row.source_kind === 'local';
    const capabilities = {
      importBackup: !!plugin.capabilities?.importBackup,
      liveSync: live && !!plugin.capabilities?.liveSync,
      send: live && !!plugin.capabilities?.send,
      cacheAll: live && !!plugin.capabilities?.cacheAll,
      localBackup: local && !!plugin.capabilities?.localBackup,
      readOnly: !(live && plugin.capabilities?.send),
    };
    return {
      id: row.id,
      agentId: row.agent_id,
      agentName: plugin.name,
      agentAccent: plugin.accent,
      label: row.label,
      dbPath: row.db_path,
      sourceKind: row.source_kind,
      sourceConfig,
      legacyMode: row.legacy_mode,
      isDefault: !!row.is_default,
      lastBackupAt: row.last_backup_at || null,
      capabilities,
    };
  }

  getAccount(accountId) {
    return this.parseRow(this.catalog.getAccount(accountId));
  }

  renameAccount(accountId, label) {
    const account = this.getAccount(accountId);
    if (!account) throw new Error('Unknown archive account.');
    const nextLabel = String(label || '').trim();
    if (!nextLabel) throw new Error('Account label cannot be empty.');
    this.catalog.upsertAccount({
      ...account,
      label: nextLabel,
      sourceConfig: { ...account.sourceConfig, customLabel: true },
    });
    return this.getAccount(accountId);
  }

  updateAccountIdentity(accountId, identity) {
    const account = this.getAccount(accountId);
    if (!account || account.sourceConfig?.customLabel) return account;
    const email = String(identity?.email || '').trim();
    const name = String(identity?.name || '').trim();
    const label = email || name;
    if (!label) return account;
    this.catalog.upsertAccount({
      ...account,
      label,
      sourceConfig: {
        ...account.sourceConfig,
        ...(email ? { identityEmail: email } : {}),
        ...(name ? { identityName: name } : {}),
      },
    });
    return this.getAccount(accountId);
  }

  resolveAccount(payload) {
    const accountId = payload && typeof payload === 'object' ? payload.accountId : null;
    if (accountId) {
      const account = this.getAccount(accountId);
      if (account) return account;
    }
    const rawMode = payload && typeof payload === 'object' ? payload.mode : payload;
    const legacyMode = String(rawMode || '').toLowerCase() === 'aimode' ? 'aimode' : 'chatgpt';
    const row = this.catalog.listAccounts().find((candidate) => candidate.legacy_mode === legacyMode);
    return this.parseRow(row);
  }

  getDatabase(accountOrId) {
    const account = typeof accountOrId === 'string' ? this.getAccount(accountOrId) : accountOrId;
    if (!account) throw new Error('Unknown archive account.');
    if (!this.databases.has(account.id)) {
      this.databases.set(account.id, new ChatDatabase(account.dbPath, {
        diagnostics: this.diagnostics,
        accountId: account.id,
      }));
    }
    return this.databases.get(account.id);
  }

  listAccounts() {
    return this.catalog.listAccounts().map((row) => this.parseRow(row)).filter(Boolean);
  }

  async getArchiveOverviewAsync() {
    this.overviewRevision += 1;
    if (this.overviewPending) return this.overviewPending;
    const pending = (async () => {
      let revision, accounts;
      do {
        revision = this.overviewRevision;
        accounts = await runArchiveWorker({ operation: 'overview', accounts: this.listAccounts() }, null, this.diagnostics);
      } while (revision !== this.overviewRevision);
      return this.getArchiveOverview(accounts);
    })();
    this.overviewPending = pending;
    try { return await pending; } finally { if (this.overviewPending === pending) this.overviewPending = null; }
  }

  getArchiveOverview(precomputedAccounts = null) {
    const accounts = precomputedAccounts || this.listAccounts().map((account) => {
      const database = this.getDatabase(account);
      return {
        ...account,
        stats: {
          ...database.getStats(),
          lastBackupAt: account.lastBackupAt || database.getLatestBackupAt(),
        },
      };
    });
    const agents = listAgentPlugins().map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      accent: plugin.accent,
      capabilities: plugin.capabilities || {},
      accounts: accounts.filter((account) => account.agentId === plugin.id),
    }));
    return {
      agents,
      totals: accounts.reduce((totals, account) => ({
        accounts: totals.accounts + 1,
        conversations: totals.conversations + account.stats.conversationCount,
        messages: totals.messages + account.stats.messageCount,
      }), { accounts: 0, conversations: 0, messages: 0 }),
    };
  }

  createAccount({ agentId, label, sourceKind = 'backup', sourceConfig = {} }) {
    const plugin = getAgentPlugin(agentId);
    if (!plugin) throw new Error(`Unknown agent: ${agentId}`);
    const normalizedLabel = String(label || '').trim() || `${plugin.name} backup`;
    const id = `${agentId}-${crypto.randomUUID()}`;
    this.catalog.upsertAccount({
      id,
      agentId,
      label: normalizedLabel,
      dbPath: this.databasePathFor(id),
      sourceKind,
      sourceConfig,
      legacyMode: null,
      isDefault: false,
    });
    return this.getAccount(id);
  }

  deleteAccount(accountId) {
    const account = this.getAccount(accountId);
    if (!account) throw new Error('Unknown archive account.');
    if (account.isDefault) throw new Error('Default archive accounts cannot be deleted.');

    const operationId = crypto.randomUUID();
    const database = this.getDatabase(account);
    const snapshot = database.createRecoverySnapshot('before-account-deletion', {
      force: true,
      operationId,
    });
    database.close();
    this.databases.delete(account.id);

    const quarantine = this.recoveryManager.quarantineDatabaseFiles({
      dbPath: account.dbPath,
      account,
      reason: 'Archive account removed by the user; database retained for recovery.',
      operationId,
    });
    try {
      this.catalog.deleteAccount(account.id);
    } catch (error) {
      for (const { source, destination } of quarantine.moved.slice().reverse()) {
        if (fs.existsSync(destination) && !fs.existsSync(source)) fs.renameSync(destination, source);
      }
      throw error;
    }
    this.auditJournal.append({
      action: 'account-removed-from-catalog',
      operation_id: operationId,
      account_id: account.id,
      agent_id: account.agentId,
      database_path: account.dbPath,
      recovery_path: quarantine.directory,
    });
    return {
      success: true,
      accountId: account.id,
      recoveryPath: quarantine.directory,
      snapshotPath: snapshot?.snapshot_database || null,
    };
  }

  async importBackup(accountId, inputPath) {
    const account = this.getAccount(accountId);
    if (!account) throw new Error('Unknown archive account.');
    const plugin = getAgentPlugin(account.agentId);
    const backupParser = plugin?.backupParser || plugin;
    if (typeof backupParser?.importBackup !== 'function') {
      throw new Error(`${plugin?.name || account.agentId} does not support official backup imports.`);
    }
    const db = this.getDatabase(account);
    const operationId = crypto.randomUUID();
    db.searchWorker.stop();
    this.auditJournal.append({
      action: 'backup-import-started',
      operation_id: operationId,
      account_id: account.id,
      agent_id: account.agentId,
      database_path: account.dbPath,
      source_path: inputPath,
    });
    let snapshot = null;
    try {
      const result = await backupParser.importBackup({
        db,
        inputPath,
        // Imports are always additive. A backup can be partial, older, or from a
        // nested Takeout folder, so absence is never evidence for deletion.
        replaceExisting: false,
        sourceConfig: account.sourceConfig,
        snapshotOperationId: operationId,
      });
      snapshot = result.preImportSnapshotPath ? { snapshot_database: result.preImportSnapshotPath } : null;
      this.catalog.upsertAccount({
        ...account,
        sourceConfig: { ...account.sourceConfig, lastImportPath: result.sourcePath || inputPath },
      });
      this.catalog.recordBackup(account.id);
      const stats = db.getStats();
      try {
        this.auditJournal.append({
          action: 'backup-import-completed',
          operation_id: operationId,
          account_id: account.id,
          agent_id: account.agentId,
          database_path: account.dbPath,
          source_path: inputPath,
          recovery_path: snapshot?.snapshot_database || null,
          result: {
            imported_conversations: Number(result.importedConversations || 0),
            imported_messages: Number(result.importedMessages || 0),
            conversation_count: stats.conversationCount,
            message_count: stats.messageCount,
          },
        });
      } catch (journalError) {
        console.error('The external audit journal could not record backup-import completion:', journalError);
      }
      return {
        success: true,
        account: this.getAccount(account.id),
        ...result,
        stats,
        preImportSnapshotPath: snapshot?.snapshot_database || null,
      };
    } catch (error) {
      if (error.preImportSnapshotPath) snapshot = { snapshot_database: error.preImportSnapshotPath };
      try {
        this.auditJournal.append({
          action: 'backup-import-failed',
          operation_id: operationId,
          account_id: account.id,
          agent_id: account.agentId,
          database_path: account.dbPath,
          source_path: inputPath,
          recovery_path: snapshot?.snapshot_database || null,
          error: String(error?.stack || error),
        });
      } catch (journalError) {
        console.error('The external audit journal could not record backup-import failure:', journalError);
      }
      throw error;
    }
  }

  async refreshLocal(accountId, onProgress) {
    const account = this.getAccount(accountId);
    if (!account) throw new Error('Unknown archive account.');
    const plugin = getAgentPlugin(account.agentId);
    const backupParser = plugin?.backupParser || plugin;
    if (typeof backupParser?.refreshLocal !== 'function') {
      throw new Error(`${plugin?.name || account.agentId} is not a local session source.`);
    }
    if (plugin.capabilities?.sharedLocalSource && typeof backupParser.refreshAllLocal === 'function') {
      const accounts = this.listAccounts().filter((candidate) => (
        candidate.agentId === account.agentId && candidate.capabilities.localBackup
      ));
      const batch = await backupParser.refreshAllLocal({
        accounts,
        diagnostics: this.diagnostics,
        getDatabase: (candidate) => this.getDatabase(candidate),
        onProgress,
      });
      const result = (batch.results || []).find((entry) => entry.account?.id === account.id);
      if (!result) throw new Error(`No refresh result was returned for ${account.label}.`);
      for (const entry of batch.results || []) {
        if (entry?.success !== false && entry?.account?.id) this.catalog.recordBackup(entry.account.id);
      }
      return { ...result, account: this.getAccount(account.id) };
    }
    const db = this.getDatabase(account);
    const result = await backupParser.refreshLocal({
      db,
      sourceConfig: account.sourceConfig,
      onProgress,
    });
    this.catalog.recordBackup(account.id);
    return { success: true, account: this.getAccount(account.id), ...result, stats: db.getStats() };
  }

  async refreshAllLocal(agentId = null, onProgress) {
    const accounts = this.listAccounts().filter((account) => (
      account.capabilities.localBackup && (!agentId || account.agentId === agentId)
    ));
    const results = [];
    const accountsByAgent = new Map();
    for (const account of accounts) {
      if (!accountsByAgent.has(account.agentId)) accountsByAgent.set(account.agentId, []);
      accountsByAgent.get(account.agentId).push(account);
    }

    for (const [targetAgentId, agentAccounts] of accountsByAgent) {
      const plugin = getAgentPlugin(targetAgentId);
      const backupParser = plugin?.backupParser || plugin;
      if (typeof backupParser?.refreshAllLocal === 'function') {
        const batch = await backupParser.refreshAllLocal({
          accounts: agentAccounts,
          diagnostics: this.diagnostics,
          getDatabase: (account) => this.getDatabase(account),
          onProgress,
        });
        for (const entry of batch.results || []) {
          if (entry?.success !== false && entry?.account?.id) this.catalog.recordBackup(entry.account.id);
        }
        results.push(...(batch.results || []));
        continue;
      }
      for (let index = 0; index < agentAccounts.length; index += 1) {
        const account = agentAccounts[index];
        onProgress?.({
          accountId: account.id,
          accountIndex: index + 1,
          accountTotal: agentAccounts.length,
          stage: 'account-start',
        });
        const result = await this.refreshLocal(account.id, (progress) => {
          onProgress?.({
            accountId: account.id,
            accountIndex: index + 1,
            accountTotal: agentAccounts.length,
            ...progress,
          });
        });
        results.push(result);
      }
    }
    return { success: true, accountCount: accounts.length, results };
  }

  async globalSearch(query, limit = 200, sort = 'relevance', role = 'all') {
    const trimmed = String(query || '').trim();
    if (!trimmed) return { total: 0, total_is_lower_bound: false, results: [] };
    const resultLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
    const normalizedSort = ['relevance', 'date_asc', 'date_desc'].includes(sort)
      ? sort
      : 'relevance';
    const normalizedRole = ['all', 'user', 'assistant'].includes(role) ? role : 'all';
    const accounts = this.listAccounts();
    const searches = await Promise.all(accounts.map(async (account) => {
      const output = await this.getDatabase(account).searchMessages(
        trimmed,
        normalizedSort,
        resultLimit,
        normalizedRole
      );
      return { account, output };
    }));
    const total = searches.reduce((sum, entry) => sum + Number(entry.output.total || 0), 0);
    const results = [];
    const decorate = (result, account) => ({
      ...result,
      account_id: account.id,
      account_label: account.label,
      agent_id: account.agentId,
      agent_name: account.agentName,
      agent_accent: account.agentAccent,
    });
    if (normalizedSort === 'relevance') {
      let index = 0;
      while (results.length < resultLimit) {
        let added = false;
        for (const { account, output } of searches) {
          const result = output.results?.[index];
          if (!result) continue;
          results.push(decorate(result, account));
          added = true;
          if (results.length >= resultLimit) break;
        }
        if (!added) break;
        index += 1;
      }
    } else {
      const timestamp = (value) => {
        if (value == null || value === '') return null;
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed / 1000;
      };
      results.push(...searches.flatMap(({ account, output }) => (
        (output.results || []).map((result) => decorate(result, account))
      )));
      results.sort((left, right) => {
        const leftTime = timestamp(left.created_at);
        const rightTime = timestamp(right.created_at);
        if (leftTime == null && rightTime == null) {
          return `${left.account_id}:${left.id}`.localeCompare(`${right.account_id}:${right.id}`);
        }
        if (leftTime == null) return 1;
        if (rightTime == null) return -1;
        if (leftTime !== rightTime) {
          return normalizedSort === 'date_asc' ? leftTime - rightTime : rightTime - leftTime;
        }
        return `${left.account_id}:${left.id}`.localeCompare(`${right.account_id}:${right.id}`);
      });
      results.splice(resultLimit);
    }
    return {
      total,
      total_is_lower_bound: searches.some((entry) => !!entry.output.total_is_lower_bound),
      results,
    };
  }

  close() {
    for (const database of new Set(this.databases.values())) database.close();
    this.databases.clear();
    this.catalog.close();
  }
}

module.exports = AccountManager;
