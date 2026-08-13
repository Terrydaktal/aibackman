const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { asUnixSeconds, compactTitle, fileFingerprint, parseJsonFile, stableId } = require('./utils.cjs');

const DEFAULT_ROOT = path.join(os.homedir(), '.codex');
const CODEX_ROUTING_VERSION = 3;

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

function extractAccountId(event) {
  const payload = event?.payload || {};
  return event?.account_id
    || payload.account_id
    || payload.info?.account_id
    || payload.info?.total_token_usage?.account_id
    || null;
}

async function parseSession(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = path.basename(filePath, '.jsonl').replace(/^rollout-[^-]+-/, '');
  let cwd = '';
  let accountId = null;
  const accountIds = new Set();
  let sequence = 0;
  let parseErrors = 0;
  const visible = [];

  for await (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (event.type === 'session_meta') {
      sessionId = String(event.payload?.id || event.payload?.session_id || sessionId);
      cwd = String(event.payload?.cwd || '');
    }
    const eventAccountId = extractAccountId(event);
    if (eventAccountId) {
      accountId = String(eventAccountId);
      accountIds.add(accountId);
    }
    if (event.type !== 'event_msg') continue;
    const eventType = event.payload?.type;
    if (eventType !== 'user_message' && eventType !== 'agent_message') continue;
    const content = String(event.payload?.message || '').trim();
    if (!content) continue;
    visible.push({
      sequence,
      role: eventType === 'user_message' ? 'user' : 'assistant',
      content,
      phase: event.payload?.phase || null,
      createdAt: asUnixSeconds(event.timestamp, Date.now() / 1000 + sequence * 0.001),
    });
    sequence += 1;
  }

  return { sessionId, cwd, accountId, accountIds: [...accountIds], visible, parseErrors };
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
      metadata_json: JSON.stringify({ phase: message.phase, cwd: session.cwd, source: 'codex-local' }),
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
  db.importConversationSnapshot(snapshot.conversation, snapshot.messages, { replaceMessages: true });
  return snapshot.messages.length;
}

async function refreshLocal({ db, sourceConfig = {}, onProgress }) {
  const sessionsRoot = sourceConfig.sessionsRoot || path.join(DEFAULT_ROOT, 'sessions');
  const targetAccountId = sourceConfig.remoteAccountId || null;
  const files = listJsonlFiles(sessionsRoot);
  let importedConversations = 0;
  let importedMessages = 0;
  let skippedFiles = 0;
  let parseErrors = 0;

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

    const session = await parseSession(filePath);
    parseErrors += session.parseErrors;
    const sessionAccountIds = new Set(session.accountIds || []);
    const belongsToTarget = targetAccountId
      ? sessionAccountIds.has(targetAccountId)
      : sessionAccountIds.size === 0;
    if (belongsToTarget && session.visible.length > 0) {
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
        imported: belongsToTarget,
        routingVersion: CODEX_ROUTING_VERSION,
      },
    });
    onProgress?.({ current: index + 1, total: files.length, filePath });
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

async function refreshAllLocal({ accounts, getDatabase, onProgress }) {
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

      const session = await parseSession(filePath);
      const sessionAccountIds = new Set(session.accountIds || []);
      const targetAccounts = sessionAccountIds.size > 0
        ? [...sessionAccountIds].map((accountId) => accountByRemoteId.get(accountId)).filter(Boolean)
        : (fallbackAccount ? [fallbackAccount] : []);
      const targetIds = new Set(targetAccounts.map((account) => account.id));

      for (const account of groupAccounts) {
        const targetResult = results.get(account.id);
        const targetDb = getDatabase(account);
        const belongsToTarget = targetIds.has(account.id);
        if (belongsToTarget) targetResult.parseErrors += session.parseErrors;
        targetResult.sourceItems += 1;
        if (!sourceState.get(account.id).current && belongsToTarget && session.visible.length > 0) {
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
            imported: belongsToTarget && session.visible.length > 0,
            processed: true,
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

module.exports = {
  id: 'codex',
  name: 'Codex',
  description: 'Local Codex CLI sessions',
  accent: '#111827',
  capabilities: { localBackup: true },
  discoverAccounts,
  refreshLocal,
  refreshAllLocal,
};
