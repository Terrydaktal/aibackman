const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  asUnixSeconds,
  compactTitle,
  findNamedFiles,
  materializeBackupPath,
  stableId,
} = require('./utils.cjs');
const { readFirefoxIndexedDbRecords } = require('./firefox-indexeddb.cjs');
const { writeNormalizedArchive } = require('../archive/standard/index.cjs');

function findChromiumIndexedDbRoot(rootPath) {
  const candidates = findNamedFiles(rootPath, ['CURRENT'], 8)
    .filter((candidate) => path.basename(path.dirname(candidate)).endsWith('.leveldb'));
  if (candidates.length === 0) {
    throw new Error('ChatHub backup must contain a Chromium IndexedDB directory.');
  }
  const levelDbRoot = path.dirname(candidates[0]);
  const indexedDbRoot = path.dirname(levelDbRoot);
  if (path.basename(indexedDbRoot).toLowerCase() !== 'indexeddb') {
    throw new Error('ChatHub Chromium IndexedDB directory has an unexpected layout.');
  }
  return indexedDbRoot;
}

function readChromiumIndexedDbRecords(indexedDbRoot) {
  const { BrowserWindow, session } = require('electron');
  if (typeof BrowserWindow !== 'function' || !session?.fromPath) {
    throw new Error('ChatHub imports require the Electron runtime.');
  }

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chathub-reader-'));
  fs.cpSync(indexedDbRoot, path.join(storageRoot, 'IndexedDB'), { recursive: true });
  const chathubSession = session.fromPath(storageRoot);
  let window = null;

  const withTimeout = (promise, label, timeoutMs = 45_000) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`ChatHub ${label} timed out.`)), timeoutMs)),
  ]);

  const readScript = `
    (async () => {
      const requestValue = (request) => new Promise((resolve, reject) => {
        request.onerror = () => reject(new Error(request.error?.message || 'IndexedDB request failed'));
        request.onsuccess = () => resolve(request.result);
      });
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('keyval-store');
        request.onerror = () => reject(new Error(request.error?.message || 'Could not open ChatHub IndexedDB'));
        request.onsuccess = () => resolve(request.result);
      });
      if (!database.objectStoreNames.contains('keyval')) {
        throw new Error('ChatHub IndexedDB does not contain its keyval object store.');
      }
      const transaction = database.transaction('keyval', 'readonly');
      const store = transaction.objectStore('keyval');
      const keys = await requestValue(store.getAllKeys());
      const values = await requestValue(store.getAll());
      database.close();
      return keys.map((key, index) => ({ key, value: values[index] }));
    })()
  `;

  return (async () => {
    try {
      window = new BrowserWindow({
        show: false,
        webPreferences: {
          session: chathubSession,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await withTimeout(window.loadURL('https://app.chathub.gg/'), 'page load');
      return await withTimeout(window.webContents.executeJavaScript(readScript, true), 'IndexedDB read');
    } finally {
      if (window && !window.isDestroyed()) window.destroy();
      try { await chathubSession.flushStorageData(); } catch {}
      try { await chathubSession.clearStorageData(); } catch {}
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  })();
}

async function readBackupRecords(rootPath) {
  try {
    return {
      kind: 'chromium',
      records: await readChromiumIndexedDbRecords(findChromiumIndexedDbRoot(rootPath)),
    };
  } catch (chromiumError) {
    try {
      return {
        kind: 'firefox',
        records: readFirefoxIndexedDbRecords(rootPath),
      };
    } catch (firefoxError) {
      throw new Error(`ChatHub backup could not be read as Chromium or Firefox IndexedDB: ${firefoxError.message || chromiumError.message}`);
    }
  }
}

function recordKeyParts(key) {
  const value = String(key || '');
  const conversation = value.match(/^conversation:(.+):([^:]+):messages$/);
  if (conversation) return { kind: 'messages', model: conversation[1], conversationId: conversation[2] };
  const summaries = value.match(/^conversations:(.+)$/);
  if (summaries) return { kind: 'summaries', model: summaries[1] };
  return null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringifyValue(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function addText(output, value) {
  const text = String(value || '').trim();
  if (text && !output.includes(text)) output.push(text);
}

function partToText(part) {
  if (!part || typeof part !== 'object') return '';
  const type = String(part.type || '').toLowerCase();
  if (type === 'text') return String(part.text || '');
  if (type === 'reasoning' || type === 'thinking') {
    const text = String(part.text || part.reasoning || part.content || '').trim();
    return text ? `Reasoning:\n${text}` : '';
  }
  if (type === 'tool-invocation' || type === 'tool_invocation' || type === 'tool-call') {
    return `Tool invocation:\n${stringifyValue(part)}`;
  }
  return String(part.text || part.content || '').trim();
}

function messageToContent(message) {
  const output = [];
  addText(output, message?.text);
  for (const part of asArray(message?.parts)) addText(output, partToText(part));
  if (message?.error) addText(output, `Error:\n${stringifyValue(message.error)}`);
  for (const file of asArray(message?.files)) {
    if (!file || typeof file !== 'object') continue;
    const name = path.basename(String(file.filename || file.name || 'attachment'));
    const size = Number(file.size);
    addText(output, `Attachment: ${name}${Number.isFinite(size) ? ` (${size} bytes)` : ''}`);
  }
  return output.join('\n\n').trim();
}

function messageRole(message) {
  const author = String(message?.author || message?.role || '').toLowerCase();
  return author === 'user' || author === 'human' ? 'user' : 'assistant';
}

function modelLabel(model) {
  return String(model || 'ChatHub').replace(/^cloud-/, '').replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizeRecords(records, sourceKind = 'chromium') {
  const summaries = new Map();
  const messageGroups = new Map();
  for (const record of asArray(records)) {
    const parts = recordKeyParts(record?.key);
    if (!parts) continue;
    if (parts.kind === 'summaries') {
      for (const summary of asArray(record.value)) {
        const id = String(summary?.id || '').trim();
        if (id) summaries.set(`${parts.model}|${id}`, { ...summary, id, model: parts.model, sourceKind });
      }
    } else {
      const id = `${parts.model}|${parts.conversationId}`;
      messageGroups.set(id, asArray(record.value));
    }
  }

  const conversations = new Map(summaries);
  for (const [key, messages] of messageGroups) {
    if (!conversations.has(key)) {
      const [model, id] = key.split('|');
      conversations.set(key, { id, model, createdAt: null, updatedAt: null, userId: null, sourceKind });
    }
    const conversation = conversations.get(key);
    conversation.messages = messages;
  }

  return [...conversations.values()]
    .map((conversation) => ({
      ...conversation,
      messages: asArray(conversation.messages),
    }))
    .sort((left, right) => asUnixSeconds(right.updatedAt, 0) - asUnixSeconds(left.updatedAt, 0));
}

async function importBackup({ db, inputPath, replaceExisting = false }) {
  const materialized = materializeBackupPath(inputPath);
  try {
    const backup = await readBackupRecords(materialized.path);
    const conversations = normalizeRecords(backup.records, backup.kind);
    if (conversations.length === 0) throw new Error('No ChatHub conversations were found in the IndexedDB backup.');

    const normalizedConversations = [];
    for (const conversation of conversations) {
        const rawMessages = conversation.messages
          .map((message, index) => ({ message, index, content: messageToContent(message) }))
          .filter((entry) => entry.content)
          .sort((left, right) => asUnixSeconds(left.message?.createdAt, left.index) - asUnixSeconds(right.message?.createdAt, right.index));
        const messages = [];
        let previousMessageId = null;
        for (const { message, index, content } of rawMessages) {
          const messageId = stableId('chathub-msg', `${conversation.model}|${conversation.id}|${message?.id || index}`);
          const createdAt = asUnixSeconds(message?.createdAt, asUnixSeconds(conversation.createdAt));
          const metadata = {
            source: `chathub-${conversation.sourceKind || backup.kind}-indexeddb`,
            model: conversation.model,
            model_label: modelLabel(conversation.model),
            author: String(message?.author || message?.role || ''),
            source_message_id: String(message?.id || ''),
            part_types: asArray(message?.parts).map((part) => part?.type).filter(Boolean),
            ...(asArray(message?.files).length > 0 ? { attachments: message.files } : {}),
          };
          messages.push({
            id: messageId,
            conversation_id: conversation.id,
            role: messageRole(message),
            content,
            metadata_json: JSON.stringify(metadata),
            created_at: createdAt,
            parent_id: previousMessageId,
          });
          previousMessageId = messageId;
        }

        const firstUserMessage = messages.find((message) => message.role === 'user');
        const createdAt = asUnixSeconds(conversation.createdAt, messages[0]?.created_at);
        const updatedAt = asUnixSeconds(conversation.updatedAt, messages.at(-1)?.created_at || createdAt);
        normalizedConversations.push({
          id: conversation.id,
          title: compactTitle(firstUserMessage?.content, `${modelLabel(conversation.model)} chat`),
          created_at: createdAt,
          updated_at: updatedAt,
          last_synced_updated_at: updatedAt,
          current_node_id: messages.at(-1)?.id || null,
          is_deleted_on_web: 0,
          messages,
        });
    }

    return writeNormalizedArchive({
      db,
      conversations: normalizedConversations,
      replaceExisting,
      sourcePath: inputPath,
      sourceItems: conversations.length,
      models: [...new Set(conversations.map((conversation) => conversation.model))].sort(),
    });
  } finally {
    materialized.cleanup();
  }
}

module.exports = {
  id: 'chathub',
  name: 'ChatHub',
  description: 'ChatHub browser IndexedDB exports',
  accent: '#6366f1',
  capabilities: { importBackup: true },
  importBackup,
  modelLabel,
  normalizeRecords,
};
