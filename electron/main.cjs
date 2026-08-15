const { app, BrowserWindow, ipcMain, protocol, session, clipboard, nativeImage, crashReporter, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const ChatGPTAuth = require('./auth.cjs');
const ChatDatabase = require('./database.cjs');
const AccountManager = require('./accounts/manager.cjs');
const registerArchiveIpc = require('./ipc/archive.cjs');
const { registerChatGptCacheIpc } = require('./services/chatgpt-cache.cjs');
const createAiModeBridge = require('./bridges/ai-mode.cjs');
const createChatGptRuntime = require('./bridges/chatgpt.cjs');
const {
  buildOrderedVisibleTurns,
  getLinearMessages: getLinearConversationMessages,
  shouldPreserveCachedSnapshot,
} = require('./conversations/chatgpt-tree.cjs');
const {
  buildDeterministicId,
  importAiModeTakeout,
  normalizeAiModeTitle,
} = require('./aimode-takeout.cjs');

const APPLICATION_NAME = 'aibackman';
const LEGACY_APPLICATION_NAME = 'chatgpt';
const isDev = process.env.NODE_ENV === 'development';
const OOM_DEBUG = process.env.AIBACKMAN_OOM_DEBUG === '1';
const OOM_TRACE_GC = process.env.AIBACKMAN_TRACE_GC === '1';
const DEBUG_MODE = process.env.AIBACKMAN_DEBUG === '1' || OOM_DEBUG;
const DEBUG_SESSION_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
let debugRuntimePaths = null;

function configureApplicationStorage() {
  const appDataPath = app.getPath('appData');
  const applicationPath = path.join(appDataPath, APPLICATION_NAME);
  const legacyPath = path.join(appDataPath, LEGACY_APPLICATION_NAME);
  let userDataPath = applicationPath;

  if (!fs.existsSync(applicationPath) && fs.existsSync(legacyPath)) {
    try {
      fs.renameSync(legacyPath, applicationPath);
    } catch (error) {
      console.error('[storage] Failed to migrate legacy ChatGPT data directory:', error);
      userDataPath = legacyPath;
    }
  } else if (
    !fs.existsSync(path.join(applicationPath, 'archive-catalog.db'))
    && !fs.existsSync(path.join(applicationPath, 'chatgpt.db'))
    && fs.existsSync(legacyPath)
  ) {
    userDataPath = legacyPath;
  }

  app.setPath('userData', userDataPath);
}

function serializeDebugPayload(payload) {
  const seen = new WeakSet();
  return JSON.stringify(payload, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  });
}

function appendDebugEvent(event, payload = {}) {
  if (!DEBUG_MODE || !debugRuntimePaths?.events) return;
  try {
    fs.appendFileSync(debugRuntimePaths.events, `${serializeDebugPayload({
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      payload,
    })}\n`);
  } catch (error) {
    console.warn('[debug] Failed to persist diagnostic event:', error);
  }
}

function initializeDebugRuntime() {
  if (!DEBUG_MODE) return;
  try {
    const debugDir = path.resolve(
      process.env.AIBACKMAN_DEBUG_DIR || path.join(app.getPath('userData'), 'debug')
    );
    const crashDumps = path.join(debugDir, 'crashes');
    fs.mkdirSync(crashDumps, { recursive: true });
    debugRuntimePaths = {
      directory: debugDir,
      events: path.join(debugDir, `events-${DEBUG_SESSION_ID}.jsonl`),
      chromium: path.join(debugDir, `chromium-${DEBUG_SESSION_ID}.log`),
      crashDumps,
    };
    app.setPath('crashDumps', crashDumps);

    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
    app.commandLine.appendSwitch('remote-debugging-port', process.env.AIBACKMAN_REMOTE_DEBUG_PORT || '9222');
    app.commandLine.appendSwitch('enable-logging', 'file');
    app.commandLine.appendSwitch('log-file', debugRuntimePaths.chromium);
    app.commandLine.appendSwitch('log-level', '0');
    if (process.env.AIBACKMAN_VERBOSE_LOGGING === '1') app.commandLine.appendSwitch('v', '1');

    crashReporter.start({
      productName: 'AIBackman',
      companyName: 'local',
      submitURL: 'https://localhost.invalid',
      uploadToServer: false,
      compress: false,
      rateLimit: false,
      globalExtra: {
        debug_session: DEBUG_SESSION_ID,
        electron_version: process.versions.electron || '',
      },
    });
    appendDebugEvent('debug-runtime-started', {
      argv: process.argv,
      versions: process.versions,
      paths: debugRuntimePaths,
      remoteDebuggingPort: process.env.AIBACKMAN_REMOTE_DEBUG_PORT || '9222',
    });
    console.info('[debug] Persistent diagnostics:', debugRuntimePaths);
  } catch (error) {
    console.error('[debug] Failed to initialize persistent diagnostics:', error);
  }
}

if (OOM_DEBUG) {
  const jsFlags = [
    '--max-old-space-size=8192',
    '--expose-gc',
    OOM_TRACE_GC ? '--trace-gc' : '',
  ].filter(Boolean).join(' ');
  app.commandLine.appendSwitch('js-flags', jsFlags);
  app.commandLine.appendSwitch('enable-precise-memory-info');
}

configureApplicationStorage();
initializeDebugRuntime();

if (DEBUG_MODE) {
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    appendDebugEvent('main-uncaught-exception', { origin, error });
  });
  process.on('unhandledRejection', (reason) => {
    appendDebugEvent('main-unhandled-rejection', { reason });
  });
  process.on('warning', (warning) => {
    appendDebugEvent('main-process-warning', { warning });
  });
}

let mainWindow;
let auth;
let db;
let aiDb;
let accountManager;
let chatgptRuntime = null;
const shouldShowBridgeWindow = () => isDev || process.env.AIBACKMAN_BRIDGE_VISIBLE === '1';
const BRIDGE_FAST_MODE = process.env.AIBACKMAN_BRIDGE_FAST_MODE !== '0';
const BRIDGE_FAST_TURNS = Math.max(1, Number(process.env.AIBACKMAN_BRIDGE_FAST_TURNS || 1));
const BRIDGE_FAST_CACHE = Math.max(1, Number(process.env.AIBACKMAN_BRIDGE_FAST_CACHE || 5));
const BRIDGE_RESOURCE_BLOCKING = process.env.AIBACKMAN_BRIDGE_RESOURCE_BLOCKING === '1';
const BRIDGE_BLOCKED_RESOURCE_TYPES = new Set(['image', 'imageset', 'media', 'font']);
const AI_MODE_URL = process.env.AI_MODE_URL || 'https://www.google.com/search?udm=50&aep=11';
const AI_MODE_HISTORY_BUTTON_SELECTOR = 'button.UTNPFf[aria-label="AI Mode history"], button[aria-label="AI Mode history"]';
const AI_MODE_HISTORY_DIALOG_SELECTOR = '[role="dialog"][aria-label="AI Mode history"], .ho072b[aria-label="AI Mode history"]';
const AI_MODE_HISTORY_ITEM_SELECTOR = '#aim-lhs-panel-threads-view-container button.qqMZif[data-thread-id], ul[data-xid="threads-list-root"] button.qqMZif[data-thread-id], button.qqMZif[data-thread-id]';
let aiModeBridge = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      additionalArguments: [`--aibackman-debug=${DEBUG_MODE ? '1' : '0'}`],
    },
  });
  chatgptRuntime.attachRendererDiagnostics('main', mainWindow.webContents);

  if (DEBUG_MODE && process.env.AIBACKMAN_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.openDevTools({ mode: 'detach' });
    });
  }

  // Register custom protocol for images
  // This allows us to fetch images in the main process with full auth
  protocol.handle('chatgpt-image', async (request) => {
    let requestPath = request.url;
    try {
      const parsed = new URL(request.url);
      requestPath = `${parsed.host}${parsed.pathname}`.replace(/^\/+/, '');
    } catch {
      requestPath = request.url.replace('chatgpt-image://', '').replace(/^\/+/, '');
    }

    const fileId = chatgptRuntime.extractFileId(requestPath) || requestPath;
    if (!fileId) {
      return new Response('Missing image id', { status: 400 });
    }

    try {
      // Use the internal fetch with full session/auth
      const parsed = new URL(request.url);
      const conversationId = parsed.searchParams.get('conversation_id');
      const response = await chatgptRuntime.fetchImageResponse(fileId, conversationId || undefined);
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`Image fetch failed (${response.status}) for ${fileId}:`, errorText.slice(0, 300));
        return new Response(errorText || 'Failed to load image', { status: response.status });
      }

      // Materialize bytes in main process to avoid renderer stream/protocol edge cases.
      const body = await response.arrayBuffer();

      // Strip restrictive headers that can block image embedding from custom protocols.
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.delete('content-security-policy');
      headers.delete('content-disposition'); // Prevents it from being treated as a download attachment
      headers.delete('x-frame-options');
      headers.delete('cross-origin-resource-policy');
      headers.delete('cross-origin-opener-policy');
      headers.delete('cross-origin-embedder-policy');
      headers.delete('permissions-policy');

      if (!headers.get('content-type')) {
        headers.set('content-type', 'image/png');
      }

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
    } catch (e) {
      console.error('Failed to fetch image via protocol:', e);
      return new Response('Failed to load image', { status: 500 });
    }
  });

  // Use Electron's Chromium UA, but drop the Electron token to reduce fingerprint mismatch.
  const normalizedUA = chatgptRuntime.ensureAppUserAgent();
  mainWindow.webContents.setUserAgent(normalizedUA);
  session.defaultSession.setUserAgent(normalizedUA, 'en-GB,en-US;q=0.9,en;q=0.8');

  auth.mainWindow = mainWindow;

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

function getLinearMessages(conversationId, dbInstance = db) {
  return getLinearConversationMessages(dbInstance, conversationId);
}

function buildOrderedVisibleTurnsFromConversationData(data, conversationId) {
  return buildOrderedVisibleTurns(data, conversationId, chatgptRuntime.renderMessageContent);
}

function shouldPreserveCachedConversationSnapshot(existingMessages, remoteTurns) {
  return shouldPreserveCachedSnapshot(existingMessages, remoteTurns);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeWorkspaceMode(rawMode) {
  if (accountManager && rawMode && typeof rawMode === 'object') {
    const account = accountManager.resolveAccount(rawMode);
    if (account?.agentId === 'google-ai-mode') return 'aimode';
    if (account?.agentId === 'chatgpt') return 'chatgpt';
    return account?.agentId || 'chatgpt';
  }
  return String(rawMode || '').toLowerCase() === 'aimode' ? 'aimode' : 'chatgpt';
}

function getDatabaseForMode(rawMode) {
  if (accountManager) {
    const account = accountManager.resolveAccount(rawMode);
    if (account) return accountManager.getDatabase(account);
  }
  return normalizeWorkspaceMode(rawMode) === 'aimode' ? aiDb : db;
}

function getAccountForPayload(payload) {
  return accountManager?.resolveAccount(payload) || null;
}

function notifyArchiveChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('archive:accountsChanged');
  }
}

async function syncLiveAccountIdentities() {
  if (!accountManager) return;
  const identities = await Promise.all([
    auth?.getIdentity?.() || Promise.resolve(null),
    aiModeBridge?.getAccountIdentity?.() || Promise.resolve(null),
  ]);
  const updates = [
    ['chatgpt-default', identities[0]],
    ['google-ai-mode-default', identities[1]],
  ];
  let changed = false;
  for (const [accountId, identity] of updates) {
    if (!identity) continue;
    const before = accountManager.getAccount(accountId);
    const after = accountManager.updateAccountIdentity(accountId, identity);
    if (before?.label !== after?.label) changed = true;
  }
  if (changed) notifyArchiveChanged();
}

function setupIpc() {
  ipcMain.handle('auth:login', async () => {
    const success = await auth.login();
    if (success) {
      const identity = await auth.getIdentity();
      if (identity) {
        const before = accountManager.getAccount('chatgpt-default');
        const after = accountManager.updateAccountIdentity('chatgpt-default', identity);
        if (before?.label !== after?.label) notifyArchiveChanged();
      }
    }
    return success;
  });

  ipcMain.handle('auth:check', async () => {
    const token = await auth.getAccessToken();
    return !!token;
  });

  ipcMain.handle('auth:reauth', async () => {
    return await auth.reauthenticate({ hardReset: true });
  });

  registerArchiveIpc({
    ipcMain,
    dialog,
    app,
    getMainWindow: () => mainWindow,
    accountManager,
    getDatabase: getDatabaseForMode,
    notifyArchiveChanged,
  });

  ipcMain.handle('ai:importTakeout', async (event, payload) => {
    const inputPath = String(payload?.path || '').trim();
    if (!inputPath) throw new Error('Missing takeout JSON path');
    if (!fs.existsSync(inputPath)) throw new Error(`Takeout file not found: ${inputPath}`);
    const imported = payload?.accountId
      ? await accountManager.importBackup(payload.accountId, inputPath)
      : importAiModeTakeout(aiDb, inputPath);
    return { success: true, ...imported };
  });

  registerChatGptCacheIpc({
    ipcMain,
    auth,
    db,
    resolveAccount: getAccountForPayload,
    conversations: {
      getLinear: (conversationId) => getLinearMessages(conversationId),
      buildRemoteTurns: buildOrderedVisibleTurnsFromConversationData,
      shouldPreserve: shouldPreserveCachedConversationSnapshot,
      writeSnapshot: (conversation, data) => {
        let wroteAnyMessage = false;
        db.db.transaction(() => {
          db.upsertConversation({
            ...conversation,
            current_node_id: data.current_node,
            last_synced_updated_at: conversation.updated_at ?? null,
          });
          Object.values(data.mapping).forEach((node) => {
            if (!node.message) return;
            wroteAnyMessage = true;
            db.upsertMessage({
              id: node.message.id,
              conversation_id: conversation.id,
              role: node.message.author?.role || 'assistant',
              content: chatgptRuntime.renderMessageContent(node.message, conversation.id) || '',
              metadata_json: chatgptRuntime.mergeEmbeddedUiMetadataJson(
                node.message.id,
                chatgptRuntime.sanitizeMetadata(node.message.metadata),
                db
              ),
              created_at: node.message.create_time || 0,
              parent_id: node.parent,
            });
          });
        })();
        return wroteAnyMessage;
      },
    },
  });

  ipcMain.handle('db:getMessages', async (event, arg1, arg2) => {
    const conversationId = typeof arg1 === 'object' ? arg1?.conversationId : arg1;
    const mode = typeof arg1 === 'object' ? arg1 : arg2;
    if (!conversationId) throw new Error('Missing conversationId');
    const targetDb = getDatabaseForMode(mode);
    return getLinearMessages(conversationId, targetDb);
  });

  ipcMain.handle('db:getConversationState', async (event, arg1, arg2) => {
    const conversationId = typeof arg1 === 'object' ? arg1?.conversationId : arg1;
    const mode = typeof arg1 === 'object' ? arg1 : arg2;
    if (!conversationId) throw new Error('Missing conversationId');
    const targetDb = getDatabaseForMode(mode);
    const conversation = targetDb.getConversation(conversationId) || null;
    const allMessages = targetDb.getMessages(conversationId);
    const currentMessages = getLinearMessages(conversationId, targetDb);
    return {
      conversation,
      currentNodeId: conversation?.current_node_id || null,
      allMessages,
      currentMessages,
    };
  });

  ipcMain.handle('api:prewarmConversation', async (event, payload) => {
    const conversationId = typeof payload === 'string'
      ? payload
      : (payload?.conversationId || null);
    const account = getAccountForPayload(payload);
    const mode = normalizeWorkspaceMode(payload);
    const forceReload = typeof payload === 'object' ? !!payload?.forceReload : false;
    const requireComposer = typeof payload === 'object' ? payload?.requireComposer !== false : true;
    if (!account?.capabilities.liveSync) {
      return { success: true, reason: 'This account is backed by its local archive.' };
    }
    if (mode === 'aimode') {
      if (!conversationId) {
        return { success: false, reason: 'Missing AI Mode conversation id' };
      }
      try {
        const ref = await aiModeBridge.resolveConversationRef(conversationId);
        if (!ref) {
          return { success: false, reason: 'AI Mode conversation ref not found' };
        }
        const opened = await aiModeBridge.openConversation(ref);
        return {
          success: !!opened,
          reason: opened ? '' : 'Could not open AI Mode conversation in bridge'
        };
      } catch (error) {
        console.warn('AI Mode prewarm failed:', error);
        return { success: false, reason: String(error?.message || error) };
      }
    }
    return chatgptRuntime.prewarmConversation(conversationId, { forceReload, requireComposer });
  });

  ipcMain.handle('api:getBridgeComposerStatus', async () => {
    return chatgptRuntime.getComposerStatus();
  });

  ipcMain.handle('db:searchMessages', async (event, arg1, arg2) => {
    const query = typeof arg1 === 'object' ? arg1?.query : arg1;
    const mode = typeof arg1 === 'object' ? arg1 : arg2;
    const targetDb = getDatabaseForMode(mode);
    return targetDb.searchMessages(String(query || ''));
  });

  ipcMain.handle('api:getImageDataUrl', async (event, payload) => {
    try {
      const rawImageId = typeof payload === 'string' ? payload : payload?.rawImageId;
      const conversationId = typeof payload === 'string' ? undefined : payload?.conversationId;
      const fileId = chatgptRuntime.extractFileId(rawImageId) || String(rawImageId || '').replace(/^\/+/, '');
      if (!fileId) return null;

      const response = await chatgptRuntime.fetchImageResponse(fileId, conversationId);
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`Fallback image fetch failed (${response.status}) for ${fileId}:`, errorText.slice(0, 300));
        return null;
      }

      const contentType = response.headers.get('content-type') || 'image/png';
      const body = Buffer.from(await response.arrayBuffer());
      return `data:${contentType};base64,${body.toString('base64')}`;
    } catch (error) {
      console.error('Fallback image fetch errored:', error);
      return null;
    }
  });

  ipcMain.handle('api:copyImageToClipboard', async (event, payload) => {
    try {
      const source = typeof payload === 'string' ? payload : payload?.src;
      const conversationId = typeof payload === 'string' ? undefined : payload?.conversationId;
      if (!source || typeof source !== 'string') return { success: false, error: 'Invalid image source' };

      let image = null;

      if (source.startsWith('data:image/')) {
        const parsed = chatgptRuntime.parseDataUrl(source);
        if (!parsed) return { success: false, error: 'Invalid data URL' };
        image = nativeImage.createFromBuffer(parsed.buffer);
      } else if (source.startsWith('chatgpt-image://')) {
        let requestPath = source;
        let srcConversationId = conversationId;
        try {
          const parsedUrl = new URL(source);
          requestPath = `${parsedUrl.host}${parsedUrl.pathname}`.replace(/^\/+/, '');
          if (!srcConversationId) srcConversationId = parsedUrl.searchParams.get('conversation_id') || undefined;
        } catch {
          requestPath = source.replace('chatgpt-image://', '').replace(/^\/+/, '');
        }

        const fileId = chatgptRuntime.extractFileId(requestPath) || requestPath;
        if (!fileId) return { success: false, error: 'Missing file id' };

        const response = await chatgptRuntime.fetchImageResponse(fileId, srcConversationId);
        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          return { success: false, error: `Image fetch failed (${response.status}) ${errorText.slice(0, 200)}` };
        }

        const body = Buffer.from(await response.arrayBuffer());
        image = nativeImage.createFromBuffer(body);
      } else {
        const response = await session.defaultSession.fetch(source, { headers: { Accept: 'image/*,*/*;q=0.8' } });
        if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
        const body = Buffer.from(await response.arrayBuffer());
        image = nativeImage.createFromBuffer(body);
      }

      if (!image || image.isEmpty()) return { success: false, error: 'Could not decode image' };
      clipboard.writeImage(image);
      return { success: true };
    } catch (error) {
      console.error('Copy image failed:', error);
      return { success: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle('api:auditDeletions', async (event, payload) => {
    const account = getAccountForPayload(payload);
    if (!account?.capabilities.cacheAll) {
      return { success: false, markedCount: 0, reason: 'This account does not support a remote deletion audit' };
    }
    try {
      let allApiIds = new Set();
      let offset = 0;
      let hasMore = true;
      while (hasMore && allApiIds.size < 500) {
        const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=50&order=updated`);
        const data = await response.json();
        if (data.items) {
          data.items.forEach(item => allApiIds.add(item.id));
          offset += data.items.length;
          hasMore = offset < data.total;
        } else { hasMore = false; }
      }
      const localConvs = db.getConversations();
      let markedCount = 0;
      localConvs.forEach(conv => {
        if (!conv.is_deleted_on_web && !allApiIds.has(conv.id)) {
          db.markAsDeletedOnWeb(conv.id);
          markedCount++;
        } else if (conv.is_deleted_on_web && allApiIds.has(conv.id)) {
          const updated = { ...conv, is_deleted_on_web: 0 };
          db.upsertConversation(updated);
        }
      });
      return { success: true, markedCount };
    } catch (error) {
      console.error('Audit failed:', error);
      throw error;
    }
  });

  const lastSync = new Map();

  ipcMain.handle('api:syncConversations', async (event, payload = {}) => {
    const account = getAccountForPayload(payload);
    const targetDb = getDatabaseForMode(payload);
    if (!account?.capabilities.liveSync) {
      const conversations = targetDb.getConversations();
      return { conversations, total: conversations.length, hasMore: false };
    }
    const mode = normalizeWorkspaceMode(payload);
    const offset = Number(payload?.offset || 0);
    const limit = Number(payload?.limit || 20);
    if (mode === 'aimode') {
      try {
        const refs = await aiModeBridge.fetchConversationIndex(3000);
        const now = Date.now() / 1000;
        const existingConvs = aiDb.getConversations();
        const byTitle = new Map();
        for (const conv of existingConvs) {
          const normalizedTitle = normalizeAiModeTitle(conv.title || '').toLowerCase();
          if (!normalizedTitle) continue;
          if (!byTitle.has(normalizedTitle)) byTitle.set(normalizedTitle, []);
          byTitle.get(normalizedTitle).push(conv.id);
        }
        const takenIds = new Set();

        aiDb.db.transaction(() => {
          for (const ref of refs) {
            const threadId = String(ref.threadId || '').trim();
            const normalizedTitle = normalizeAiModeTitle(ref.title || '').toLowerCase();
            let id = null;

            if (threadId && aiModeBridge.threadIdToConversationId.has(threadId)) {
              id = aiModeBridge.threadIdToConversationId.get(threadId);
            }

            if (!id && threadId) {
              const candidateLiveId = aiModeBridge.deriveConversationId(ref);
              if (aiDb.getConversation(candidateLiveId)) {
                id = candidateLiveId;
              }
            }

            if (!id && normalizedTitle && byTitle.has(normalizedTitle)) {
              const queue = byTitle.get(normalizedTitle);
              while (queue.length > 0) {
                const candidate = queue.shift();
                if (!takenIds.has(candidate)) {
                  id = candidate;
                  break;
                }
              }
            }

            if (!id) {
              id = aiModeBridge.deriveConversationId(ref);
            }
            takenIds.add(id);

            aiModeBridge.conversationRefs.set(id, { ...ref });
            if (threadId) {
              aiModeBridge.threadIdToConversationId.set(threadId, id);
            }
            const existing = aiDb.getConversation(id);
            const createdAt = Number(existing?.created_at || now);
            const visualIndex = Number.isFinite(Number(ref.visualIndex)) ? Number(ref.visualIndex) : 0;
            const orderedUpdatedAt = now - (visualIndex * 0.001);
            aiDb.upsertConversation({
              id,
              title: normalizeAiModeTitle(ref.title),
              created_at: createdAt,
              updated_at: orderedUpdatedAt,
              current_node_id: existing?.current_node_id || null,
              is_deleted_on_web: 0,
            });
          }
        })();
        const removed = aiModeBridge.cleanupShadowConversations();
        if (removed > 0) {
          console.info(`[aimode-sync] removed ${removed} duplicate shadow conversations`);
        }
      } catch (error) {
        console.warn('AI Mode remote conversation sync failed; using local data only:', error);
      }
      const localConversations = aiDb.getConversations();
      const convById = new Map(localConversations.map((c) => [c.id, c]));
      const ordered = [];
      const seen = new Set();
      for (const ref of aiModeBridge.conversationRefs.values()) {
        const threadId = String(ref?.threadId || '').trim();
        const mappedId = threadId && aiModeBridge.threadIdToConversationId.has(threadId)
          ? aiModeBridge.threadIdToConversationId.get(threadId)
          : aiModeBridge.deriveConversationId(ref);
        if (!mappedId || seen.has(mappedId)) continue;
        const conv = convById.get(mappedId);
        if (!conv) continue;
        seen.add(mappedId);
        ordered.push(conv);
      }
      for (const conv of localConversations) {
        if (seen.has(conv.id)) continue;
        seen.add(conv.id);
        ordered.push(conv);
      }
      return {
        conversations: ordered,
        total: ordered.length,
        hasMore: false,
      };
    }
    try {
      const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`);
      const data = await response.json();
      if (data.items) {
        db.db.transaction(() => {
          data.items.forEach(item => {
            const existing = db.getConversation(item.id);
            db.upsertConversation({
              id: item.id,
              title: item.title,
              created_at: item.create_time,
              updated_at: item.update_time,
              last_synced_updated_at: existing ? existing.last_synced_updated_at : null,
              current_node_id: existing ? existing.current_node_id : null
            });
          });
        })();
      }
      return { 
        conversations: db.getConversations(),
        total: data.total,
        hasMore: (offset + limit) < data.total
      };
    } catch (error) {
      console.error('Sync failed:', error);
      throw error;
    }
  });

  ipcMain.handle('api:sendMessage', async (event, payload = {}) => {
    const { conversationId, content, model, image, files } = payload;
    try {
      const account = getAccountForPayload(payload);
      if (!account?.capabilities.send) {
        throw new Error('This archive account is read-only.');
      }
      const fileList = Array.isArray(files) ? files : [];

      const prompt = String(content || '');
      if (!prompt.trim() && !image && fileList.length === 0) {
        throw new Error('Cannot send an empty message.');
      }

      const warmResult = await chatgptRuntime.prewarmConversation(conversationId || null);
      if (!warmResult?.success) {
        throw new Error(chatgptRuntime.getComposerStatus().reason || 'Chat is not ready for sending yet.');
      }

      chatgptRuntime.publishComposerStatus({
        conversationId: conversationId || null,
        state: 'sending',
        ready: false,
        reason: '',
      });

      const uiResult = await chatgptRuntime.sendConversation({
        conversationId: conversationId || null,
        content: prompt,
        model,
        image,
        files: fileList,
      });

      if (!uiResult?.ok) {
        const detail = chatgptRuntime.parseBackendErrorDetail(String(uiResult?.bodyText || uiResult?.statusText || ''));
        throw new Error(detail || 'Failed to send message via bridge window UI.');
      }

      chatgptRuntime.publishComposerStatus({
        conversationId: conversationId || null,
        state: 'thinking',
        ready: false,
        reason: '',
      });
      chatgptRuntime.monitorGeneration(conversationId || null).catch((error) => {
        console.warn('Bridge generation monitor failed:', error);
      });

      return { success: true };
    } catch (error) {
      chatgptRuntime.publishComposerStatus({
        conversationId: conversationId || null,
        state: 'error',
        ready: false,
        reason: String(error?.message || error || 'Send failed'),
      });
      console.error('Send message failed:', error);
      throw error;
    }
  });

  ipcMain.handle('api:syncMessages', async (event, payload) => {
    const account = getAccountForPayload(payload);
    const targetDb = getDatabaseForMode(payload);
    const mode = normalizeWorkspaceMode(payload);
    const conversationId = typeof payload === 'string' ? payload : payload?.conversationId;
    const force = typeof payload === 'string' ? false : !!payload?.force;
    if (!conversationId) throw new Error('Missing conversationId');
    if (!account?.capabilities.liveSync) {
      return getLinearMessages(conversationId, targetDb);
    }
    if (mode === 'aimode') {
      const key = `aimode:${conversationId}`;
      const now = Date.now();
      if (!force && lastSync.has(key) && now - lastSync.get(key) < 30000) {
        return getLinearMessages(conversationId, aiDb);
      }

      try {
        const ref = await aiModeBridge.resolveConversationRef(conversationId);
        if (!ref) {
          lastSync.set(key, now);
          return getLinearMessages(conversationId, aiDb);
        }

        const opened = await aiModeBridge.openConversation(ref);
        if (!opened) {
          throw new Error('Could not open AI Mode conversation in bridge');
        }
        let remoteTurns = await aiModeBridge.scrapeMessages();
        if (remoteTurns.length <= 2) {
          await sleep(450);
          const retryTurns = await aiModeBridge.scrapeMessages();
          if (Array.isArray(retryTurns) && retryTurns.length > remoteTurns.length) {
            remoteTurns = retryTurns;
          }
        }
        if (remoteTurns.length > 0) {
          const normalizeComparable = (value) => String(value || '')
            .toLowerCase()
            .replace(/\\u00a0/g, ' ')
            .replace(/\\s+/g, ' ')
            .trim();
          const existingLinear = getLinearMessages(conversationId, aiDb)
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content && String(m.content).trim());
          const existingFingerprints = new Set(
            existingLinear.map((m) => `${m.role}|${normalizeComparable(m.content)}`).filter((fp) => fp && !fp.endsWith('|'))
          );
          const remoteFingerprints = new Set(
            remoteTurns
              .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content && String(m.content).trim())
              .map((m) => `${m.role === 'assistant' ? 'assistant' : 'user'}|${normalizeComparable(m.content)}`)
              .filter((fp) => fp && !fp.endsWith('|'))
          );
          const existingCount = existingFingerprints.size;
          const remoteCount = remoteFingerprints.size;
          const existingLinearCount = existingLinear.length;
          const duplicateBloatRatio = existingCount > 0 ? (existingLinearCount / existingCount) : 1;
          const hasDuplicateBloat = duplicateBloatRatio >= 1.5;

          // Protect against partial bridge scrapes replacing a full cached conversation.
          if (!hasDuplicateBloat && existingCount >= 6 && remoteCount > 0 && remoteCount < Math.max(4, Math.floor(existingCount * 0.55))) {
            lastSync.set(key, now);
            return getLinearMessages(conversationId, aiDb);
          }

          if (remoteCount <= 2 && existingCount > 2) {
            lastSync.set(key, now);
            return getLinearMessages(conversationId, aiDb);
          }

          aiDb.db.transaction(() => {
            const existing = aiDb.getConversation(conversationId);
            const baseCreated = Number(existing?.created_at || Date.now() / 1000);
            // Replace the conversation snapshot atomically to avoid duplicate growth
            // when repeated refreshes scrape slightly different DOM fragments.
            aiDb.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
            let prevMessageId = null;
            let lastMessageId = null;
            remoteTurns.forEach((turn, idx) => {
              const role = turn.role === 'assistant' ? 'assistant' : 'user';
              const content = String(turn.content || '').trim();
              if (!content) return;
              const msgId = `aimsg-live-${buildDeterministicId(`${conversationId}|${idx}|${role}|${content}`)}`;
              aiDb.upsertMessage({
                id: msgId,
                conversation_id: conversationId,
                role,
                content,
                metadata_json: null,
                created_at: baseCreated + (idx * 0.001),
                parent_id: prevMessageId,
              });
              prevMessageId = msgId;
              lastMessageId = msgId;
            });
            aiDb.upsertConversation({
              id: conversationId,
              title: normalizeAiModeTitle(ref.title || existing?.title || 'AI Mode Chat'),
              created_at: baseCreated,
              updated_at: Date.now() / 1000,
              current_node_id: lastMessageId || existing?.current_node_id || null,
              is_deleted_on_web: 0,
            });
          })();
        }
        lastSync.set(key, now);
      } catch (error) {
        console.warn('AI Mode message sync failed; using cached messages:', error);
      }
      return getLinearMessages(conversationId, aiDb);
    }
    const now = Date.now();
    if (!force && lastSync.has(conversationId) && now - lastSync.get(conversationId) < 30000) {
      return getLinearMessages(conversationId);
    }
    try {
      const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversation/${conversationId}`);
      const data = await response.json();
      if (data.mapping && data.current_node) {
        const embeddedUiMessageIds = chatgptRuntime.getEmbeddedUiMessageIds(data);
        const hasEmbeddedUiPayload = Object.values(data.mapping).some((node) => node?.message && chatgptRuntime.messageContainsEmbeddedUi(node.message));
        let capturedEmbeddedUi = hasEmbeddedUiPayload
          ? await chatgptRuntime.captureEmbeddedUi(chatgptRuntime.getBridgeWindow(), conversationId, { timeoutMs: 5000 })
          : [];
        if (capturedEmbeddedUi.length > 0) {
          capturedEmbeddedUi = await chatgptRuntime.captureEmbeddedUiSnapshots(chatgptRuntime.getBridgeWindow(), capturedEmbeddedUi, { timeoutMs: chatgptRuntime.deepResearchCaptureTimeoutMs });
        }
        const existingMessages = getLinearMessages(conversationId);
        const remoteTurns = buildOrderedVisibleTurnsFromConversationData(data, conversationId);
        if (shouldPreserveCachedConversationSnapshot(existingMessages, remoteTurns)) {
          if (capturedEmbeddedUi.length > 0) {
            chatgptRuntime.attachEmbeddedUiToConversation(conversationId, capturedEmbeddedUi, embeddedUiMessageIds);
          }
          lastSync.set(conversationId, now);
          return existingMessages;
        }
        db.db.transaction(() => {
          const existingConv = db.getConversation(conversationId);
          if (existingConv) {
            db.upsertConversation({
              ...existingConv,
              current_node_id: data.current_node,
              last_synced_updated_at: existingConv.updated_at ?? existingConv.last_synced_updated_at ?? null,
            });
          }
          Object.values(data.mapping).forEach(node => {
            if (node.message) {
              const content = chatgptRuntime.renderMessageContent(node.message, conversationId);
              db.upsertMessage({
                id: node.message.id,
                conversation_id: conversationId,
                role: node.message.author?.role || 'assistant',
                content: content || '',
                metadata_json: chatgptRuntime.mergeEmbeddedUiMetadataJson(
                  node.message.id,
                  chatgptRuntime.sanitizeMetadata(node.message.metadata),
                  db
                ),
                created_at: node.message.create_time || 0,
                parent_id: node.parent
              });
            }
          });
        })();
        if (capturedEmbeddedUi.length > 0) {
          chatgptRuntime.attachEmbeddedUiToConversation(conversationId, capturedEmbeddedUi, embeddedUiMessageIds);
        }
        lastSync.set(conversationId, now);
      }
      return getLinearMessages(conversationId);
    } catch (error) {
      console.warn('Message sync failed; using cached messages:', error);
      return getLinearMessages(conversationId);
    }
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'chatgpt-image', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } }
]);

app.whenReady().then(async () => {
  try {
    auth = new ChatGPTAuth(null);
    db = new ChatDatabase('chatgpt.db');
    aiDb = new ChatDatabase('aimode.db');
    chatgptRuntime = createChatGptRuntime({
      app,
      BrowserWindow,
      session,
      auth,
      db,
      getMainWindow: () => mainWindow,
      appendDebugEvent,
      debugMode: DEBUG_MODE,
      shouldShowWindow: shouldShowBridgeWindow,
      fastMode: BRIDGE_FAST_MODE,
      fastTurns: BRIDGE_FAST_TURNS,
      fastCache: BRIDGE_FAST_CACHE,
      resourceBlocking: BRIDGE_RESOURCE_BLOCKING,
      blockedResourceTypes: BRIDGE_BLOCKED_RESOURCE_TYPES,
    });
    aiModeBridge = createAiModeBridge({
      db: aiDb,
      buildDeterministicId,
      ensureBridgeWindow: chatgptRuntime.ensureBridgeWindow,
      navigateBridgeTo: chatgptRuntime.navigateBridgeTo,
      normalizeTitle: normalizeAiModeTitle,
      shouldShowWindow: shouldShowBridgeWindow,
      aiModeUrl: AI_MODE_URL,
      selectors: {
        historyButton: AI_MODE_HISTORY_BUTTON_SELECTOR,
        historyDialog: AI_MODE_HISTORY_DIALOG_SELECTOR,
        historyItem: AI_MODE_HISTORY_ITEM_SELECTOR,
      },
    });
    accountManager = new AccountManager({
      userDataPath: app.getPath('userData'),
      legacyDatabases: { chatgpt: db, aimode: aiDb },
    });
    await accountManager.initialize();
    setupIpc();
    createWindow();
    chatgptRuntime.startMetrics();
    void syncLiveAccountIdentities();
  } catch (error) {
    console.error('Failed to initialize archive accounts:', error);
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  if (DEBUG_MODE) {
    app.on('child-process-gone', (_event, details) => {
      console.error('[oom-main] child-process-gone', details);
      appendDebugEvent('child-process-gone', details);
      chatgptRuntime.logRendererMetrics('child-process-gone');
    });
  }
});

app.on('window-all-closed', () => {
  appendDebugEvent('window-all-closed');
  chatgptRuntime?.shutdown();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (!accountManager) return;
  accountManager.close();
  accountManager = null;
});
