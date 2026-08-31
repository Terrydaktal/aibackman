const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { compactTitle, fileFingerprint, parseJsonFile, stableId } = require('./utils.cjs');
const { writeNormalizedConversation } = require('../archive/standard/index.cjs');

const DEFAULT_ROOT = path.join(os.homedir(), '.codex');
const CODEX_ROUTING_VERSION = 5;
const SESSION_WORKER_PATH = path.join(__dirname, 'codex-session-worker.cjs');
const REFRESH_WORKER_PATH = path.join(__dirname, 'codex-refresh-worker.cjs');

class CodexSessionParserClient {
  constructor() {
    this.nextRequestId = 1;
    this.pending = new Map();
    this.closed = false;
    this.failure = null;
    this.worker = new Worker(SESSION_WORKER_PATH);
    this.worker.on('message', ({ requestId, session, error }) => {
      const request = this.pending.get(requestId);
      if (!request) return;
      this.pending.delete(requestId);
      if (error) request.reject(new Error(error));
      else request.resolve(session);
    });
    this.worker.once('error', (error) => this.fail(error));
    this.worker.once('exit', (code) => {
      if (!this.closed && code !== 0) this.fail(new Error(`Codex parser worker exited with code ${code}.`));
    });
  }

  fail(error) {
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  parse(filePath) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('Codex parser worker is closed.'));
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ requestId, filePath });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.worker.terminate();
  }
}

function createLazySessionParser() {
  let client = null;
  return {
    parse(filePath) {
      if (!client) client = new CodexSessionParserClient();
      return client.parse(filePath);
    },
    async close() {
      if (client) await client.close();
    },
  };
}

function runRefreshWorker(workerData, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(REFRESH_WORKER_PATH, { workerData });
    let settled = false;
    worker.on('message', (message) => {
      if (message?.type === 'progress') {
        onProgress?.(message.progress);
        return;
      }
      if (message?.type !== 'result' || settled) return;
      settled = true;
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    });
    worker.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) reject(new Error('Codex refresh worker exited without returning a result.'));
      else reject(new Error(`Codex refresh worker exited with code ${code}.`));
    });
  });
}

function listJsonlFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entryPath);
    }
  }
  return files.sort();
}

function discoverAccounts() {
  const registryPath = path.join(DEFAULT_ROOT, 'accounts', 'registry.json');
  const sessionsRoot = path.join(DEFAULT_ROOT, 'sessions');
  const discovered = [];
  if (fs.existsSync(registryPath)) {
    const registry = parseJsonFile(registryPath);
    for (const account of Array.isArray(registry?.accounts) ? registry.accounts : []) {
      const remoteAccountId = String(account.chatgpt_account_id || '').trim();
      if (!remoteAccountId) continue;
      discovered.push({
        id: `codex-${remoteAccountId}`,
        label: account.email || remoteAccountId,
        sourceKind: 'local',
        sourceConfig: { codexRoot: DEFAULT_ROOT, sessionsRoot, remoteAccountId },
      });
    }
  }
  discovered.push({
    id: 'codex-unattributed',
    label: 'Local sessions (unattributed)',
    sourceKind: 'local',
    sourceConfig: { codexRoot: DEFAULT_ROOT, sessionsRoot, remoteAccountId: null },
  });
  return discovered;
}

function buildSessionSnapshot(session) {
  let parentId = null;
  const messages = session.visible.map((message) => {
    const id = stableId('codexmsg', `${session.sessionId}:${message.sequence}:${message.role}`);
    const record = {
      id,
      conversation_id: session.sessionId,
      role: message.role,
      content: message.content,
      metadata_json: JSON.stringify({
        phase: message.phase,
        cwd: session.cwd,
        source: 'codex-local',
        ...(message.model ? { model: message.model } : {}),
        ...(message.effort ? { thinking_effort: message.effort } : {}),
      }),
      created_at: message.createdAt,
      parent_id: parentId,
    };
    parentId = id;
    return record;
  });
  if (messages.length === 0) return null;
  const firstUser = messages.find((message) => message.role === 'user');
  const updatedAt = messages.at(-1).created_at;
  return {
    conversation: {
      id: session.sessionId,
      title: compactTitle(firstUser?.content, path.basename(session.cwd) || 'Codex session'),
      created_at: messages[0].created_at,
      updated_at: updatedAt,
      last_synced_updated_at: updatedAt,
      current_node_id: parentId,
      is_deleted_on_web: 0,
    },
    messages,
  };
}

function importSession(db, session) {
  const snapshot = buildSessionSnapshot(session);
  if (!snapshot) return 0;
  return writeNormalizedConversation(db, {
    ...snapshot.conversation,
    messages: snapshot.messages,
  }, { replaceMessages: true }).importedMessages;
}

async function refreshLocalDirect({ db, sourceConfig = {}, onProgress }) {
  const sessionsRoot = sourceConfig.sessionsRoot || path.join(DEFAULT_ROOT, 'sessions');
  const targetAccountId = sourceConfig.remoteAccountId || null;
  const files = listJsonlFiles(sessionsRoot);
  let importedConversations = 0;
  let importedMessages = 0;
  let skippedFiles = 0;
  let parseErrors = 0;
  const sessionParser = createLazySessionParser();

  try {
    for (let index = 0; index < files.length; index += 1) {
      const filePath = files[index];
      const fingerprint = fileFingerprint(filePath);
      const sourceKey = `codex:${filePath}`;
      const sourceItem = db.getSourceItem(sourceKey);
      const metadata = sourceItemMetadata(sourceItem);
      if (sourceItem?.fingerprint === fingerprint && metadata.routingVersion === CODEX_ROUTING_VERSION) {
        skippedFiles += 1;
        continue;
      }

      const session = await sessionParser.parse(filePath);
      parseErrors += session.parseErrors;
      const sessionAccountIds = new Set(session.accountIds || []);
      const belongsToTarget = targetAccountId
        ? sessionAccountIds.has(targetAccountId)
        : sessionAccountIds.size === 0;
      const shouldImport = belongsToTarget && !session.isSubagent && session.visible.length > 0;
      if (shouldImport) {
        const messageCount = importSession(db, session);
        importedConversations += 1;
        importedMessages += messageCount;
      }
      db.upsertSourceItem({
        sourceKey,
        sourcePath: filePath,
        fingerprint,
        metadata: {
          accountId: session.accountId,
          accountIds: session.accountIds,
          imported: shouldImport,
          isSubagent: session.isSubagent,
          parentSessionId: session.parentSessionId,
          sessionId: session.sessionId,
          routingVersion: CODEX_ROUTING_VERSION,
        },
      });
      onProgress?.({ current: index + 1, total: files.length, filePath });
    }
  } finally {
    await sessionParser.close();
  }

  return { importedConversations, importedMessages, skippedFiles, parseErrors, sourceItems: files.length };
}

function sourceItemMetadata(sourceItem) {
  try {
    return sourceItem?.metadata_json ? JSON.parse(sourceItem.metadata_json) : {};
  } catch {
    return {};
  }
}

async function refreshAllLocalDirect({ accounts, getDatabase, onProgress }) {
  const results = new Map(accounts.map((account) => [account.id, {
    account,
    importedConversations: 0,
    importedMessages: 0,
    skippedFiles: 0,
    parseErrors: 0,
    sourceItems: 0,
  }]));
  const groups = new Map();
  for (const account of accounts) {
    const sessionsRoot = account.sourceConfig?.sessionsRoot || path.join(DEFAULT_ROOT, 'sessions');
    if (!groups.has(sessionsRoot)) groups.set(sessionsRoot, []);
    groups.get(sessionsRoot).push(account);
  }
  const sessionParser = createLazySessionParser();

  try {
    for (const [sessionsRoot, groupAccounts] of groups) {
      const files = listJsonlFiles(sessionsRoot);
      const accountByRemoteId = new Map(groupAccounts
        .filter((account) => account.sourceConfig?.remoteAccountId)
        .map((account) => [String(account.sourceConfig.remoteAccountId), account]));
      const fallbackAccount = groupAccounts.find((account) => !account.sourceConfig?.remoteAccountId) || null;

      for (let index = 0; index < files.length; index += 1) {
        const filePath = files[index];
        const fingerprint = fileFingerprint(filePath);
        const sourceKey = `codex:${filePath}`;
        const sourceState = new Map(groupAccounts.map((account) => {
          const sourceItem = getDatabase(account).getSourceItem(sourceKey);
          const metadata = sourceItemMetadata(sourceItem);
          return [account.id, {
            current: sourceItem?.fingerprint === fingerprint
              && metadata.routingVersion === CODEX_ROUTING_VERSION,
            metadata,
          }];
        }));
        if ([...sourceState.values()].every((state) => state.current)) {
          for (const account of groupAccounts) {
            if (sourceState.get(account.id).metadata.imported === true) {
              results.get(account.id).skippedFiles += 1;
            }
          }
          continue;
        }

        const session = await sessionParser.parse(filePath);
        const sessionAccountIds = new Set(session.accountIds || []);
        const targetAccounts = sessionAccountIds.size > 0
          ? [...sessionAccountIds].map((accountId) => accountByRemoteId.get(accountId)).filter(Boolean)
          : (fallbackAccount ? [fallbackAccount] : []);
        const targetIds = new Set(targetAccounts.map((account) => account.id));

        for (const account of groupAccounts) {
          const targetResult = results.get(account.id);
          const targetDb = getDatabase(account);
          const belongsToTarget = targetIds.has(account.id);
          const shouldImport = belongsToTarget && !session.isSubagent && session.visible.length > 0;
          if (belongsToTarget) targetResult.parseErrors += session.parseErrors;
          targetResult.sourceItems += 1;
          if (!sourceState.get(account.id).current && shouldImport) {
            targetResult.importedMessages += importSession(targetDb, session);
            targetResult.importedConversations += 1;
          } else if (sourceState.get(account.id).current && belongsToTarget) {
            targetResult.skippedFiles += 1;
          }
          targetDb.upsertSourceItem({
            sourceKey,
            sourcePath: filePath,
            fingerprint,
            metadata: {
              accountId: session.accountId,
              accountIds: session.accountIds,
              imported: shouldImport,
              processed: true,
              isSubagent: session.isSubagent,
              parentSessionId: session.parentSessionId,
              sessionId: session.sessionId,
              routingVersion: CODEX_ROUTING_VERSION,
            },
          });
        }
        onProgress?.({
          accountId: targetAccounts[0]?.id || fallbackAccount?.id || groupAccounts[0]?.id,
          current: index + 1,
          total: files.length,
          filePath,
        });
      }
    }
  } finally {
    await sessionParser.close();
  }

  return {
    accountCount: accounts.length,
    results: [...results.values()].map(({ account, ...result }) => ({
      success: true,
      account,
      ...result,
      stats: getDatabase(account).getStats(),
    })),
  };
}

async function refreshLocal({ db, sourceConfig = {}, onProgress }) {
  return runRefreshWorker({
    mode: 'single',
    dbPath: db.path,
    sourceConfig,
  }, onProgress);
}

async function refreshAllLocal({ accounts, getDatabase, onProgress }) {
  return runRefreshWorker({
    mode: 'all',
    accounts: accounts.map((account) => ({
      account,
      dbPath: getDatabase(account).path,
    })),
  }, onProgress);
}

module.exports = {
  id: 'codex',
  name: 'Codex CLI',
  description: 'Local Codex CLI sessions',
  accent: '#111827',
  capabilities: { localBackup: true },
  discoverAccounts,
  refreshLocal,
  refreshAllLocal,
  refreshLocalDirect,
  refreshAllLocalDirect,
};
