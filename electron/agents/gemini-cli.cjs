const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  asUnixSeconds,
  compactTitle,
  fileFingerprint,
  stableId,
} = require('./utils.cjs');
const {
  DEFAULT_GEMINI_ROOT,
  localGoogleAccountId,
  readGoogleAccounts,
} = require('./google-accounts.cjs');
const { writeNormalizedConversation } = require('../archive/standard/index.cjs');

const DEFAULT_SESSIONS_ROOT = path.join(DEFAULT_GEMINI_ROOT, 'tmp');
const LOCAL_ROUTING_VERSION = 2;

function discoverAccounts(options = {}) {
  const geminiRoot = options.geminiRoot || DEFAULT_GEMINI_ROOT;
  const sessionsRoot = options.sessionsRoot || path.join(geminiRoot, 'tmp');
  const { active, accounts } = readGoogleAccounts(geminiRoot);
  if (!fs.existsSync(sessionsRoot) && accounts.length === 0) return [];

  const discovered = accounts.length > 0 ? accounts : [''];
  return discovered.map((email) => ({
    id: localGoogleAccountId('gemini-cli', email),
    label: email || 'Local Gemini CLI',
    sourceKind: 'local',
    sourceConfig: {
      geminiRoot,
      sessionsRoot,
      accountEmail: email || null,
      active: email ? email === active : true,
    },
  }));
}

function listSessionFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (
        entry.isFile()
        && path.basename(directory) === 'chats'
        && /^session-.*\.(?:json|jsonl)$/i.test(entry.name)
      ) {
        files.push(entryPath);
      }
    }
  }
  return files.sort();
}

function readSessionHeader(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString('utf8');
    if (path.extname(filePath).toLowerCase() === '.jsonl') {
      return JSON.parse(prefix.split(/\r?\n/, 1)[0]);
    }
    const sessionId = prefix.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1];
    const startTime = prefix.match(/"startTime"\s*:\s*"([^"]+)"/)?.[1];
    return { sessionId, startTime };
  } catch {
    return {};
  } finally {
    fs.closeSync(descriptor);
  }
}

function sessionGroups(root) {
  const groups = new Map();
  for (const filePath of listSessionFiles(root)) {
    const header = readSessionHeader(filePath);
    const fallbackId = path.basename(filePath).replace(/\.(?:json|jsonl)$/i, '').replace(/^session-/, '');
    const sessionId = String(header.sessionId || fallbackId);
    if (!groups.has(sessionId)) groups.set(sessionId, []);
    groups.get(sessionId).push({
      filePath,
      startTime: asUnixSeconds(header.startTime, fs.statSync(filePath).mtimeMs / 1000),
    });
  }

  return [...groups].map(([sessionId, files]) => {
    files.sort((left, right) => left.startTime - right.startTime || left.filePath.localeCompare(right.filePath));
    const fingerprint = stableId('gemini-cli-source', files
      .map(({ filePath }) => `${filePath}:${fileFingerprint(filePath)}`)
      .join('|'));
    return { sessionId, files, fingerprint };
  }).sort((left, right) => left.files[0].startTime - right.files[0].startTime);
}

function contentText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n\n').trim();
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text.trim();
  if (Array.isArray(value.parts)) return contentText(value.parts);
  return '';
}

function visibleContent(event) {
  const preferred = event.type === 'user' ? contentText(event.displayContent) : '';
  const content = preferred || contentText(event.content);
  return content.replace(/^\s*<session_context>[\s\S]*?<\/session_context>\s*/i, '').trim();
}

function messageMetadata(event, projectName) {
  const thoughts = Array.isArray(event.thoughts)
    ? event.thoughts.map((thought) => ({
      subject: String(thought?.subject || '').trim(),
      description: String(thought?.description || '').trim(),
      timestamp: thought?.timestamp || null,
    })).filter((thought) => thought.subject || thought.description)
    : [];
  return JSON.stringify({
    source: 'gemini-cli-local',
    originalId: event.id,
    project: projectName,
    ...(event.model || event.model_slug || event.model_name ? { model: event.model || event.model_slug || event.model_name } : {}),
    ...(event.thinking_effort || event.reasoning_effort || event.effort || event.thinking_level
      ? { thinking_effort: event.thinking_effort || event.reasoning_effort || event.effort || event.thinking_level }
      : {}),
    ...(thoughts.length > 0 ? { thoughts } : {}),
  });
}

async function parseSessionGroup(group) {
  const events = new Map();
  let sequence = 0;
  let parseErrors = 0;
  let createdAt = Number.POSITIVE_INFINITY;
  let updatedAt = 0;
  let projectName = '';

  const recordEvent = (event) => {
    if (!event || (event.type !== 'user' && event.type !== 'gemini') || !event.id) return;
    const content = visibleContent(event);
    if (!content) return;
    const existing = events.get(String(event.id));
    const timestamp = asUnixSeconds(event.timestamp, group.files[0].startTime + sequence * 0.001);
    events.set(String(event.id), {
      event,
      content,
      role: event.type === 'user' ? 'user' : 'assistant',
      timestamp,
      order: existing?.order ?? sequence,
    });
    sequence += 1;
    createdAt = Math.min(createdAt, timestamp);
    updatedAt = Math.max(updatedAt, timestamp);
  };

  for (const { filePath, startTime } of group.files) {
    projectName ||= path.basename(path.dirname(path.dirname(filePath)));

    if (path.extname(filePath).toLowerCase() === '.json') {
      try {
        const document = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        if (document.startTime) createdAt = Math.min(createdAt, asUnixSeconds(document.startTime, startTime));
        if (document.lastUpdated) updatedAt = Math.max(updatedAt, asUnixSeconds(document.lastUpdated, startTime));
        for (const event of Array.isArray(document.messages) ? document.messages : []) recordEvent(event);
      } catch {
        parseErrors += 1;
      }
      continue;
    }

    createdAt = Math.min(createdAt, startTime);
    const lines = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        parseErrors += 1;
        continue;
      }
      if (entry.startTime) createdAt = Math.min(createdAt, asUnixSeconds(entry.startTime, startTime));
      if (entry.lastUpdated) updatedAt = Math.max(updatedAt, asUnixSeconds(entry.lastUpdated, startTime));
      if (entry.$set?.lastUpdated) {
        updatedAt = Math.max(updatedAt, asUnixSeconds(entry.$set.lastUpdated, startTime));
      }
      if (Array.isArray(entry.$set?.messages)) {
        for (const event of entry.$set.messages) recordEvent(event);
      } else {
        recordEvent(entry);
      }
    }
  }

  const ordered = [...events.values()].sort((left, right) => (
    left.timestamp - right.timestamp || left.order - right.order
  ));
  let parentId = null;
  const messages = ordered.map((entry) => {
    const id = stableId('geminimsg', `${group.sessionId}:${entry.event.id}:${entry.role}`);
    const message = {
      id,
      conversation_id: group.sessionId,
      role: entry.role,
      content: entry.content,
      metadata_json: messageMetadata(entry.event, projectName),
      created_at: entry.timestamp,
      parent_id: parentId,
    };
    parentId = id;
    return message;
  });
  const firstUser = messages.find((message) => message.role === 'user');
  const fallbackTime = group.files[0]?.startTime || Date.now() / 1000;
  return {
    conversation: {
      id: group.sessionId,
      title: compactTitle(firstUser?.content, projectName ? `Gemini CLI: ${projectName}` : 'Gemini CLI session'),
      created_at: Number.isFinite(createdAt) ? createdAt : fallbackTime,
      updated_at: updatedAt || messages.at(-1)?.created_at || fallbackTime,
      last_synced_updated_at: updatedAt || messages.at(-1)?.created_at || fallbackTime,
      current_node_id: messages.at(-1)?.id || null,
      is_deleted_on_web: 0,
    },
    messages,
    parseErrors,
  };
}

function sourceItemMetadata(sourceItem) {
  try {
    return sourceItem?.metadata_json ? JSON.parse(sourceItem.metadata_json) : {};
  } catch {
    return {};
  }
}

function emptyResult(account) {
  return {
    account,
    importedConversations: 0,
    importedMessages: 0,
    skippedFiles: 0,
    parseErrors: 0,
    sourceItems: 0,
  };
}

async function refreshAllLocal({ accounts, getDatabase, onProgress }) {
  const results = new Map(accounts.map((account) => [account.id, emptyResult(account)]));
  const accountsByRoot = new Map();
  for (const account of accounts) {
    const root = account.sourceConfig?.sessionsRoot || DEFAULT_SESSIONS_ROOT;
    if (!accountsByRoot.has(root)) accountsByRoot.set(root, []);
    accountsByRoot.get(root).push(account);
  }

  for (const [root, rootAccounts] of accountsByRoot) {
    const groups = sessionGroups(root);
    const activeAccount = rootAccounts.find((account) => account.sourceConfig?.active) || rootAccounts[0];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const sourceKey = `gemini-cli:${group.sessionId}`;
      const states = new Map(rootAccounts.map((account) => {
        const sourceItem = getDatabase(account).getSourceItem(sourceKey);
        return [account.id, { sourceItem, metadata: sourceItemMetadata(sourceItem) }];
      }));
      const existingOwner = rootAccounts.find((account) => states.get(account.id).metadata.owner === true);
      const owner = existingOwner || activeAccount;
      const ownerState = states.get(owner.id);
      const ownerCurrent = ownerState.sourceItem?.fingerprint === group.fingerprint
        && ownerState.metadata.routingVersion === LOCAL_ROUTING_VERSION;

      for (const account of rootAccounts) results.get(account.id).sourceItems += 1;
      let imported = ownerState.metadata.imported === true;
      if (ownerCurrent) {
        results.get(owner.id).skippedFiles += 1;
      } else {
        const parsed = await parseSessionGroup(group);
        results.get(owner.id).parseErrors += parsed.parseErrors;
        if (parsed.messages.length > 0) {
          writeNormalizedConversation(getDatabase(owner), {
            ...parsed.conversation,
            messages: parsed.messages,
          }, { replaceMessages: true });
          results.get(owner.id).importedConversations += 1;
          results.get(owner.id).importedMessages += parsed.messages.length;
          imported = true;
        }
      }

      for (const account of rootAccounts) {
        getDatabase(account).upsertSourceItem({
          sourceKey,
          sourcePath: group.files.at(-1)?.filePath || root,
          fingerprint: group.fingerprint,
          metadata: {
            owner: account.id === owner.id,
            imported: account.id === owner.id && imported,
            routingVersion: LOCAL_ROUTING_VERSION,
            fileCount: group.files.length,
          },
        });
      }
      onProgress?.({
        accountId: owner.id,
        current: index + 1,
        total: groups.length,
        sessionId: group.sessionId,
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

async function refreshLocal({ db, sourceConfig = {}, onProgress }) {
  const account = {
    id: localGoogleAccountId('gemini-cli', sourceConfig.accountEmail),
    sourceConfig,
  };
  const batch = await refreshAllLocal({
    accounts: [account],
    getDatabase: () => db,
    onProgress,
  });
  const result = { ...batch.results[0] };
  delete result.account;
  return result;
}

module.exports = {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  description: 'Local Gemini CLI sessions',
  accent: '#4f8ef7',
  capabilities: { localBackup: true, sharedLocalSource: true },
  discoverAccounts,
  refreshAllLocal,
  refreshLocal,
};
