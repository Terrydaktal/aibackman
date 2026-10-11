const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { parsePiSession } = require('./pi-session-parser.cjs');
const { writeNormalizedConversation } = require('../archive/standard/index.cjs');

const PARSER_VERSION = 1;
const SKIP_DIRECTORIES = new Set(['node_modules', 'target', 'dist', 'build', 'vendor', '__pycache__', 'venv', 'Trash']);
const activeRefreshes = new Map();

function discoverAccounts({ homeDir = os.homedir() } = {}) {
  // No session reads or home-directory scan on startup. Discovery happens in
  // the refresh worker, including projects added after the app was started.
  return [{
    id: 'pi-local', label: 'Local Pi sessions', sourceKind: 'local',
    sourceConfig: { searchRoots: [homeDir] },
  }];
}

// Inspect names and file stats only; never open a transcript during discovery.
async function discoverSessionFiles(sourceConfig = {}, onProgress) {
  const searchRoots = sourceConfig.searchRoots ?? [os.homedir()];
  const sessionRoots = sourceConfig.sessionRoots ?? [];
  const stack = [
    ...searchRoots.map((root) => ({ directory: path.resolve(root), kind: path.basename(root) === '.pi' ? 'pi' : 'project' })),
    ...sessionRoots.map((root) => ({ directory: path.resolve(root), kind: 'sessions' })),
  ];
  const visited = new Set();
  const files = new Set();
  let unreadableDirectories = 0;
  while (stack.length) {
    const { directory, kind } = stack.pop();
    const visitKey = `${kind}:${directory}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    let entries;
    try {
      if (!(await fs.promises.lstat(directory)).isDirectory()) continue;
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') unreadableDirectories += 1;
      continue;
    }
    if (kind === 'pi') {
      stack.push({ directory: path.join(directory, 'sessions'), kind: 'sessions' });
      stack.push({ directory: path.join(directory, 'agent', 'sessions'), kind: 'sessions' });
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && kind !== 'project' && entry.name.endsWith('.jsonl')) files.add(candidate);
      if (!entry.isDirectory()) continue; // Includes symlinks: do not follow them.
      if (kind === 'pi') continue;
      if (entry.name === '.pi') stack.push({ directory: candidate, kind: 'pi' });
      else if (!entry.name.startsWith('.') && !SKIP_DIRECTORIES.has(entry.name)) stack.push({ directory: candidate, kind });
    }
    onProgress?.({ stage: 'discovery', scannedDirectories: visited.size, sourceItems: files.size });
  }
  return { files: [...files].sort(), unreadableDirectories };
}

function fingerprint(stat) {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

async function refreshLocalDirect({ db, sourceConfig = {}, inputPath, onProgress }) {
  let discovery;
  if (inputPath) {
    const input = path.resolve(inputPath);
    const stat = await fs.promises.lstat(input);
    if (stat.isFile() && input.endsWith('.jsonl')) discovery = { files: [input], unreadableDirectories: 0 };
    else if (stat.isDirectory()) {
      const config = path.basename(input) === 'sessions'
        ? { searchRoots: [], sessionRoots: [input] } : { searchRoots: [input] };
      discovery = await discoverSessionFiles(config, onProgress);
    } else throw new Error('Select a Pi JSONL session file, .pi directory, or project folder.');
  } else discovery = await discoverSessionFiles(sourceConfig, onProgress);

  const result = {
    importedConversations: 0, importedMessages: 0, skippedFiles: 0,
    parseErrors: 0, failedFiles: 0, unsupportedFiles: 0,
    sourceItems: discovery.files.length, unreadableDirectories: discovery.unreadableDirectories,
    ...(inputPath ? { sourcePath: path.resolve(inputPath) } : {}),
  };
  for (let index = 0; index < discovery.files.length; index += 1) {
    const filePath = discovery.files[index];
    try {
      const sourceKey = `pi:${filePath}`;
      const before = fingerprint(await fs.promises.lstat(filePath));
      const sourceItem = db.getSourceItem(sourceKey);
      if (sourceItem?.fingerprint === `${PARSER_VERSION}:${before}`) {
        result.skippedFiles += 1;
        continue;
      }
      let parsed;
      try {
        parsed = await parsePiSession(filePath);
      } catch {
        result.failedFiles += 1;
        continue;
      }
      result.parseErrors += parsed.parseErrors;
      if (parsed.unsupported) {
        result.unsupportedFiles += 1;
        continue;
      }
      // A running Pi can append mid-read. Retry changed or incomplete files next
      // refresh, without certifying or importing a partial snapshot.
      if (parsed.parseErrors || before !== fingerprint(await fs.promises.lstat(filePath))) {
        result.failedFiles += 1;
        continue;
      }
      const conversation = parsed.conversation;
      if (!conversation?.messages.length) continue;
      db.runArchiveOperation({
        type: 'merge-pi-session', actor: 'pi-local-backup-parser',
        reason: 'Merge a local Pi session and its source fingerprint.',
        entityType: 'conversation', entityId: conversation.id,
        details: { incomingMessages: conversation.messages.length },
      }, () => {
        const existing = db.getConversation(conversation.id);
        // Copied older backups may add branches but must not rewind the current
        // chat or change existing immutable Pi entries.
        const older = existing && Number(existing.updated_at) > conversation.updated_at;
        const snapshot = older ? {
          ...existing,
          messages: conversation.messages.filter((message) => !db.getMessage(message.id)),
        } : conversation;
        const imported = writeNormalizedConversation(db, snapshot);
        result.importedConversations += 1;
        result.importedMessages += imported.importedMessages;
        db.upsertSourceItem({
          sourceKey, sourcePath: filePath, fingerprint: `${PARSER_VERSION}:${before}`,
          metadata: { parserVersion: PARSER_VERSION, conversationId: conversation.id },
        });
      });
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) result.failedFiles += 1;
      else throw error;
    } finally {
      onProgress?.({ stage: 'import', current: index + 1, total: discovery.files.length, ...result });
    }
  }
  if (inputPath && !result.importedConversations && !result.skippedFiles) {
    throw new Error('No complete Pi sessions could be imported. Select a Pi .jsonl file, .pi folder, or project folder.');
  }
  return result;
}

function runRefresh({ db, sourceConfig = {}, inputPath, onProgress, snapshotOperationId }) {
  const previous = activeRefreshes.get(db.path) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'pi-refresh-worker.cjs'), {
      workerData: { dbPath: db.path, sourceConfig, inputPath, snapshotOperationId },
    });
    let response;
    worker.on('message', (message) => {
      if (message.type === 'progress') onProgress?.(message.progress);
      else if (message.type === 'result') response = message;
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (response?.error) reject(Object.assign(new Error(response.error), { preImportSnapshotPath: response.preImportSnapshotPath }));
      else if (code !== 0 || !response) reject(new Error(`Pi refresh worker exited without a result (code ${code}).`));
      else resolve(response.result);
    });
  })).finally(() => {
    if (activeRefreshes.get(db.path) === pending) activeRefreshes.delete(db.path);
  });
  activeRefreshes.set(db.path, pending);
  return pending;
}

module.exports = {
  id: 'pi', name: 'Pi CLI', accent: '#d97706',
  description: 'Local Pi sessions from project .pi folders and the home directory',
  capabilities: { localBackup: true, importBackup: true },
  discoverAccounts, discoverSessionFiles, refreshLocalDirect,
  refreshLocal: runRefresh, importBackup: runRefresh,
};
