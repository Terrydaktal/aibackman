const { app, BrowserWindow, ipcMain, protocol, net, session, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const ChatGPTAuth = require('./auth.cjs');
const ChatDatabase = require('./database.cjs');
const {
  buildDeterministicId,
  importAiModeTakeout,
  normalizeAiModeTitle,
} = require('./aimode-takeout.cjs');

const isDev = process.env.NODE_ENV === 'development';
const OOM_DEBUG = process.env.CHATGPT_OOM_DEBUG === '1';
const OOM_TRACE_GC = process.env.CHATGPT_TRACE_GC === '1';

if (OOM_DEBUG) {
  const jsFlags = [
    '--max-old-space-size=8192',
    '--expose-gc',
    OOM_TRACE_GC ? '--trace-gc' : '',
  ].filter(Boolean).join(' ');
  app.commandLine.appendSwitch('js-flags', jsFlags);
  app.commandLine.appendSwitch('enable-precise-memory-info');
  app.commandLine.appendSwitch('remote-debugging-port', process.env.CHATGPT_REMOTE_DEBUG_PORT || '9222');
  app.commandLine.appendSwitch('enable-logging');
  app.commandLine.appendSwitch('log-level', '0');
}

let mainWindow;
let auth;
let db;
let aiDb;
let bridgeWindow = null;
let appUserAgent = null;
let bridgeWarmRequestToken = 0;
let bridgeComposerStatus = {
  conversationId: null,
  state: 'idle',
  ready: false,
  reason: '',
  updatedAt: Date.now(),
};
let bridgeGenerationMonitorToken = 0;
let oomMetricsTimer = null;
let oomMemoryInfoWarned = false;

const shouldShowBridgeWindow = () => isDev || process.env.CHATGPT_BRIDGE_VISIBLE === '1';
const BRIDGE_FAST_MODE = process.env.CHATGPT_BRIDGE_FAST_MODE !== '0';
const BRIDGE_FAST_TURNS = Math.max(1, Number(process.env.CHATGPT_BRIDGE_FAST_TURNS || 1));
const BRIDGE_FAST_CACHE = Math.max(1, Number(process.env.CHATGPT_BRIDGE_FAST_CACHE || 5));
const BRIDGE_RESOURCE_BLOCKING = process.env.CHATGPT_BRIDGE_RESOURCE_BLOCKING === '1';
const BRIDGE_BLOCKED_RESOURCE_TYPES = new Set(['image', 'imageset', 'media', 'font']);
const AI_MODE_URL = process.env.AI_MODE_URL || 'https://www.google.com/search?udm=50&aep=11';
const AI_MODE_HISTORY_BUTTON_SELECTOR = 'button.UTNPFf[aria-label="AI Mode history"], button[aria-label="AI Mode history"]';
const AI_MODE_HISTORY_DIALOG_SELECTOR = '[role="dialog"][aria-label="AI Mode history"], .ho072b[aria-label="AI Mode history"]';
const AI_MODE_HISTORY_ITEM_SELECTOR = '#aim-lhs-panel-threads-view-container button.qqMZif[data-thread-id], ul[data-xid="threads-list-root"] button.qqMZif[data-thread-id], button.qqMZif[data-thread-id]';
let bridgeRequestBlockerInstalled = false;
const aiModeConversationRefs = new Map();
const aiModeThreadIdToConversationId = new Map();

function isAbortedNavigationError(errorOrCode) {
  if (typeof errorOrCode === 'number') return errorOrCode === -3;
  return !!(
    errorOrCode &&
    (errorOrCode.code === 'ERR_ABORTED' || errorOrCode.errno === -3)
  );
}

function publishBridgeComposerStatus(patch) {
  bridgeComposerStatus = {
    ...bridgeComposerStatus,
    ...patch,
    updatedAt: Date.now(),
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('api:bridgeComposerStatus', bridgeComposerStatus);
  }
}

function installBridgeRequestBlocker() {
  if (!BRIDGE_RESOURCE_BLOCKING || bridgeRequestBlockerInstalled) return;
  bridgeRequestBlockerInstalled = true;

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      if (!bridgeWindow || bridgeWindow.isDestroyed()) {
        callback({});
        return;
      }
      if (details.webContentsId !== bridgeWindow.webContents.id) {
        callback({});
        return;
      }
      if (BRIDGE_BLOCKED_RESOURCE_TYPES.has(details.resourceType)) {
        callback({ cancel: true });
        return;
      }
      callback({});
    } catch {
      callback({});
    }
  });
}

function buildBridgeFastModeScript() {
  const maxTurns = BRIDGE_FAST_TURNS;
  const cacheSize = BRIDGE_FAST_CACHE;
  return `
    (() => {
      if (window.__codexBridgeFastModeInstalled) return;
      window.__codexBridgeFastModeInstalled = true;
      if (!window.__codexBridgeFastModeMeta) {
        window.__codexBridgeFastModeMeta = {
          installedAt: Date.now(),
          lastConversationId: null,
          lastConversationFetchAt: 0,
          lastOriginalVisible: 0,
          lastKeptVisible: 0,
          lastUrl: '',
          trimCount: 0,
        };
      }
      const MAX_TURNS = ${JSON.stringify(maxTurns)};
      const CACHE_SIZE = ${JSON.stringify(cacheSize)};
      const responseCache = new Map();

      const cacheGet = (key) => {
        const hit = responseCache.get(key);
        if (!hit) return null;
        responseCache.delete(key);
        responseCache.set(key, hit);
        return hit;
      };

      const cachePut = (key, value) => {
        responseCache.delete(key);
        responseCache.set(key, value);
        while (responseCache.size > CACHE_SIZE) {
          const oldest = responseCache.keys().next().value;
          if (!oldest) break;
          responseCache.delete(oldest);
        }
      };

      const isVisibleNode = (node) => {
        const role = node?.message?.author?.role;
        return role === 'user' || role === 'assistant';
      };

      const countVisibleMessages = (data) => {
        if (!data || typeof data !== 'object' || !data.mapping || typeof data.mapping !== 'object' || !data.current_node) {
          return 0;
        }
        const mapping = data.mapping;
        const chain = [];
        const visited = new Set();
        let nid = data.current_node;
        let guard = 0;
        while (nid && mapping[nid] && !visited.has(nid) && guard < 6000) {
          visited.add(nid);
          chain.push(nid);
          nid = mapping[nid]?.parent || null;
          guard++;
        }
        chain.reverse();
        let visible = 0;
        for (const id of chain) {
          if (isVisibleNode(mapping[id])) visible++;
        }
        return visible;
      };

      const trimConversationPayload = (data) => {
        if (!data || typeof data !== 'object' || !data.mapping || typeof data.mapping !== 'object' || !data.current_node) {
          return data;
        }

        const mapping = data.mapping;
        const chain = [];
        const visited = new Set();
        let nid = data.current_node;
        let guard = 0;

        while (nid && mapping[nid] && !visited.has(nid) && guard < 6000) {
          visited.add(nid);
          chain.push(nid);
          nid = mapping[nid]?.parent || null;
          guard++;
        }

        chain.reverse();
        if (chain.length === 0) return data;

        const visibleLimit = Math.max(1, MAX_TURNS * 2);
        let totalVisible = 0;
        for (const id of chain) {
          if (isVisibleNode(mapping[id])) totalVisible++;
        }
        if (totalVisible <= visibleLimit) return data;

        let count = 0;
        let cutoff = 0;
        for (let i = chain.length - 1; i >= 0; i--) {
          if (isVisibleNode(mapping[chain[i]])) {
            count++;
            if (count >= visibleLimit) {
              cutoff = i;
              break;
            }
          }
        }

        const keepSet = new Set();
        for (let i = 0; i < cutoff; i++) {
          if (!isVisibleNode(mapping[chain[i]])) keepSet.add(chain[i]);
        }
        for (let i = cutoff; i < chain.length; i++) {
          keepSet.add(chain[i]);
        }

        const keptChain = chain.filter((id) => keepSet.has(id));
        const trimmedMapping = {};
        for (let i = 0; i < keptChain.length; i++) {
          const id = keptChain[i];
          const src = mapping[id];
          if (!src) continue;
          const node = JSON.parse(JSON.stringify(src));
          node.parent = i > 0 ? keptChain[i - 1] : null;
          node.children = i < keptChain.length - 1 ? [keptChain[i + 1]] : [];
          trimmedMapping[id] = node;
        }

        return {
          ...data,
          mapping: trimmedMapping,
          current_node: keptChain[keptChain.length - 1] || data.current_node,
          root: keptChain[0] || data.root,
        };
      };

      let baseFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
      const WRAPPED_FETCH_MARK = '__codexWrappedFetch';
      if (typeof window.fetch === 'function' && window.fetch[WRAPPED_FETCH_MARK]) {
        return;
      }
      const wrappedFetch = async (...args) => {
        const input = args[0];
        const init = args[1] || {};
        const url = String(typeof input === 'string' ? input : (input && input.url) || '');
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        let pathname = '';
        try {
          pathname = new URL(url, location.origin).pathname || '';
        } catch {
          pathname = '';
        }
        const isConversationGet = method === 'GET' && /^\\/backend-api\\/conversation\\/[^/]+$/.test(pathname);
        if (!baseFetch) throw new Error('Base fetch unavailable');
        if (!isConversationGet) return baseFetch(...args);

        const cacheKey = method + ':' + url;
        const cached = cacheGet(cacheKey);
        if (cached) {
          return new Response(cached.body, {
            status: cached.status,
            statusText: cached.statusText,
            headers: new Headers(cached.headers),
          });
        }

        const response = await baseFetch(...args);
        if (!response.ok) return response;

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('application/json')) return response;

        let payload = null;
        try {
          payload = await response.clone().json();
        } catch {
          return response;
        }

        const originalVisible = countVisibleMessages(payload);
        const trimmed = trimConversationPayload(payload);
        const keptVisible = countVisibleMessages(trimmed);
        const body = JSON.stringify(trimmed);
        const headers = new Headers(response.headers);
        headers.set('content-type', 'application/json');
        headers.delete('content-length');
        headers.delete('content-encoding');

        cachePut(cacheKey, {
          body,
          status: response.status,
          statusText: response.statusText,
          headers: Array.from(headers.entries()),
        });

        const conversationMatch = pathname.match(/^\\/backend-api\\/conversation\\/([^/]+)$/);
        const conversationId = conversationMatch ? decodeURIComponent(conversationMatch[1]) : null;
        const meta = window.__codexBridgeFastModeMeta || {};
        meta.lastConversationId = conversationId;
        meta.lastConversationFetchAt = Date.now();
        meta.lastOriginalVisible = originalVisible;
        meta.lastKeptVisible = keptVisible;
        meta.lastUrl = url;
        meta.trimCount = Number(meta.trimCount || 0) + (keptVisible < originalVisible ? 1 : 0);
        window.__codexBridgeFastModeMeta = meta;

        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      };

      wrappedFetch[WRAPPED_FETCH_MARK] = true;
      window.fetch = wrappedFetch;
    })();
  `;
}

async function installBridgeFastMode(win) {
  if (!BRIDGE_FAST_MODE || !win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(buildBridgeFastModeScript(), true);
  } catch (error) {
    console.warn('Bridge fast mode injection failed:', error);
  }
}

function extractFileId(value) {
  if (!value) return null;
  const raw = String(value);
  const directMatch = raw.match(/file[_-][A-Za-z0-9_-]+/);
  if (directMatch) return directMatch[0];

  try {
    const parsed = new URL(raw);
    const candidate = `${parsed.host}${parsed.pathname}`.replace(/^\/+/, '');
    const parsedMatch = candidate.match(/file[_-][A-Za-z0-9_-]+/);
    if (parsedMatch) return parsedMatch[0];
  } catch {
    // Ignore parse failures and fall through.
  }

  return null;
}

async function fetchImageResponse(fileId, conversationId) {
  const encodedFileId = encodeURIComponent(fileId);
  const candidates = [];
  if (conversationId) {
    candidates.push(`https://chatgpt.com/backend-api/files/download/${encodedFileId}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`);
  }
  candidates.push(`https://chatgpt.com/backend-api/files/download/${encodedFileId}`);

  for (const url of candidates) {
    try {
      const metaResponse = await auth.fetchWithAuth(url, {
        headers: { Accept: 'application/json, text/plain, */*' },
      });

      if (!metaResponse.ok) {
        const errorText = await metaResponse.text().catch(() => '');
        console.error(`Image meta fetch failed (${metaResponse.status}) for ${fileId} via ${url}:`, errorText.slice(0, 300));
        continue;
      }

      const meta = await metaResponse.json().catch(() => null);
      const downloadUrl = meta && typeof meta.download_url === 'string' ? meta.download_url : null;
      if (!downloadUrl) continue;

      const fileResponse = await session.defaultSession.fetch(downloadUrl, {
        headers: { Accept: 'image/*,*/*;q=0.8' },
      });
      if (fileResponse.ok) return fileResponse;

      const downloadError = await fileResponse.text().catch(() => '');
      console.error(`Image download URL fetch failed (${fileResponse.status}) for ${fileId}:`, downloadError.slice(0, 300));
    } catch (error) {
      console.error(`Image download URL resolution failed for ${fileId}:`, error);
    }
  }

  // Legacy fallback.
  return auth.fetchWithAuth(`https://chatgpt.com/backend-api/files/${encodedFileId}/download`, {
    headers: { Accept: 'image/*,*/*;q=0.8' },
  });
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
  if (!match) return null;
  const mime = match[1] || 'image/png';
  const isBase64 = !!match[2];
  const payload = match[3] || '';
  try {
    const buffer = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    return { mime, buffer };
  } catch {
    return null;
  }
}

function getNormalizedSessionUserAgent() {
  const base = session.defaultSession.getUserAgent();
  return base.replace(/\sElectron\/[^\s]+/i, '').trim();
}

function ensureAppUserAgent() {
  if (!appUserAgent) appUserAgent = getNormalizedSessionUserAgent();
  return appUserAgent;
}

function normalizeChatgptUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return String(value || '').replace(/\/+$/, '');
  }
}

function formatKbToMB(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round((num / 1024) * 10) / 10;
}

async function getWebContentsMemorySummary(webContents) {
  if (!webContents || webContents.isDestroyed()) return null;
  try {
    const proc = await webContents.getProcessMemoryInfo();
    return {
      rssMB: formatKbToMB(proc.residentSet),
      privateMB: formatKbToMB(proc.private),
      sharedMB: formatKbToMB(proc.shared),
    };
  } catch (error) {
    if (OOM_DEBUG && !oomMemoryInfoWarned) {
      oomMemoryInfoWarned = true;
      console.warn('[oom-main] getProcessMemoryInfo unavailable:', String(error?.message || error));
    }
    return null;
  }
}

async function logRendererMetrics(reason) {
  if (!OOM_DEBUG) return;
  try {
    const metrics = app.getAppMetrics();
    const safePid = (win) => {
      try {
        if (!win || win.isDestroyed()) return null;
        const wc = win.webContents;
        if (!wc || wc.isDestroyed()) return null;
        return wc.getOSProcessId();
      } catch {
        return null;
      }
    };
    const mainPid = safePid(mainWindow);
    const bridgePid = safePid(bridgeWindow);
    const findByPid = (pid) => metrics.find((m) => Number(m.pid) === Number(pid)) || null;
    const slim = (metric) => {
      if (!metric) return null;
      return {
        pid: metric.pid,
        type: metric.type,
        wsMB: formatKbToMB(metric.memory?.workingSetSize),
        privMB: formatKbToMB(metric.memory?.privateBytes),
        sharedMB: formatKbToMB(metric.memory?.sharedBytes),
      };
    };
    const [mainProc, bridgeProc] = await Promise.all([
      getWebContentsMemorySummary(mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
      getWebContentsMemorySummary(bridgeWindow && !bridgeWindow.isDestroyed() ? bridgeWindow.webContents : null),
    ]);
    console.info('[oom-main]', JSON.stringify({
      ts: new Date().toISOString(),
      reason,
      main: slim(findByPid(mainPid)),
      bridge: slim(findByPid(bridgePid)),
      mainProc,
      bridgeProc,
    }));
  } catch (error) {
    console.warn('[oom-main] metrics read failed', error);
  }
}

function attachRendererDiagnostics(label, webContents) {
  if (!OOM_DEBUG || !webContents) return;
  webContents.on('render-process-gone', (_event, details) => {
    console.error(`[oom-main] ${label} render-process-gone`, details);
    logRendererMetrics(`${label}:render-process-gone`);
  });
  webContents.on('unresponsive', () => {
    console.error(`[oom-main] ${label} unresponsive`);
    logRendererMetrics(`${label}:unresponsive`);
  });
}

function startOomMetricsProbe() {
  if (!OOM_DEBUG || oomMetricsTimer) return;
  logRendererMetrics('startup').catch((error) => {
    console.warn('[oom-main] startup metrics failed', error);
  });
  oomMetricsTimer = setInterval(() => {
    logRendererMetrics('heartbeat').catch((error) => {
      console.warn('[oom-main] heartbeat metrics failed', error);
    });
  }, 2000);
}

async function ensureBridgeWindow() {
  if (bridgeWindow && !bridgeWindow.isDestroyed()) {
    return bridgeWindow;
  }

  installBridgeRequestBlocker();

  bridgeWindow = new BrowserWindow({
    show: shouldShowBridgeWindow(),
    width: 1200,
    height: 900,
    title: 'ChatGPT Web Bridge',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'bridge-preload.cjs'),
      additionalArguments: [
        `--bridge-fast-mode=${BRIDGE_FAST_MODE ? '1' : '0'}`,
        `--bridge-fast-turns=${String(BRIDGE_FAST_TURNS)}`,
        `--bridge-fast-cache=${String(BRIDGE_FAST_CACHE)}`,
      ],
    },
  });
  attachRendererDiagnostics('bridge', bridgeWindow.webContents);

  if (!shouldShowBridgeWindow()) {
    bridgeWindow.setSkipTaskbar(true);
  }

  bridgeWindow.webContents.setUserAgent(ensureAppUserAgent());
  bridgeWindow.webContents.setAudioMuted(true);
  bridgeWindow.webContents.on('did-finish-load', () => {
    installBridgeFastMode(bridgeWindow).catch((error) => {
      console.warn('Bridge fast mode post-load install failed:', error);
    });
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Bridge window load timeout')), 30000);
    bridgeWindow.webContents.once('did-finish-load', () => {
      clearTimeout(timeout);
      resolve();
    });
    bridgeWindow.webContents.once('did-fail-load', (_event, code, desc) => {
      clearTimeout(timeout);
      // Navigation handoff commonly triggers ERR_ABORTED (-3) when a newer loadURL supersedes this one.
      if (isAbortedNavigationError(code)) {
        resolve();
        return;
      }
      reject(new Error(`Bridge window failed to load (${code}): ${desc}`));
    });
    bridgeWindow.loadURL('https://chatgpt.com/').catch(reject);
  });

  bridgeWindow.on('closed', () => {
    bridgeWindow = null;
    publishBridgeComposerStatus({
      state: 'idle',
      ready: false,
      reason: 'Bridge window closed',
      conversationId: null,
    });
  });
  return bridgeWindow;
}

async function navigateBridgeTo(url) {
  const win = await ensureBridgeWindow();
  const homeUrl = 'https://chatgpt.com/';
  const targetUrl = url || homeUrl;
  const currentUrl = win.webContents.getURL();

  if (currentUrl && normalizeChatgptUrl(currentUrl) === normalizeChatgptUrl(targetUrl)) {
    await installBridgeFastMode(win);
    return win;
  }

  try {
    win.loadURL(targetUrl).catch((err) => {
      if (isAbortedNavigationError(err)) return;
      console.warn('Bridge navigation failed:', err);
    });
  } catch (err) {
    if (!isAbortedNavigationError(err)) {
      throw err;
    }
  }

  // We don't wait for did-finish-load, the composer poller is faster
  await sleep(100);
  await installBridgeFastMode(win);
  return win;
}

async function waitForBridgeComposer(win, conversationId) {
  const expectedPath = conversationId ? `/c/${conversationId}` : '/';
  const deadline = Date.now() + 30000;
  const startTime = Date.now();
  const expectedVisibleLimit = Math.max(1, BRIDGE_FAST_TURNS * 2);
  let lastState = null;
  let stableCounter = 0;

  while (Date.now() < deadline) {
    lastState = await win.webContents.executeJavaScript(
      `
        (() => {
          const getComposer = () =>
            document.querySelector('#prompt-textarea[contenteditable="true"]') ||
            document.querySelector('textarea#prompt-textarea') ||
            document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
            document.querySelector('textarea[placeholder*="ask" i], textarea[placeholder*="message" i]');
          const sendBtn =
            document.querySelector('#composer-submit-button') ||
            document.querySelector('button[data-testid="send-button"]') ||
            document.querySelector('button[aria-label="Send prompt"]') ||
            document.querySelector('button[aria-label*="Send"]');
          
          const composer = getComposer();
          const loadingIndicators = document.querySelectorAll('[role="progressbar"], [aria-busy="true"], [data-testid*="loading"]').length;
          const messageCount = document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]').length;
          return {
            path: location.pathname,
            composerFound: !!composer,
            composerVisible: composer ? (composer.offsetWidth > 0 && composer.offsetHeight > 0) : false,
            composerEnabled: composer ? !composer.hasAttribute('disabled') : false,
            messageCount,
            loadingIndicators,
            fastModeInstalled: !!window.__codexBridgeFastModeInstalled,
            fastModeMeta: window.__codexBridgeFastModeMeta || null,
          };
        })();
      `,
      true
    );

    const normalizedPath = String(lastState?.path || '').replace(/\/+$/, '');
    const normalizedExpectedPath = expectedPath.replace(/\/+$/, '');
    const pathOk = conversationId ? normalizedPath === normalizedExpectedPath : true;
    const loadingIdle = Number(lastState?.loadingIndicators || 0) === 0;
    const hasMessagesForConversation = !conversationId || Number(lastState?.messageCount || 0) > 0;
    const fastInstalled = !!lastState?.fastModeInstalled;
    const fastMeta = lastState?.fastModeMeta || null;
    const domAlreadyTrimmed = Number(lastState?.messageCount || 0) > 0 && Number(lastState?.messageCount || 0) <= expectedVisibleLimit;
    const trimWorkedByMeta =
      !!fastMeta &&
      fastMeta.lastConversationId === conversationId &&
      (
        Number(fastMeta.lastOriginalVisible || 0) <= expectedVisibleLimit ||
        Number(fastMeta.lastKeptVisible || 0) <= expectedVisibleLimit
      );
    const trimmedConversationReady = !conversationId || !BRIDGE_FAST_MODE || domAlreadyTrimmed || !fastInstalled || trimWorkedByMeta;
    
    if (
      pathOk &&
      lastState?.composerFound &&
      lastState?.composerVisible &&
      lastState?.composerEnabled &&
      loadingIdle &&
      hasMessagesForConversation &&
      trimmedConversationReady
    ) {
      stableCounter++;
      if (stableCounter >= 4 && (Date.now() - startTime) >= 500) {
        return lastState;
      }
    } else {
      stableCounter = 0;
    }
    await sleep(80);
  }

  throw new Error(`Bridge did not find composer on ${expectedPath}. Path: ${lastState?.path}`);
}

function normalizeBridgeModelTarget(requestedModel) {
  const raw = String(requestedModel || 'auto').trim().toLowerCase();
  if (!raw || raw === 'auto' || raw === 'default') {
    return { mode: 'auto', effort: null };
  }

  const map = {
    'gpt-4o': { mode: 'instant', effort: null },
    'gpt-5-3': { mode: 'instant', effort: null },
    instant: { mode: 'instant', effort: null },
    'o1-mini': { mode: 'thinking', effort: 'standard' },
    'o3-mini': { mode: 'thinking', effort: 'standard' },
    'o1': { mode: 'thinking', effort: 'extended' },
    'gpt-5-5-thinking': { mode: 'thinking', effort: null },
  };
  if (map[raw]) return map[raw];

  if (raw.includes('instant')) return { mode: 'instant', effort: null };
  if (raw.includes('thinking')) {
    if (raw.includes('extended')) return { mode: 'thinking', effort: 'extended' };
    if (raw.includes('standard')) return { mode: 'thinking', effort: 'standard' };
    return { mode: 'thinking', effort: null };
  }

  return { mode: 'auto', effort: null };
}

async function applyBridgeModelSelection(win, requestedModel) {
  const target = normalizeBridgeModelTarget(requestedModel);
  if (target.mode === 'auto') {
    return { ok: true, skipped: 'auto' };
  }

  const result = await win.webContents.executeJavaScript(
    `
      (async () => {
        const desiredModel = ${JSON.stringify(target.mode)};
        const desiredEffort = ${JSON.stringify(target.effort)};
        const norm = (v) => String(v || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const isVisible = (el) =>
          !!el &&
          !!el.isConnected &&
          (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
        const click = (el) => {
          if (!el) return false;
          try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
          try { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); } catch {}
          try { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch {}
          try { el.click(); } catch {}
          try { el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch {}
          return true;
        };
        const waitFor = async (fn, timeoutMs = 1800, intervalMs = 50) => {
          const end = Date.now() + timeoutMs;
          while (Date.now() < end) {
            const value = fn();
            if (value) return value;
            await sleep(intervalMs);
          }
          return null;
        };

        const allMenus = () =>
          Array.from(document.querySelectorAll('[role="menu"]')).filter(isVisible);
        const menuItems = () =>
          allMenus().flatMap((menu) =>
            Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')).filter(isVisible)
          );

        const getModelTrigger = () => {
          const buttons = Array.from(document.querySelectorAll('button.__composer-pill, button[aria-haspopup="menu"]'));
          return buttons.find((btn) => {
            if (!isVisible(btn)) return false;
            const cls = String(btn.className || '');
            if (cls.includes('__composer-pill')) return true;
            const text = norm(btn.textContent || '');
            return text.includes('instant') || text.includes('thinking') || text.includes('extended') || text.includes('standard');
          }) || null;
        };

        const openMenu = async () => {
          if (allMenus().length > 0) return true;
          const trigger = getModelTrigger();
          if (!trigger) return false;
          click(trigger);
          const opened = await waitFor(() => allMenus()[0] || null);
          return !!opened;
        };

        const closeMenu = () => {
          try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch {}
        };

        const pickModelInQuickMenu = async () => {
          const items = menuItems();
          if (items.length === 0) return false;
          const candidate = items.find((el) => {
            if (el.getAttribute('data-model-picker-thinking-effort-action') === 'true') return false;
            const tid = norm(el.getAttribute('data-testid') || '');
            const text = norm(el.textContent || '');
            if (desiredModel === 'instant') {
              return (
                tid.includes('model-switcher-gpt-5-3') ||
                tid.includes('model-switcher-instant') ||
                text.startsWith('instant')
              );
            }
            return (
              tid.includes('model-switcher-gpt-5-5-thinking') ||
              ((tid.includes('model-switcher') || text.includes('thinking')) && text.includes('thinking'))
            );
          }) || null;
          if (!candidate) return false;
          click(candidate);
          await sleep(100);
          return true;
        };

        const pickEffortInQuickMenu = async () => {
          if (!desiredEffort) return true;
          const actionBtn =
            menuItems().find((el) => norm(el.getAttribute('data-testid') || '').includes('thinking-effort')) ||
            document.querySelector('button[data-model-picker-thinking-effort-action="true"]');
          if (!actionBtn || !isVisible(actionBtn)) return false;
          click(actionBtn);
          await sleep(100);

          const effortItem = await waitFor(() => {
            const target = menuItems().find((el) => {
              const text = norm(el.textContent || '');
              if (!text.includes(desiredEffort)) return false;
              return text.includes('standard') || text.includes('extended');
            });
            return target || null;
          }, 1500, 50);

          if (!effortItem) return false;
          click(effortItem);
          await sleep(100);
          return true;
        };

        const pickConfigureInQuickMenu = async () => {
          const configure = menuItems().find((el) => {
            const tid = norm(el.getAttribute('data-testid') || '');
            const text = norm(el.textContent || '');
            return tid.includes('model-configure-modal') || text.includes('configure');
          });
          if (!configure) return false;
          click(configure);
          const dialog = await waitFor(() => document.querySelector('div[role="dialog"][data-state="open"]'));
          return !!dialog;
        };

        const pickModelInConfigureDialog = () => {
          const dialog = document.querySelector('div[role="dialog"][data-state="open"]');
          if (!dialog) return false;
          const radioButtons = Array.from(dialog.querySelectorAll('button[role="radio"]')).filter(isVisible);
          const target = radioButtons.find((el) => {
            const text = norm(el.textContent || '');
            return desiredModel === 'instant' ? text.includes('instant') : text.includes('thinking');
          });
          if (!target) return false;
          if (target.getAttribute('aria-checked') !== 'true') {
            click(target);
          }
          return true;
        };

        const pickEffortInConfigureDialog = async () => {
          if (!desiredEffort) return true;
          const dialog = document.querySelector('div[role="dialog"][data-state="open"]');
          if (!dialog) return false;
          const effortCombo = dialog.querySelector('button[aria-labelledby="thinking-effort-selection-label"]');
          if (!effortCombo || !isVisible(effortCombo)) return false;
          click(effortCombo);

          const option = await waitFor(() => {
            const menus = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]')).filter(isVisible);
            for (const menu of menus) {
              const nodes = Array.from(menu.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"]')).filter(isVisible);
              const match = nodes.find((el) => norm(el.textContent || '').includes(desiredEffort));
              if (match) return match;
            }
            return null;
          }, 2000, 50);
          if (!option) return false;
          click(option);
          await sleep(100);
          return true;
        };

        // First try quick menu path.
        const openedQuick = await openMenu();
        if (!openedQuick) return { ok: false, reason: 'Model menu trigger not found' };
        const modelPicked = await pickModelInQuickMenu();
        if (!modelPicked) return { ok: false, reason: 'Model entry not found in quick menu' };

        // For thinking effort changes, try the quick effort action first, then fallback to Configure dialog.
        if (desiredModel === 'thinking' && desiredEffort) {
          if (allMenus().length === 0) {
            await openMenu();
          }
          let effortPicked = await pickEffortInQuickMenu();
          if (!effortPicked) {
            if (allMenus().length === 0) {
              await openMenu();
            }
            const openedDialog = await pickConfigureInQuickMenu();
            if (!openedDialog) return { ok: false, reason: 'Configure dialog did not open for effort selection' };
            const modelSetInDialog = pickModelInConfigureDialog();
            const effortSetInDialog = await pickEffortInConfigureDialog();
            if (!modelSetInDialog || !effortSetInDialog) {
              return { ok: false, reason: 'Failed to set model/effort in configure dialog' };
            }
          }
        }

        closeMenu();
        return { ok: true };
      })();
    `,
    true
  );

  if (!result?.ok) {
    return { ok: false, reason: String(result?.reason || 'Bridge model selection failed') };
  }
  return { ok: true };
}

function buildBridgeAttachmentPayload(image, files) {
  const attachments = [];

  if (typeof image === 'string' && image.startsWith('data:')) {
    attachments.push({
      name: 'image.png',
      mimeType: 'image/png',
      dataUrl: image,
      sizeBytes: 0,
    });
  }

  if (Array.isArray(files)) {
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      const dataUrl = typeof file.dataUrl === 'string' ? file.dataUrl : '';
      if (!dataUrl.startsWith('data:')) continue;
      attachments.push({
        name: typeof file.name === 'string' && file.name.trim() ? file.name.trim() : 'attachment',
        mimeType: typeof file.mimeType === 'string' && file.mimeType.trim() ? file.mimeType.trim() : 'application/octet-stream',
        dataUrl,
        sizeBytes: Number(file.sizeBytes) || 0,
      });
    }
  }

  return attachments;
}

async function applyBridgeAttachments(win, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { ok: true, count: 0 };
  }

  const result = await win.webContents.executeJavaScript(
    `
      (async () => {
        const payload = ${JSON.stringify(attachments)};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const isVisible = (el) =>
          !!el &&
          !!el.isConnected &&
          (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);

        const getComposer = () =>
          document.querySelector('#prompt-textarea[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
          document.querySelector('textarea#prompt-textarea');

        const composer = getComposer();
        if (!composer) return { ok: false, reason: 'Composer not found for file paste' };
        if (typeof DataTransfer === 'undefined' || typeof File === 'undefined') {
          return { ok: false, reason: 'DataTransfer/File API unavailable in bridge page' };
        }

        const existingRemovers = document.querySelectorAll('button[aria-label^="Remove file"]').length;
        const dt = new DataTransfer();
        let added = 0;

        for (const item of payload) {
          const dataUrl = String(item?.dataUrl || '');
          if (!dataUrl.startsWith('data:')) continue;
          const commaIndex = dataUrl.indexOf(',');
          if (commaIndex <= 0) continue;
          const meta = dataUrl.slice(0, commaIndex);
          const base64 = dataUrl.slice(commaIndex + 1);
          const mimeMatch = /^data:([^;]+)/i.exec(meta);
          const mimeType = String(item?.mimeType || (mimeMatch ? mimeMatch[1] : 'application/octet-stream'));
          const name = String(item?.name || (mimeType.startsWith('image/') ? 'image.png' : 'attachment'));

          let bytes;
          try {
            const bin = atob(base64);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } catch {
            continue;
          }

          const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
          const file = new File([blob], name, { type: mimeType || 'application/octet-stream' });
          dt.items.add(file);
          added += 1;
        }

        if (added === 0) {
          return { ok: false, reason: 'No valid attachment payloads to paste' };
        }

        try { composer.focus(); } catch {}

        let pasteEvent;
        try {
          pasteEvent = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        } catch {
          pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
          try {
            Object.defineProperty(pasteEvent, 'clipboardData', {
              value: dt,
              writable: false,
              configurable: true,
            });
          } catch {}
        }

        // ProseMirror handlers often call preventDefault() on paste, which makes
        // dispatchEvent return false even when paste is successfully handled.
        composer.dispatchEvent(pasteEvent);

        const deadline = Date.now() + 12000;
        const expected = existingRemovers + added;
        while (Date.now() < deadline) {
          const removeButtons = document.querySelectorAll('button[aria-label^="Remove file"]').length;
          if (removeButtons >= expected) {
            return { ok: true, count: added };
          }
          await sleep(100);
        }

        // Fallback: if file chips are present even without remove-label buttons, treat as success.
        const chips = Array.from(document.querySelectorAll('[role="group"][aria-label], img[src*="/backend-api/estuary/content"]')).filter(isVisible);
        if (chips.length > 0) {
          return { ok: true, count: added, fallback: 'chip-detected' };
        }
        return { ok: false, reason: 'Attachment tiles did not appear after paste' };
      })();
    `,
    true
  );

  if (!result?.ok) {
    return { ok: false, reason: String(result?.reason || 'Bridge attachment paste failed') };
  }
  return { ok: true, count: Number(result?.count) || 0 };
}

async function setBridgeComposerText(win, prompt) {
  const text = String(prompt || '');
  const result = await win.webContents.executeJavaScript(
    `
      (() => {
        const prompt = ${JSON.stringify(text)};
        const getComposer = () =>
          document.querySelector('#prompt-textarea[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
          document.querySelector('textarea#prompt-textarea') ||
          document.querySelector('textarea[placeholder*="ask" i], textarea[placeholder*="message" i]');
        const composer = getComposer();
        if (!composer) return { ok: false, reason: 'Composer not found while setting text' };

        composer.focus();
        const tag = (composer.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA') {
          composer.value = prompt;
          composer.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true };
        }

        // Contenteditable (ProseMirror) path
        composer.textContent = '';
        if (prompt) {
          const lines = prompt.split(/\\r?\\n/);
          const fragment = document.createDocumentFragment();
          for (let i = 0; i < lines.length; i++) {
            const p = document.createElement('p');
            const line = lines[i];
            if (line.length === 0) {
              p.appendChild(document.createElement('br'));
            } else {
              p.textContent = line;
            }
            fragment.appendChild(p);
          }
          composer.appendChild(fragment);
        } else {
          const p = document.createElement('p');
          p.appendChild(document.createElement('br'));
          composer.appendChild(p);
        }

        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
        return { ok: true };
      })();
    `,
    true
  );

  if (!result?.ok) {
    return { ok: false, reason: String(result?.reason || 'Failed to set composer text') };
  }
  return { ok: true };
}

async function waitForBridgeSendReady(win) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const snapshot = await win.webContents.executeJavaScript(
      `
        (() => {
          const sendBtn =
            document.querySelector('#composer-submit-button') ||
            document.querySelector('button[data-testid="send-button"]') ||
            document.querySelector('button[aria-label="Send prompt"]') ||
            document.querySelector('button[aria-label*="Send"]');
          const hasUploadingIndicator =
            document.querySelectorAll('[role="progressbar"], [aria-busy="true"], [data-testid*="upload"], [data-testid*="loading"]').length > 0;
          if (!sendBtn) return { ready: false, reason: 'send_not_found' };
          const disabled = !!sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true';
          return { ready: !disabled && !hasUploadingIndicator, disabled, hasUploadingIndicator };
        })();
      `,
      true
    );
    if (snapshot?.ready) return { ok: true };
    await sleep(120);
  }
  return { ok: false, reason: 'Send button stayed disabled/busy after attachments/text update' };
}

async function prewarmBridgeConversation(conversationId) {
  const normalizedConversationId = conversationId || null;
  const warmToken = ++bridgeWarmRequestToken;
  publishBridgeComposerStatus({
    conversationId: normalizedConversationId,
    state: 'warming',
    ready: false,
    reason: '',
  });

  const targetUrl = normalizedConversationId
    ? `https://chatgpt.com/c/${encodeURIComponent(normalizedConversationId)}`
    : 'https://chatgpt.com/';

  try {
    const win = await navigateBridgeTo(targetUrl);
    if (shouldShowBridgeWindow()) {
      try {
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        if (!win.isFocused()) win.focus();
      } catch {}
    }
    await waitForBridgeComposer(win, normalizedConversationId);
    if (warmToken !== bridgeWarmRequestToken) {
      return { success: false, superseded: true };
    }
    publishBridgeComposerStatus({
      conversationId: normalizedConversationId,
      state: 'ready',
      ready: true,
      reason: '',
    });
    return { success: true };
  } catch (error) {
    if (warmToken !== bridgeWarmRequestToken) {
      return { success: false, superseded: true };
    }
    if (isAbortedNavigationError(error)) {
      return { success: false, superseded: true };
    }
    const reason = String(error?.message || error || 'Bridge warm failed');
    publishBridgeComposerStatus({
      conversationId: normalizedConversationId,
      state: 'error',
      ready: false,
      reason,
    });
    return { success: false, error: reason };
  }
}

async function monitorBridgeGeneration(conversationId) {
  if (!bridgeWindow || bridgeWindow.isDestroyed()) return;
  const win = bridgeWindow;
  const token = ++bridgeGenerationMonitorToken;
  const expectedPath = conversationId ? `/c/${conversationId}` : null;
  const deadline = Date.now() + 180000;
  let sawGenerating = false;
  let idlePasses = 0;

  while (
    token === bridgeGenerationMonitorToken &&
    Date.now() < deadline &&
    win &&
    !win.isDestroyed()
  ) {
    let snapshot = null;
    try {
      snapshot = await win.webContents.executeJavaScript(
        `
          (() => {
            const getComposer = () =>
              document.querySelector('#prompt-textarea[contenteditable="true"]') ||
              document.querySelector('textarea#prompt-textarea') ||
              document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
              document.querySelector('textarea[placeholder*="ask" i], textarea[placeholder*="message" i]');
            const sendBtn =
              document.querySelector('#composer-submit-button') ||
              document.querySelector('button[data-testid="send-button"]') ||
              document.querySelector('button[aria-label="Send prompt"]') ||
              document.querySelector('button[aria-label*="Send"]');
            const stopBtn =
              document.querySelector('button[data-testid="stop-button"]') ||
              document.querySelector('button[aria-label="Stop generating"]') ||
              document.querySelector('button[aria-label*="Stop"]');

            const composer = getComposer();
            const sendDisabled = !!sendBtn && (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true');
            const composerEnabled = composer ? !composer.hasAttribute('disabled') : false;

            return {
              path: location.pathname,
              composerFound: !!composer,
              composerEnabled,
              sendDisabled,
              stopVisible: !!stopBtn,
            };
          })();
        `,
        true
      );
    } catch {
      break;
    }

    const path = String(snapshot?.path || '').replace(/\/+$/, '');
    const pathOk = expectedPath ? path === expectedPath : true;
    if (!pathOk) {
      await sleep(200);
      continue;
    }

    const generating = !!snapshot?.stopVisible || (!!snapshot?.composerFound && !!snapshot?.sendDisabled);
    if (generating) {
      sawGenerating = true;
      idlePasses = 0;
      publishBridgeComposerStatus({
        conversationId: conversationId || null,
        state: 'thinking',
        ready: false,
        reason: '',
      });
    } else {
      idlePasses += 1;
      if (sawGenerating || idlePasses >= 4) {
        publishBridgeComposerStatus({
          conversationId: conversationId || null,
          state: 'ready',
          ready: true,
          reason: '',
        });
        return;
      }
    }

    await sleep(250);
  }

  if (token === bridgeGenerationMonitorToken) {
    publishBridgeComposerStatus({
      conversationId: conversationId || null,
      state: 'ready',
      ready: true,
      reason: '',
    });
  }
}

async function sendConversationViaUiAutomation({ conversationId, content, model, image, files }) {
  const targetUrl = conversationId
    ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`
    : 'https://chatgpt.com/';
  const win = await navigateBridgeTo(targetUrl);
  const prompt = String(content || '');

  if (shouldShowBridgeWindow()) {
    win.show();
    win.focus();
  }
  win.webContents.focus();

  await waitForBridgeComposer(win, conversationId || null);

  const modelSelection = await applyBridgeModelSelection(win, model);
  if (!modelSelection?.ok) {
    return { ok: false, status: 0, statusText: 'ui_model_select_failed', bodyText: String(modelSelection?.reason || 'Model selection failed') };
  }

  const attachments = buildBridgeAttachmentPayload(image, files);
  if (attachments.length > 0) {
    const attachResult = await applyBridgeAttachments(win, attachments);
    if (!attachResult?.ok) {
      return { ok: false, status: 0, statusText: 'ui_attach_failed', bodyText: String(attachResult?.reason || 'Attachment upload failed') };
    }
  }

  const setup = await win.webContents.executeJavaScript(
    `
      (() => {
        const getComposer = () =>
          document.querySelector('#prompt-textarea[contenteditable="true"]') ||
          document.querySelector('textarea#prompt-textarea') ||
          document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
          document.querySelector('textarea[placeholder*="ask" i], textarea[placeholder*="message" i]');

        const composer = getComposer();
        if (!composer) return { ok: false, reason: 'Composer not found' };

        const startUserCount = document.querySelectorAll('[data-message-author-role="user"]').length;
        const startAssistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;

        composer.focus();
        // Clear previous content
        if ((composer.tagName || '').toUpperCase() === 'TEXTAREA') {
          composer.value = '';
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          composer.innerHTML = '';
          composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }

        return {
          ok: true,
          startUserCount,
          startAssistantCount,
          url: location.href,
        };
      })();
    `,
    true
  );

  if (!setup?.ok) {
    return { ok: false, status: 0, statusText: 'ui_send_failed', bodyText: String(setup?.reason || 'Composer setup failed') };
  }

  // Insert text explicitly into the composer (more reliable than insertText for contenteditable editors).
  const textResult = await setBridgeComposerText(win, prompt);
  if (!textResult?.ok) {
    return { ok: false, status: 0, statusText: 'ui_text_set_failed', bodyText: String(textResult?.reason || 'Failed to set prompt text') };
  }

  const sendReady = await waitForBridgeSendReady(win);
  if (!sendReady?.ok) {
    return { ok: false, status: 0, statusText: 'ui_send_not_ready', bodyText: String(sendReady?.reason || 'Send control not ready') };
  }
  await sleep(80);

  const clickResult = await win.webContents.executeJavaScript(
    `
      (() => {
        const sendBtn =
          document.querySelector('#composer-submit-button') ||
          document.querySelector('button[data-testid="send-button"]') ||
          document.querySelector('button[aria-label="Send prompt"]') ||
          document.querySelector('button[aria-label*="Send"]');
        if (!sendBtn) return { ok: false, reason: 'Send button not found' };
        if (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') {
          return { ok: false, reason: 'Send button disabled' };
        }
        sendBtn.click();
        return { ok: true };
      })();
    `,
    true
  );

  if (!clickResult?.ok) {
    return { ok: false, status: 0, statusText: 'ui_send_failed', bodyText: String(clickResult?.reason || 'Could not click send') };
  }

  // Primary success detection is DOM-level submit acceptance.
  // Request observers are best-effort only and can miss due page script timing.
  const acceptDeadline = Date.now() + 7000;
  while (Date.now() < acceptDeadline) {
    const submitObserved = await win.webContents.executeJavaScript(
      `
        (() => {
          const getComposer = () =>
            document.querySelector('#prompt-textarea[contenteditable="true"]') ||
            document.querySelector('textarea#prompt-textarea') ||
            document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
            document.querySelector('textarea[placeholder*="ask" i], textarea[placeholder*="message" i]');
          const sendBtn =
            document.querySelector('#composer-submit-button') ||
            document.querySelector('button[data-testid="send-button"]') ||
            document.querySelector('button[aria-label="Send prompt"]') ||
            document.querySelector('button[aria-label*="Send"]');
          const stopBtn =
            document.querySelector('button[data-testid="stop-button"]') ||
            document.querySelector('button[aria-label="Stop generating"]') ||
            document.querySelector('button[aria-label*="Stop"]');

          const composer = getComposer();
          const composerEmpty = !composer
            ? false
            : ((composer.tagName || '').toUpperCase() === 'TEXTAREA'
              ? String(composer.value || '').trim().length === 0
              : String(composer.textContent || '').trim().length === 0);
          const sendDisabled = !!sendBtn && (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true');
          const userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
          const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;

          const userAdvanced = userCount > ${Number(setup.startUserCount || 0)};
          const assistantAdvanced = assistantCount > ${Number(setup.startAssistantCount || 0)};
          const accepted =
            !!stopBtn ||
            userAdvanced ||
            (composerEmpty && (sendDisabled || assistantAdvanced));

          return {
            accepted,
            stopVisible: !!stopBtn,
            userAdvanced,
            assistantAdvanced,
            composerEmpty,
            sendDisabled,
          };
        })();
      `,
      true
    );

    if (submitObserved?.accepted) {
      return {
        ok: true,
        status: 202,
        statusText: submitObserved.stopVisible ? 'ui_sent_generating' : 'ui_sent_accepted',
        bodyText: '',
      };
    }
    await sleep(120);
  }

  return { ok: false, status: 0, statusText: 'ui_send_failed', bodyText: 'Send click was not accepted by bridge UI' };
}

function parseBackendErrorDetail(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  const text = rawText.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail.trim();
    }
    if (parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Not JSON, fall back to plain text handling.
  }
  return text.slice(0, 500);
}

function looksImageLikeObject(value) {
  if (!value || typeof value !== 'object') return false;
  const fields = [
    value.content_type,
    value.mime_type,
    value.mimeType,
    value.media_type,
    value.file_type,
    value.type,
    value.name,
  ]
    .filter((entry) => typeof entry === 'string')
    .map((entry) => String(entry).toLowerCase());

  return fields.some((entry) => (
    entry.startsWith('image/') ||
    entry.includes('image_asset') ||
    entry.includes('image-file') ||
    /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i.test(entry)
  ));
}

function collectImageFileIds(value, imageContext = false, depth = 0, out = new Set()) {
  if (!value || depth > 10) return out;

  if (typeof value === 'string') {
    if (imageContext) {
      const fileId = extractFileId(value);
      if (fileId) out.add(fileId);
    }
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectImageFileIds(item, imageContext, depth + 1, out);
    return out;
  }

  if (typeof value !== 'object') return out;

  const localImageContext = imageContext || looksImageLikeObject(value);
  for (const [key, entry] of Object.entries(value)) {
    const keyLower = String(key || '').toLowerCase();
    const keyImageContext = localImageContext || keyLower.includes('image') || keyLower.includes('thumbnail');

    if (
      keyLower === 'asset_pointer' ||
      keyLower === 'assetpointer' ||
      keyLower === 'file_id' ||
      keyLower === 'fileid' ||
      keyLower === 'id' ||
      keyLower === 'download_url' ||
      keyLower === 'downloadurl'
    ) {
      const fileId = extractFileId(entry);
      if (fileId && (keyImageContext || keyLower === 'asset_pointer' || keyLower === 'assetpointer')) {
        out.add(fileId);
      }
    }

    collectImageFileIds(entry, keyImageContext, depth + 1, out);
  }

  return out;
}

function appendChatImageMarkdown(lines, fileId, conversationId, seenImageFileIds) {
  if (!fileId || seenImageFileIds.has(fileId)) return;
  seenImageFileIds.add(fileId);
  lines.push(`\n![Chat Image](chatgpt-image://${fileId}?conversation_id=${encodeURIComponent(conversationId)})\n`);
}

function renderMessageContent(message, conversationId) {
  const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
  const lines = [];
  const seenImageFileIds = new Set();

  for (const p of parts) {
    if (typeof p === 'string') {
      lines.push(p);
      continue;
    }
    if (!p || typeof p !== 'object') continue;

    if (p.content_type === 'image_asset_pointer' || p.content_type === 'image' || p.asset_pointer) {
      const rawPointer = p.asset_pointer || p.file_id || '';
      const fileId = extractFileId(rawPointer);
      if (fileId) {
        appendChatImageMarkdown(lines, fileId, conversationId, seenImageFileIds);
      }
      continue;
    }

    if (typeof p.text === 'string' && p.text.trim()) {
      lines.push(p.text);
      continue;
    }
    if (typeof p.markdown === 'string' && p.markdown.trim()) {
      lines.push(p.markdown);
      continue;
    }
    if (typeof p.content === 'string' && p.content.trim()) {
      lines.push(p.content);
    }
  }

  for (const fileId of collectImageFileIds(message)) {
    appendChatImageMarkdown(lines, fileId, conversationId, seenImageFileIds);
  }

  return lines.join('\n');
}

const METADATA_KEY_WHITELIST = new Set([
  // Citation/source resolution
  'content_references',
  'citations',
  'search_result_groups',
  'search_queries',
  'image_results',
  'search_model_queries',
  'safe_urls',
  // Thinking / hidden-UI state
  'reasoning_status',
  'reasoning_start_time',
  'reasoning_end_time',
  'reasoning_title',
  'is_thinking_preamble_message',
  'skip_reasoning_title',
  'finished_duration_sec',
  'is_visually_hidden_from_conversation',
  // Tool/runtime result details
  'aggregate_result',
  'classifier_response',
  // Thread/completion shape
  'parent_id',
  'message_type',
  'finish_details',
  'is_complete',
]);

const CONTENT_REFERENCE_KEY_WHITELIST = new Set([
  'matched_text',
  'safe_urls',
  'refs',
  'alt',
  'start_idx',
  'end_idx',
  'type',
  'prefix',
  'render_as',
  'prompt_text',
  'sources',
  'items',
]);

function sanitizeContentReferences(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const ref = {};
    for (const key of CONTENT_REFERENCE_KEY_WHITELIST) {
      if (!(key in item)) continue;
      const entry = item[key];
      if (key === 'safe_urls' || key === 'refs') {
        if (Array.isArray(entry)) {
          const cleaned = entry.filter((v) => typeof v === 'string').map((v) => String(v).trim()).filter(Boolean);
          if (cleaned.length > 0) ref[key] = cleaned;
        }
        continue;
      }
      if (entry !== undefined && entry !== null && entry !== '') {
        ref[key] = entry;
      }
    }
    if (Object.keys(ref).length > 0) output.push(ref);
  }
  return output;
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const output = {};

  for (const key of METADATA_KEY_WHITELIST) {
    if (!(key in metadata)) continue;
    const value = metadata[key];

    if (key === 'content_references') {
      const refs = sanitizeContentReferences(value);
      if (refs.length > 0) output[key] = refs;
      continue;
    }

    if (key === 'citations' || key === 'search_queries' || key === 'image_results' || key === 'safe_urls') {
      if (Array.isArray(value)) output[key] = value;
      continue;
    }

    if (value !== undefined && value !== null && value !== '') {
      output[key] = value;
    }
  }

  if (Object.keys(output).length === 0) return null;
  try {
    return JSON.stringify(output);
  } catch {
    return null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  attachRendererDiagnostics('main', mainWindow.webContents);

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

    const fileId = extractFileId(requestPath) || requestPath;
    if (!fileId) {
      return new Response('Missing image id', { status: 400 });
    }

    try {
      // Use the internal fetch with full session/auth
      const parsed = new URL(request.url);
      const conversationId = parsed.searchParams.get('conversation_id');
      const response = await fetchImageResponse(fileId, conversationId || undefined);
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
  const normalizedUA = ensureAppUserAgent();
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
  const conv = dbInstance.getConversation(conversationId);

  if (!conv || !conv.current_node_id) {
    return dbInstance.getMessages(conversationId);
  }

  const path = dbInstance.getLinearPath(conv.current_node_id);
  return path;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForWebContentsStable(win, timeoutMs = 2000) {
  if (!win || win.isDestroyed() || !win.webContents) return false;
  if (!win.webContents.isLoading()) return true;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.webContents.removeListener('did-finish-load', onLoad);
      win.webContents.removeListener('dom-ready', onLoad);
      resolve(value);
    };
    const onLoad = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    win.webContents.once('did-finish-load', onLoad);
    win.webContents.once('dom-ready', onLoad);
  });
}

async function getAiModeExecutionSnapshot(win) {
  if (!win || win.isDestroyed() || !win.webContents) return { error: 'bridge window unavailable' };
  const code = `
    (() => {
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
      };
      const countVisible = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible).length;
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        scopedTurns: countVisible('[data-scope-id="turn"], .CKgc1d, [data-xid="aim-mars-turn-root"]'),
        users: countVisible('[data-xid="aim-mars-user-turn"], .VndcI.veK2kb, .VndcI, .user-message, [data-test-id="user-message"]'),
        assistants: countVisible('[data-xid="VpUvz"], .model-response-text, .markdown, .message-content, .mZJni'),
        historyItems: countVisible(${JSON.stringify(AI_MODE_HISTORY_ITEM_SELECTOR)}),
        historyDialog: countVisible(${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)}),
        scrollY: window.scrollY,
        scrollHeight: document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight || 0,
        bodyTextPreview: normalize(document.body?.innerText || '').slice(0, 500),
      };
    })();
  `;
  try {
    if (typeof win.webContents.executeJavaScriptInIsolatedWorld === 'function') {
      return await win.webContents.executeJavaScriptInIsolatedWorld(987, [{ code }], true);
    }
    return await win.webContents.executeJavaScript(code, true);
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

async function executeAiModeScript(win, script, { retries = 2, waitTimeoutMs = 2000, label = 'ai-mode-script' } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await win.webContents.executeJavaScript(script, true);
    } catch (error) {
      lastError = error;
      if (typeof win.webContents.executeJavaScriptInIsolatedWorld === 'function') {
        try {
          return await win.webContents.executeJavaScriptInIsolatedWorld(986, [{ code: script }], true);
        } catch (isolatedError) {
          lastError = isolatedError;
        }
      }
      const message = String(error?.message || error || '');
      const transient = /Script failed to execute|execution context was destroyed|Cannot find context|Object has been destroyed|Attempted to use a destroyed webContents|context was destroyed/i.test(message);
      if (!transient || attempt === retries) break;
      await waitForWebContentsStable(win, waitTimeoutMs);
      await sleep(200 * (attempt + 1));
    }
  }
  console.warn(`AI Mode script failed (${label}):`, {
    error: String(lastError?.message || lastError),
    snapshot: await getAiModeExecutionSnapshot(win),
  });
  throw lastError;
}

function withJitter(ms, jitterRatio = 0.25) {
  const jitter = ms * jitterRatio;
  const delta = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(ms + delta));
}

function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader) return null;
  const numeric = Number(retryAfterHeader);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.round(numeric * 1000);
  }
  const dateMs = Date.parse(retryAfterHeader);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

function normalizeWorkspaceMode(rawMode) {
  return String(rawMode || '').toLowerCase() === 'aimode' ? 'aimode' : 'chatgpt';
}

function getDatabaseForMode(rawMode) {
  const mode = normalizeWorkspaceMode(rawMode);
  return mode === 'aimode' ? aiDb : db;
}

function deriveAiConversationId(ref) {
  const stableKey = String(ref?.threadId || '').trim()
    || `title:${String(ref?.title || '').trim().toLowerCase()}`;
  return `aimode-live-${buildDeterministicId(stableKey)}`;
}

function cleanupAiModeShadowConversations() {
  const convs = aiDb.getConversations();
  const byTitle = new Map();
  for (const conv of convs) {
    const t = normalizeAiModeTitle(conv.title || '').toLowerCase();
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(conv);
  }

  const messageCountStmt = aiDb.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?');
  const toDelete = [];
  for (const [, group] of byTitle) {
    if (!Array.isArray(group) || group.length < 2) continue;
    const enriched = group.map((conv) => ({
      conv,
      messageCount: Number(messageCountStmt.get(conv.id)?.n || 0),
    }));
    const hasCanonicalWithMessages = enriched.some((row) => !String(row.conv.id).startsWith('aimode-live-') && row.messageCount > 0);
    if (!hasCanonicalWithMessages) continue;
    for (const row of enriched) {
      if (String(row.conv.id).startsWith('aimode-live-') && row.messageCount === 0) {
        toDelete.push(row.conv.id);
      }
    }
  }

  if (toDelete.length === 0) return 0;
  aiDb.db.transaction(() => {
    for (const id of toDelete) {
      aiDb.deleteConversation(id);
    }
  })();
  return toDelete.length;
}

async function resolveAiModeConversationRef(conversationId) {
  let ref = aiModeConversationRefs.get(conversationId) || null;
  if (ref) return ref;

  const currentConv = aiDb.getConversation(conversationId);
  const currentTitleNorm = normalizeAiModeTitle(currentConv?.title || '').toLowerCase();
  const refs = await fetchAiModeConversationIndex(2000);
  for (const row of refs) {
    const rowId = deriveAiConversationId(row);
    aiModeConversationRefs.set(rowId, { ...row });
    const rowThreadId = String(row.threadId || '').trim();
    if (rowThreadId && aiModeThreadIdToConversationId.get(rowThreadId) === conversationId) {
      ref = row;
    } else if (rowId === conversationId) {
      ref = row;
    } else if (!ref && currentTitleNorm && normalizeAiModeTitle(row.title || '').toLowerCase() === currentTitleNorm) {
      ref = row;
    }
    if (ref && rowThreadId) {
      aiModeThreadIdToConversationId.set(rowThreadId, conversationId);
    }
  }
  return ref;
}

async function ensureAiModeBridgeWindow() {
  const win = await ensureBridgeWindow();
  const waitForAiModeInteractive = async (timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await executeAiModeScript(
        win,
        `
          (() => {
            const visible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
              return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
            };
            const historyBtn = document.querySelector(${JSON.stringify(AI_MODE_HISTORY_BUTTON_SELECTOR)});
            const historyDialog = document.querySelector(${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)});
            const historyItem = document.querySelector(${JSON.stringify(AI_MODE_HISTORY_ITEM_SELECTOR)});
            const input = document.querySelector('textarea[aria-label="Ask anything"], [contenteditable="true"]');
            return {
              href: location.href,
              readyState: document.readyState,
              historyVisible: visible(historyBtn),
              historyDialogVisible: visible(historyDialog),
              historyItemVisible: visible(historyItem),
              inputVisible: visible(input),
            };
          })();
        `,
	        { retries: 2, waitTimeoutMs: 3000, label: 'wait-ai-mode-interactive' }
      );
      const url = String(state?.href || '');
      const ready = String(state?.readyState || '') === 'complete';
      if (url.includes('google.com/search') && ready && (state?.historyVisible || state?.historyDialogVisible || state?.historyItemVisible || state?.inputVisible)) {
        return true;
      }
      await sleep(200);
    }
    return false;
  };

  const currentUrl = String(win.webContents.getURL() || '');
  if (!currentUrl.includes('google.com/search')) {
    await navigateBridgeTo(AI_MODE_URL);
  }
  if (shouldShowBridgeWindow()) {
    try {
      win.setSkipTaskbar(false);
      win.show();
      win.focus();
    } catch {}
  }

  const nudgeFocusIfNeeded = async () => {
    if (!shouldShowBridgeWindow()) return;
    try {
      if (!win.isVisible()) win.show();
      if (!win.isFocused()) win.focus();
      await executeAiModeScript(
        win,
        `
          (() => {
            try { window.focus(); } catch {}
            const active = document.activeElement;
            if (active && typeof active.blur === 'function') {
              try { active.blur(); } catch {}
            }
            return true;
          })();
        `,
	        { retries: 1, waitTimeoutMs: 1500, label: 'nudge-ai-mode-focus' }
      );
    } catch {}
  };

  let ready = await waitForAiModeInteractive(30000);
  if (!ready) {
    await nudgeFocusIfNeeded();
    ready = await waitForAiModeInteractive(8000);
  }
  if (!ready) {
    try {
      await new Promise((resolve) => {
        const done = () => resolve();
        const timer = setTimeout(done, 12000);
        win.webContents.once('did-finish-load', () => {
          clearTimeout(timer);
          done();
        });
        win.webContents.reloadIgnoringCache();
      });
    } catch {}
    await navigateBridgeTo(AI_MODE_URL);
    ready = await waitForAiModeInteractive(25000);
  }

  if (!ready) {
    throw new Error('AI Mode bridge is not interactive yet');
  }
  return win;
}

async function fetchAiModeConversationIndex(limit = 100) {
  const win = await ensureAiModeBridgeWindow();
  const rows = await executeAiModeScript(
    win,
    `
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
          return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        };
        const historySelector = ${JSON.stringify(AI_MODE_HISTORY_BUTTON_SELECTOR)};
        const historyDialogSelector = ${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)};
        const itemSelector = ${JSON.stringify(AI_MODE_HISTORY_ITEM_SELECTOR)};
        const maxItems = ${JSON.stringify(Math.max(1, Number(limit) || 100))};
        const clickElement = (el) => {
          if (!el) return false;
          const init = { bubbles: true, cancelable: true, view: window };
          try { el.dispatchEvent(new PointerEvent('pointerdown', init)); } catch {}
          try { el.dispatchEvent(new MouseEvent('mousedown', init)); } catch {}
          try { el.dispatchEvent(new PointerEvent('pointerup', init)); } catch {}
          try { el.dispatchEvent(new MouseEvent('mouseup', init)); } catch {}
          try { el.click(); } catch {}
          return true;
        };
        const historyItems = () => Array.from(document.querySelectorAll(itemSelector)).filter(visible);
        const historyReady = () => {
          if (historyItems().length > 0) return true;
          const dialog = document.querySelector(historyDialogSelector);
          const empty = Array.from(document.querySelectorAll('.gNJflc, [role="heading"]'))
            .some((el) => visible(el) && normalize(el.textContent || '') === 'No AI Mode history');
          return visible(dialog) && empty;
        };

        const historyButton = document.querySelector(historySelector);
        if (!historyReady() && historyButton && visible(historyButton)) {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const dialog = document.querySelector(historyDialogSelector);
            if (!visible(dialog)) {
              clickElement(historyButton);
              await sleep(300);
            } else {
              await sleep(250);
            }
            if (historyReady()) break;
          }
        }
        for (let attempt = 0; attempt < 50 && !historyReady(); attempt += 1) {
          await sleep(120);
        }

        for (let i = 0; i < 80; i += 1) {
          const showMore = Array.from(document.querySelectorAll('button')).find((b) => {
            const label = normalize(b.getAttribute('aria-label') || b.textContent || '');
            if (!label) return false;
            return (
              label.includes('See more AI Mode') ||
              label.includes('See more') ||
              label.includes('Show more') ||
              b.classList.contains('EBNOJf')
            );
          });
          if (!showMore || !visible(showMore)) break;
          showMore.scrollIntoView({ block: 'center' });
          await sleep(140);
          clickElement(showMore);
          await sleep(700);
          const count = historyItems().length;
          if (count >= maxItems) break;
        }

        const list = [];
        const seen = new Set();
        const items = historyItems();
        let visualIndex = 0;
        for (const el of items) {
          const threadId = normalize(el.getAttribute('data-thread-id') || '');
          const title = normalize(el.innerText || el.getAttribute('aria-label') || '');
          if (!title) continue;
          const key = threadId || ('title:' + title.toLowerCase());
          if (seen.has(key)) continue;
          seen.add(key);
          list.push({
            threadId,
            title,
            visualIndex,
          });
          visualIndex += 1;
          if (list.length >= maxItems) break;
        }
        return list;
      })();
    `,
	    { retries: 2, waitTimeoutMs: 3000, label: 'fetch-ai-mode-index' }
  );
  return Array.isArray(rows) ? rows : [];
}

async function openAiModeConversation(ref) {
  if (!ref) return false;
  const win = await ensureAiModeBridgeWindow();
  if (shouldShowBridgeWindow()) {
    try {
      if (!win.isVisible()) win.show();
      if (!win.isFocused()) win.focus();
    } catch {}
  }
  try {
      await executeAiModeScript(
        win,
        `
          (() => {
            try { window.focus(); } catch {}
            return true;
          })();
        `,
	        { retries: 1, waitTimeoutMs: 1500, label: 'open-ai-mode-focus' }
      );
  } catch {}
  await sleep(200);
  const attemptOpen = async () => executeAiModeScript(
    win,
    `
      (() => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalizeTitle = (v) => String(v || '')
          .replace(/\\s+/g, ' ')
          .replace(/^Searched for\\s+/i, '')
          .trim();
        const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
          return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        };
        const threadId = ${JSON.stringify(String(ref.threadId || ''))};
        const targetTitle = normalizeTitle(${JSON.stringify(String(ref.title || ''))});
        const index = Number(${JSON.stringify(Number(ref.visualIndex))});
        const itemSelector = ${JSON.stringify(AI_MODE_HISTORY_ITEM_SELECTOR)};
        const historySelector = ${JSON.stringify(AI_MODE_HISTORY_BUTTON_SELECTOR)};
        const historyDialogSelector = ${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)};
        const clickElement = (el) => {
          if (!el) return false;
          const init = { bubbles: true, cancelable: true, view: window };
          try { el.dispatchEvent(new PointerEvent('pointerdown', init)); } catch {}
          try { el.dispatchEvent(new MouseEvent('mousedown', init)); } catch {}
          try { el.dispatchEvent(new PointerEvent('pointerup', init)); } catch {}
          try { el.dispatchEvent(new MouseEvent('mouseup', init)); } catch {}
          try { el.click(); } catch {}
          return true;
        };

        const clickableItems = () => {
          const raw = Array.from(document.querySelectorAll(itemSelector)).filter(visible);
          return raw.filter((el) => {
            const tag = String(el.tagName || '').toUpperCase();
            return tag === 'BUTTON' || el.getAttribute('role') === 'button' || typeof el.click === 'function';
          });
        };
        const noHistoryVisible = () => Array.from(document.querySelectorAll('.gNJflc, [role="heading"]'))
          .some((el) => visible(el) && normalize(el.textContent || '') === 'No AI Mode history');
        const drawerVisible = () => visible(document.querySelector(historyDialogSelector));

        const ensureHistoryOpen = async () => {
          if (clickableItems().length > 0) return true;
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const historyButton = document.querySelector(historySelector);
            if (historyButton && visible(historyButton) && !drawerVisible()) {
              try { historyButton.scrollIntoView({ block: 'center' }); } catch {}
              clickElement(historyButton);
              await sleep(300);
            }
            if (clickableItems().length > 0) return true;
            if (drawerVisible() && noHistoryVisible()) return false;
            await sleep(200);
          }
          return clickableItems().length > 0;
        };

        const pickTarget = () => {
          const items = clickableItems();
          let target = null;
          if (threadId) {
            target = items.find((el) => normalize(el.getAttribute('data-thread-id') || '') === threadId) || null;
          }
          if (!target && targetTitle) {
            target = items.find((el) => {
              const title = normalizeTitle(el.innerText || el.getAttribute('aria-label') || '');
              if (!title) return false;
              return title === targetTitle || title.includes(targetTitle) || targetTitle.includes(title);
            }) || null;
          }
          if (!target && Number.isInteger(index) && index >= 0 && index < items.length) {
            target = items[index];
          }
          return target || null;
        };

        const tryExpand = async () => {
          const showMore = Array.from(document.querySelectorAll('button')).find((b) => {
            const label = normalize(b.getAttribute('aria-label') || b.textContent || '');
            if (!label) return false;
            return (
              label.includes('See more AI Mode') ||
              label.includes('See more') ||
              label.includes('Show more') ||
              b.classList.contains('EBNOJf')
            );
          });
          if (!showMore || !visible(showMore)) return false;
          showMore.scrollIntoView({ block: 'center' });
          await sleep(120);
          clickElement(showMore);
          await sleep(420);
          return true;
        };

        return (async () => {
          const historyReady = await ensureHistoryOpen();
          if (!historyReady) return false;
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const target = pickTarget();
            if (target) {
              target.scrollIntoView({ block: 'center' });
              await sleep(80);
              clickElement(target);
              return true;
            }
            const expanded = await tryExpand();
            if (!expanded) break;
          }
          return false;
        })();
      })();
    `,
	    { retries: 2, waitTimeoutMs: 3000, label: 'open-ai-mode-history-item' }
  );

  let opened = await attemptOpen();
  if (!opened) {
    try {
      await new Promise((resolve) => {
        const done = () => resolve();
        const timer = setTimeout(done, 12000);
        win.webContents.once('did-finish-load', () => {
          clearTimeout(timer);
          done();
        });
        win.webContents.reloadIgnoringCache();
      });
    } catch {}
    await ensureAiModeBridgeWindow();
    opened = await attemptOpen();
  }
  if (!opened) return false;

  try {
    await executeAiModeScript(
      win,
      `
        (async () => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const visible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
            return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
          };
          const dialogSelector = ${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)};
          const closeDrawer = () => {
            const dialog = document.querySelector(dialogSelector);
            if (!visible(dialog)) return true;
            const back = dialog.querySelector('button[aria-label="Back"], [role="button"][aria-label="Back"]');
            if (back && visible(back)) {
              try { back.click(); } catch {}
              return false;
            }
            try {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
            } catch {}
            return false;
          };
          for (let i = 0; i < 12; i += 1) {
            if (closeDrawer()) return true;
            await sleep(180);
          }
          return !visible(document.querySelector(dialogSelector));
        })();
      `,
	      { retries: 1, waitTimeoutMs: 1500, label: 'close-ai-mode-history-drawer' }
    );
  } catch {}

  const getAiModeBridgeSnapshot = async () => {
    try {
      return await executeAiModeScript(
        win,
        `
          (() => {
            const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
            const visible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
              return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
            };
            const countVisible = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible).length;
            return {
              href: location.href,
              title: document.title,
              readyState: document.readyState,
              scopedTurns: countVisible('[data-scope-id="turn"], .CKgc1d, [data-xid="aim-mars-turn-root"]'),
              users: countVisible('[data-xid="aim-mars-user-turn"], .VndcI.veK2kb, .VndcI, .user-message, [data-test-id="user-message"]'),
              assistants: countVisible('[data-xid="VpUvz"], .model-response-text, .markdown, .message-content, .mZJni'),
              historyDialog: countVisible(${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)}),
              scrollY: window.scrollY,
              scrollHeight: document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight || 0,
              bodyTextPreview: normalize(document.body?.innerText || '').slice(0, 800),
            };
          })();
        `,
	        { retries: 1, waitTimeoutMs: 1500, label: 'ai-mode-open-snapshot' }
      );
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  };

  const settleDeadline = Date.now() + 15000;
  while (Date.now() < settleDeadline) {
    const ready = await executeAiModeScript(
      win,
      `
        (() => {
          const visible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
            return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
          };
	          const historyDialog = document.querySelector(${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)});
	          const turns = Array.from(document.querySelectorAll('[data-xid="aim-mars-turn-root"], [data-scope-id="turn"], .CKgc1d')).filter(visible);
	          const users = Array.from(document.querySelectorAll('[data-xid="aim-mars-user-turn"], .VndcI.veK2kb, .VndcI, [role="heading"]')).filter((el) => {
	            if (!visible(el)) return false;
	            if (historyDialog && historyDialog.contains(el)) return false;
	            const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
	            return !!text && text !== 'AI Mode history' && text !== 'Recent' && text !== 'No AI Mode history';
	          });
	          const ai = Array.from(document.querySelectorAll('[data-xid="VpUvz"], .model-response-text, .markdown, .message-content, .mZJni')).filter((el) => {
	            if (!visible(el)) return false;
	            if (historyDialog && historyDialog.contains(el)) return false;
	            return !!String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
	          });
	          return turns.length > 0 || users.length > 0 || ai.length > 0;
	        })();
      `,
	      { retries: 2, waitTimeoutMs: 3000, label: 'wait-ai-mode-readable-content' }
    );
    if (ready) return true;
    await sleep(160);
  }
  console.warn('AI Mode opened but readable chat content was not detected:', await getAiModeBridgeSnapshot());
  return false;
}

async function scrapeAiModeMessagesFromBridge() {
  const win = await ensureAiModeBridgeWindow();
  const turnsPayload = await executeAiModeScript(
    win,
    `
      (async () => {
        try {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const normalize = (v) => String(v || '')
            .replace(/\\u00a0/g, ' ')
            .replace(/\\r/g, '')
            .replace(/[ \\t]+\\n/g, '\\n')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
            return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
          };

        const turnSelector = '[data-xid="aim-mars-turn-root"]';
        const scopedTurnSelector = '[data-scope-id="turn"], .CKgc1d, [data-xid="aim-mars-turn-root"]';
        const userSelector = '[data-xid="aim-mars-user-turn"], .VndcI.veK2kb, .VndcI, .user-message, [data-test-id="user-message"]';
        const aiSelector = '[data-xid="VpUvz"], .model-response-text, .markdown, .message-content, .Y3BBE, .mZJni';
        const aiContainerSelector = '[data-xid="VpUvz"], .model-response-text, .markdown, .message-content, response-container, model-response';
        const ignoredUserPhrases = new Set([
          'Delete all searches?',
          'Delete this search?',
          'AI Mode history',
          'No AI Mode history',
          'Recent',
          'My Ad Centre',
          'Sign in',
          'Settings',
          'Privacy',
          'Terms',
        ]);

        const getScrollableAncestor = (node) => {
          let current = node ? node.parentElement : null;
          while (current && current !== document.body) {
            const style = window.getComputedStyle(current);
            const overflowY = String(style?.overflowY || '').toLowerCase();
            if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight + 20) {
              return current;
            }
            current = current.parentElement;
          }
          return document.scrollingElement || document.documentElement;
        };
        const describeScroller = (node) => {
          if (!node) return 'none';
          if (node === document.body) return 'body';
          if (node === document.documentElement) return 'documentElement';
          if (node === document.scrollingElement) return 'scrollingElement';
          const tag = String(node.tagName || '').toLowerCase();
          const cls = String(node.className || '').replace(/\\s+/g, '.').slice(0, 80);
          const xid = node.getAttribute && node.getAttribute('data-xid');
          return [tag, cls ? '.' + cls : '', xid ? '[data-xid="' + xid + '"]' : ''].join('');
        };

        const getNodeText = (node) => normalize(node?.innerText || node?.textContent || '');
        const results = [];

        const collapseConsecutiveDuplicates = (items) => {
          const out = [];
          let last = null;
          for (const item of items) {
            const fp = item.role + '|' + item.content;
            if (fp === last) continue;
            out.push(item);
            last = fp;
          }
          return out;
        };

        const cleanAssistantText = (raw) => {
          return normalize(String(raw || '')
            .replace(/AI responses may include mistakes\\.\\s*Learn more/gi, '')
            .replace(/Good response\\s*Bad response\\s*More/gi, '')
            .replace(/Copy\\s*Share\\s*Good response\\s*Bad response\\s*More/gi, '')
          );
        };

        const tableToMarkdown = (tableEl) => {
          if (!tableEl) return '';
          const rows = Array.from(tableEl.querySelectorAll('tr')).map((tr) => {
            const cells = Array.from(tr.querySelectorAll('th, td')).map((cell) => {
              return normalize(cell.innerText || cell.textContent || '').replace(/\|/g, '\\|');
            });
            return cells;
          }).filter((cells) => cells.length > 0 && cells.some((v) => !!v));
          if (rows.length === 0) return '';
          const colCount = rows.reduce((max, cells) => Math.max(max, cells.length), 0);
          const normalizeRow = (cells) => {
            const out = cells.slice(0, colCount);
            while (out.length < colCount) out.push('');
            return out;
          };
          const header = normalizeRow(rows[0]);
          const body = rows.slice(1).map(normalizeRow);
          const divider = Array(colCount).fill('---');
          const lines = [];
          lines.push('| ' + header.join(' | ') + ' |');
          lines.push('| ' + divider.join(' | ') + ' |');
          for (const row of body) lines.push('| ' + row.join(' | ') + ' |');
          return lines.join('\\n');
        };

        const extractAssistantContent = (assistantNode) => {
          if (!assistantNode) return '';
          const hasTable = !!assistantNode.querySelector('table');
          if (!hasTable) return cleanAssistantText(getNodeText(assistantNode));

          const clone = assistantNode.cloneNode(true);
          const noiseSelectors = [
            'button',
            '[role="button"]',
            '.txxDge',
            '.YHsVn',
            '.RkJvxe',
            '.UrecDd',
            '.YOTKvb',
            '.HvurC',
            '.rBl3me',
            'script',
            'style',
            'svg',
          ];
          clone.querySelectorAll(noiseSelectors.join(',')).forEach((el) => el.remove());

          const tables = Array.from(clone.querySelectorAll('table'));
          for (const table of tables) {
            const md = tableToMarkdown(table);
            const replacement = document.createTextNode(md ? ('\\n\\n' + md + '\\n\\n') : '\\n');
            table.replaceWith(replacement);
          }

          const mount = document.createElement('div');
          mount.style.position = 'fixed';
          mount.style.left = '-99999px';
          mount.style.top = '0';
          mount.style.opacity = '0';
          mount.style.pointerEvents = 'none';
          mount.appendChild(clone);
          document.body.appendChild(mount);
          const extracted = cleanAssistantText(getNodeText(clone));
          mount.remove();
          return extracted;
        };

        const deriveTurnDomKey = (turn, fallbackSeq) => {
          if (!turn) return 'turn-fallback-' + String(fallbackSeq);
          const keys = [
            turn.getAttribute('data-suuid'),
            turn.getAttribute('data-turn-id'),
            turn.getAttribute('data-message-id'),
            turn.getAttribute('data-thread-id'),
            turn.getAttribute('jsuid'),
            turn.id,
          ].map((v) => normalize(v)).filter(Boolean);
          if (keys.length > 0) return keys[0];
          return 'turn-fallback-' + String(fallbackSeq);
        };

        const clickExpandableButtons = () => {
          const buttons = Array.from(document.querySelectorAll('button')).filter((btn) => isVisible(btn));
          let clicks = 0;
          for (const btn of buttons) {
            const label = normalize((btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase());
            if (!label) continue;
            if (!/(show more|see more|read more|more)/i.test(label)) continue;
            if (label.includes('ai mode history')) continue;
            if (label.includes('delete this search') || label.includes('delete all searches')) continue;
            try {
              btn.click();
              clicks += 1;
            } catch {}
          }
          return clicks;
        };

        const collectFromTurnRoots = (sampleTop) => {
          const pairs = [];
          const pairKeys = new Set();
          const turnRoots = Array.from(document.querySelectorAll(turnSelector))
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

          for (const turn of turnRoots) {
            const userCandidates = Array.from(turn.querySelectorAll(userSelector));
            const aiCandidates = Array.from(turn.querySelectorAll(aiSelector));

            const userTextRaw = userCandidates
              .map((el) => getNodeText(el))
              .find(Boolean) || '';
            const aiTextRaw = aiCandidates
              .map((el) => getNodeText(el))
              .filter(Boolean)
              .pop() || '';

            if (!userTextRaw && !aiTextRaw) continue;
            const key = userTextRaw + '\\n---\\n' + aiTextRaw;
            if (pairKeys.has(key)) continue;
            pairKeys.add(key);
            const baseOrder = sampleTop + turn.getBoundingClientRect().top;
            if (userTextRaw) pairs.push({ role: 'user', content: userTextRaw, order: baseOrder + 0.001 });
            if (aiTextRaw) pairs.push({ role: 'assistant', content: aiTextRaw, order: baseOrder + 0.002 });
          }
          return pairs;
        };

        const collectFromScopedTurns = (sampleTop) => {
          const rows = [];
          const allTurnNodes = Array.from(document.querySelectorAll(scopedTurnSelector)).filter((node) => isVisible(node));
          const scopedTurns = allTurnNodes.filter((node) => node.matches('[data-scope-id="turn"]'));
          const turnNodes = scopedTurns.length > 0 ? scopedTurns : allTurnNodes;
          const topLevelTurns = turnNodes.filter((node) => !turnNodes.some((other) => other !== node && other.contains(node)));
          const orderedTurns = topLevelTurns.sort((a, b) => {
            if (a === b) return 0;
            const pos = a.compareDocumentPosition(b);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
          });

          let seq = 0;
          for (const turn of orderedTurns) {
            const turnDomKey = deriveTurnDomKey(turn, seq);
            const userCandidates = Array.from(turn.querySelectorAll('.VndcI.veK2kb, [data-xid="aim-mars-user-turn"], .user-message, [data-test-id="user-message"]'))
              .filter((el) => {
                if (!el || !isVisible(el)) return false;
                // Guard against assistant content headings being treated as user turns.
                return !el.closest('[data-xid="VpUvz"], .mZJni.Dn7Fzd, .model-response-text, .markdown, .message-content');
              });
            const assistantCandidate = turn.querySelector('[data-xid="VpUvz"], .mZJni.Dn7Fzd, .model-response-text, .markdown, .message-content');

            const userText = userCandidates
              .map((el) => getNodeText(el))
              .filter(Boolean)
              .sort((a, b) => b.length - a.length)[0] || '';
            const assistantText = assistantCandidate ? extractAssistantContent(assistantCandidate) : '';

            if (!userText && !assistantText) continue;
            const baseOrder = sampleTop + turn.getBoundingClientRect().top + (seq * 0.01);
            const turnFingerprint = normalize(userText + '\\n---\\n' + assistantText).slice(0, 400);
            const scopedKey = (String(turnDomKey || '').startsWith('turn-fallback-') ? '' : String(turnDomKey || '')) || ('fp:' + turnFingerprint);
            if (userText) rows.push({ role: 'user', content: userText, order: baseOrder + 0.001, sourceKey: scopedKey + '|user', turnKey: scopedKey });
            if (assistantText) rows.push({ role: 'assistant', content: assistantText, order: baseOrder + 0.002, sourceKey: scopedKey + '|assistant', turnKey: scopedKey });
            seq += 1;
          }
          return rows;
        };

        const collectFromGlobalDom = (sampleTop) => {
          const rawUserNodes = Array.from(document.querySelectorAll(userSelector));
          const userNodes = rawUserNodes.filter((node) => {
            if (!node || !isVisible(node)) return false;
            if (node.closest(aiContainerSelector)) return false;
            const text = getNodeText(node);
            if (!text) return false;
            if (ignoredUserPhrases.has(text)) return false;
            if (/^hi[, ]+lewis[, ]+what is on your mind/i.test(text)) return false;
            return !rawUserNodes.some((other) => other !== node && other.contains(node));
          });

          const rawAiNodes = Array.from(document.querySelectorAll(aiSelector));
          const aiNodes = rawAiNodes.filter((node) => {
            if (!node || !isVisible(node)) return false;
            const hasAiAncestor = rawAiNodes.some((other) => other !== node && other.contains(node));
            if (hasAiAncestor) return false;
            const isOrContainsUser = userNodes.some((u) => node === u || node.contains(u));
            if (isOrContainsUser) return false;
            const text = getNodeText(node);
            return !!text;
          });

          const mergedNodes = [];
          for (const node of userNodes) mergedNodes.push({ role: 'user', node });
          for (const node of aiNodes) mergedNodes.push({ role: 'assistant', node });

          mergedNodes.sort((a, b) => {
            if (a.node === b.node) return 0;
            const pos = a.node.compareDocumentPosition(b.node);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
          });

          const items = [];
          for (let i = 0; i < mergedNodes.length; i += 1) {
            const { role, node } = mergedNodes[i];
            let content = getNodeText(node);
            if (role === 'assistant') content = content.replace(/Show drafts\\s*$/i, '').trim();
            if (!content) continue;
            const order = sampleTop + node.getBoundingClientRect().top + (i * 0.0001);
            items.push({ role, content, order, sourceKey: '' });
          }
          return items;
        };

	          const firstTurn = document.querySelector(scopedTurnSelector) || document.querySelector(turnSelector) || document.querySelector(aiSelector) || document.querySelector(userSelector);
	          const scroller = getScrollableAncestor(firstTurn);
          const usesWindowScroll = scroller === document.body || scroller === document.documentElement || scroller === document.scrollingElement;
          const getTop = () => usesWindowScroll ? window.scrollY : scroller.scrollTop;
          const setTop = (value) => {
            if (usesWindowScroll) {
              window.scrollTo(0, value);
            } else {
              scroller.scrollTop = value;
            }
          };
          const getClientHeight = () => usesWindowScroll ? window.innerHeight : scroller.clientHeight;
          const getScrollHeight = () => usesWindowScroll
            ? (document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight || 0)
            : scroller.scrollHeight;

          let maxTop = Math.max(0, getScrollHeight() - getClientHeight());
          const sampleAtCurrentScroll = () => {
            const scoped = collectFromScopedTurns(getTop());
            if (scoped.length > 0) {
              results.push(...scoped);
            } else {
              results.push(...collectFromTurnRoots(getTop()));
              results.push(...collectFromGlobalDom(getTop()));
            }
          };
          const settleAtBottom = async () => {
            let lastMaxTop = -1;
            let stablePasses = 0;
            for (let attempt = 0; attempt < 10; attempt += 1) {
              setTop(maxTop);
              await sleep(180);
              clickExpandableButtons();
              await sleep(120);
              sampleAtCurrentScroll();

              const currentMaxTop = Math.max(0, getScrollHeight() - getClientHeight());
              const atBottom = Math.abs(getTop() - currentMaxTop) <= 2;
              if (currentMaxTop === maxTop && atBottom && currentMaxTop === lastMaxTop) {
                stablePasses += 1;
              } else {
                stablePasses = 0;
              }
              lastMaxTop = currentMaxTop;
              maxTop = Math.max(maxTop, currentMaxTop);
              if (stablePasses >= 2) break;
            }
          };

          setTop(0);
          await sleep(120);
          clickExpandableButtons();
          await sleep(80);
          sampleAtCurrentScroll();

          let guard = 0;
          while (getTop() < maxTop - 2 && guard < 320) {
            const next = Math.min(maxTop, getTop() + Math.max(200, Math.floor(getClientHeight() * 0.82)));
            if (next <= getTop() + 1) break;
            setTop(next);
            await sleep(140);
            clickExpandableButtons();
            await sleep(80);
            sampleAtCurrentScroll();
            maxTop = Math.max(maxTop, Math.max(0, getScrollHeight() - getClientHeight()));
            guard += 1;
          }

          if (maxTop > 0) {
            await settleAtBottom();
          }

          const normalized = [];
          const hasTurnKeys = results.some((row) => normalize(row?.turnKey || ''));
          if (hasTurnKeys) {
            const buckets = new Map();
            for (const row of results) {
              if (!row) continue;
              const turnKey = normalize(row?.turnKey || '');
              if (!turnKey) continue;
              const role = row?.role === 'assistant' ? 'assistant' : 'user';
              const content = normalize(row?.content || '');
              if (!content) continue;
              const order = Number.isFinite(Number(row?.order)) ? Number(row.order) : Number.MAX_SAFE_INTEGER;
              let bucket = buckets.get(turnKey);
              if (!bucket) {
                bucket = { order, user: '', assistant: '' };
                buckets.set(turnKey, bucket);
              } else if (order < bucket.order) {
                bucket.order = order;
              }
              if (role === 'user') {
                if (!bucket.user || content.length >= bucket.user.length) bucket.user = content;
              } else {
                if (!bucket.assistant || content.length >= bucket.assistant.length) bucket.assistant = content;
              }
            }
            const mergedTurns = Array.from(buckets.values()).sort((a, b) => a.order - b.order);
            for (const turn of mergedTurns) {
              if (turn.user) normalized.push({ role: 'user', content: turn.user });
              if (turn.assistant) normalized.push({ role: 'assistant', content: turn.assistant });
            }
          } else {
            const ordered = [];
            const seenSourceKeys = new Set();
            for (const row of results) {
              if (!row) continue;
              const sourceKey = normalize(row?.sourceKey || '');
              if (sourceKey && seenSourceKeys.has(sourceKey)) continue;
              if (sourceKey) seenSourceKeys.add(sourceKey);
              ordered.push(row);
            }
            for (const row of ordered) {
              const role = row?.role === 'assistant' ? 'assistant' : 'user';
              const content = normalize(row?.content || '');
              if (!content) continue;
              normalized.push({ role, content });
            }
          }

	          return {
	            ok: true,
	            data: collapseConsecutiveDuplicates(normalized),
	            debug: {
	              href: location.href,
	              title: document.title,
	              readyState: document.readyState,
	              scopedTurnCount: document.querySelectorAll(scopedTurnSelector).length,
	              turnRootCount: document.querySelectorAll(turnSelector).length,
	              userCount: document.querySelectorAll(userSelector).length,
	              assistantCount: document.querySelectorAll(aiSelector).length,
	              rawResultCount: results.length,
	              normalizedCount: normalized.length,
	              scroller: describeScroller(scroller),
	              scrollTop: getTop(),
	              scrollHeight: getScrollHeight(),
	              clientHeight: getClientHeight(),
	              bodyTextPreview: normalize(document.body?.innerText || '').slice(0, 800),
	            },
	          };
        } catch (error) {
          return { ok: false, error: String(error && (error.stack || error.message || error)) };
        }
      })();
    `,
	    { retries: 2, waitTimeoutMs: 3000, label: 'scrape-ai-mode-messages' }
  );
  if (turnsPayload && typeof turnsPayload === 'object' && turnsPayload.ok === true && Array.isArray(turnsPayload.data)) {
    if (turnsPayload.data.length === 0) {
      console.warn('AI Mode scrape returned zero messages:', turnsPayload.debug || {});
    }
    return turnsPayload.data;
  }
  if (turnsPayload && typeof turnsPayload === 'object' && turnsPayload.ok === false) {
    throw new Error(`AI Mode scrape script error: ${turnsPayload.error || 'unknown'}`);
  }
  return [];
}

function setupIpc() {
  ipcMain.handle('auth:login', async () => {
    return await auth.login();
  });

  ipcMain.handle('auth:check', async () => {
    const token = await auth.getAccessToken();
    return !!token;
  });

  ipcMain.handle('auth:reauth', async () => {
    return await auth.reauthenticate({ hardReset: true });
  });

  ipcMain.handle('db:getConversations', async (event, payload) => {
    const mode = typeof payload === 'object' ? payload?.mode : undefined;
    const targetDb = getDatabaseForMode(mode);
    return targetDb.getConversations();
  });

  ipcMain.handle('db:deleteConversation', async (event, arg1, arg2) => {
    const id = typeof arg1 === 'object' ? arg1?.id : arg1;
    const mode = typeof arg1 === 'object' ? arg1?.mode : arg2;
    if (!id) throw new Error('Missing conversation id');
    const targetDb = getDatabaseForMode(mode);
    return targetDb.deleteConversation(id);
  });

  ipcMain.handle('db:getStats', async (event, payload) => {
    const mode = typeof payload === 'object' ? payload?.mode : undefined;
    const targetDb = getDatabaseForMode(mode);
    const localCount = targetDb.getConversations().length;
    const cachedCount = targetDb.db.prepare('SELECT COUNT(DISTINCT conversation_id) as count FROM messages').get().count;
    return { localCount, cachedCount };
  });

  ipcMain.handle('db:getCacheDiagnostics', async (event, payload) => {
    const mode = typeof payload === 'object' ? payload?.mode : undefined;
    const targetDb = getDatabaseForMode(mode);
    return targetDb.getCacheDiagnostics(5000);
  });

  ipcMain.handle('ai:importTakeout', async (event, payload) => {
    const inputPath = String(payload?.path || '').trim();
    if (!inputPath) throw new Error('Missing takeout JSON path');
    if (!fs.existsSync(inputPath)) throw new Error(`Takeout file not found: ${inputPath}`);
    const imported = importAiModeTakeout(aiDb, inputPath);
    return { success: true, ...imported };
  });

  let activeCacheRun = null;

  function sleepUntilCancelled(ms, signal) {
    if (!signal) return sleep(ms);
    if (signal.aborted) return Promise.reject(new DOMException('Cache run cancelled', 'AbortError'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Cache run cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function cacheConversation(conv, { maxRetries = 5, baseBackoffMs = 2500, requestTimeoutMs = 45000, signal } = {}) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (signal?.aborted) return { success: false, cancelled: true, status: null };
      try {
        const controller = new AbortController();
        const abortRequest = () => controller.abort();
        signal?.addEventListener('abort', abortRequest, { once: true });
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        let response;
        try {
          response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversation/${conv.id}`, {
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abortRequest);
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          db.upsertCacheFailure(conv.id, errorText || `HTTP ${response.status}`, response.status);

          const isRetriable = response.status === 429 || response.status === 408 || response.status === 425 || (response.status >= 500 && response.status <= 504);
          if (!isRetriable || attempt === maxRetries - 1) {
            return { success: false, status: response.status };
          }

          const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
          const backoffMs = retryAfterMs ?? withJitter(baseBackoffMs * (2 ** attempt));
          await sleepUntilCancelled(backoffMs, signal);
          continue;
        }

        const data = await response.json();
        if (!data.mapping) {
          db.upsertCacheFailure(conv.id, 'Conversation has no mapping payload', response.status);
          return { success: false, status: response.status };
        }

        let wroteAnyMessage = false;
        db.db.transaction(() => {
          db.upsertConversation({
            ...conv,
            current_node_id: data.current_node,
            last_synced_updated_at: conv.updated_at ?? null,
          });

          Object.values(data.mapping).forEach(node => {
            if (node.message) {
              wroteAnyMessage = true;
              const content = renderMessageContent(node.message, conv.id);
              
              db.upsertMessage({
                id: node.message.id,
                conversation_id: conv.id,
                role: node.message.author?.role || 'assistant',
                content: content || '',
                metadata_json: sanitizeMetadata(node.message.metadata),
                created_at: node.message.create_time || 0,
                parent_id: node.parent
              });
            }
          });
        })();

        if (wroteAnyMessage) {
          db.clearCacheFailure(conv.id);
          return { success: true };
        }

        db.upsertCacheFailure(conv.id, 'No cacheable message nodes in mapping', 200);
        return { success: false, status: 200 };
      } catch (e) {
        if (signal?.aborted) return { success: false, cancelled: true, status: null };
        db.upsertCacheFailure(conv.id, String(e?.message || e), null);
        if (attempt === maxRetries - 1) {
          return { success: false, status: null };
        }
        await sleepUntilCancelled(withJitter(baseBackoffMs * (2 ** attempt)), signal);
      }
    }

    return { success: false, status: null };
  }

  async function cacheConversations(event, convs, signal) {
    let processed = 0;
    let failed = 0;
    let inspected = 0;
    const eligibleTotal = convs.filter((conv) => !conv.is_deleted_on_web).length;
    event.sender.send('api:cacheProgress', {
      stage: 'run-start',
      total: eligibleTotal,
      processed,
      failed,
      inspected,
    });
    
    for (const conv of convs) {
      if (signal.aborted) break;
      inspected++;
      event.sender.send('api:cacheProgress', {
        stage: 'chat-start',
        id: conv.id,
        title: conv.title || '',
        total: eligibleTotal,
        processed,
        failed,
        inspected,
      });
      const existing = db.db.prepare('SELECT id FROM messages WHERE conversation_id = ? LIMIT 1').get(conv.id);
      const hasMetadata = db.db
        .prepare('SELECT id FROM messages WHERE conversation_id = ? AND metadata_json IS NOT NULL LIMIT 1')
        .get(conv.id);
      const needsFullSync = (
        conv.last_synced_updated_at == null ||
        conv.updated_at == null ||
        conv.updated_at !== conv.last_synced_updated_at
      );

      if ((!existing || !hasMetadata || needsFullSync) && !conv.is_deleted_on_web) {
        const result = await cacheConversation(conv, { signal });
        if (result.cancelled) break;
        if (result.success) {
          processed++;
          event.sender.send('api:cacheProgress', {
            stage: 'chat-success',
            current: processed,
            id: conv.id,
            total: eligibleTotal,
            processed,
            failed,
            inspected,
          });
        } else {
          failed++;
          event.sender.send('api:cacheProgress', {
            stage: 'chat-fail',
            current: processed,
            id: conv.id,
            total: eligibleTotal,
            processed,
            failed,
            inspected,
          });
        }

        // Add stronger pacing between chat syncs to avoid bursty request patterns.
        const interChatPauseMs = Math.floor(5000 + (Math.random() * 5001));
        event.sender.send('api:cacheProgress', {
          stage: 'chat-pause',
          id: conv.id,
          pauseMs: interChatPauseMs,
          total: eligibleTotal,
          processed,
          failed,
          inspected,
        });
        try {
          await sleepUntilCancelled(interChatPauseMs, signal);
        } catch (error) {
          if (signal.aborted) break;
          throw error;
        }
      } else {
        event.sender.send('api:cacheProgress', {
          stage: 'chat-skip',
          id: conv.id,
          total: eligibleTotal,
          processed,
          failed,
          inspected,
        });
      }
    }

    if (signal.aborted) {
      event.sender.send('api:cacheProgress', {
        stage: 'run-cancelled',
        total: eligibleTotal,
        processed,
        failed,
        inspected,
      });
      return { success: false, cancelled: true, processed, failed, inspected };
    }

    event.sender.send('api:cacheProgress', {
      stage: 'run-complete',
      total: eligibleTotal,
      processed,
      failed,
      inspected,
    });
    return { success: true, processed, failed };
  }

  async function startCacheRun(event, convs) {
    if (activeCacheRun) {
      return { success: false, processed: 0, failed: 0, reason: 'A cache run is already active' };
    }
    const controller = new AbortController();
    activeCacheRun = controller;
    try {
      return await cacheConversations(event, convs, controller.signal);
    } finally {
      if (activeCacheRun === controller) activeCacheRun = null;
    }
  }

  ipcMain.handle('api:cancelCache', async () => {
    if (!activeCacheRun) return { success: false, reason: 'No cache run is active' };
    activeCacheRun.abort();
    return { success: true };
  });

  ipcMain.handle('api:cacheAll', async (event, payload) => {
    const mode = typeof payload === 'object' ? payload?.mode : undefined;
    if (normalizeWorkspaceMode(mode) === 'aimode') {
      return { success: false, processed: 0, failed: 0, reason: 'cacheAll is only supported for ChatGPT mode' };
    }
    const convs = db.getConversations();
    return startCacheRun(event, convs);
  });

  ipcMain.handle('api:cacheFailed', async (event, payload) => {
    const mode = typeof payload === 'object' ? payload?.mode : undefined;
    if (normalizeWorkspaceMode(mode) === 'aimode') {
      return { success: false, processed: 0, failed: 0, reason: 'cacheFailed is only supported for ChatGPT mode' };
    }
    const diagnostics = db.getCacheDiagnostics(5000);
    const failedIds = new Set(
      (diagnostics.uncachedRows || [])
        .filter(row => row.last_error)
        .map(row => row.id)
    );
    const convs = db.getConversations().filter(conv => failedIds.has(conv.id));
    return startCacheRun(event, convs);
  });

  ipcMain.handle('db:getMessages', async (event, arg1, arg2) => {
    const conversationId = typeof arg1 === 'object' ? arg1?.conversationId : arg1;
    const mode = typeof arg1 === 'object' ? arg1?.mode : arg2;
    if (!conversationId) throw new Error('Missing conversationId');
    const targetDb = getDatabaseForMode(mode);
    return getLinearMessages(conversationId, targetDb);
  });

  ipcMain.handle('api:prewarmConversation', async (event, payload) => {
    const conversationId = typeof payload === 'string'
      ? payload
      : (payload?.conversationId || null);
    const mode = typeof payload === 'object' ? payload?.mode : undefined;
    if (normalizeWorkspaceMode(mode) === 'aimode') {
      if (!conversationId) {
        return { success: false, reason: 'Missing AI Mode conversation id' };
      }
      try {
        const ref = await resolveAiModeConversationRef(conversationId);
        if (!ref) {
          return { success: false, reason: 'AI Mode conversation ref not found' };
        }
        const opened = await openAiModeConversation(ref);
        return {
          success: !!opened,
          reason: opened ? '' : 'Could not open AI Mode conversation in bridge'
        };
      } catch (error) {
        console.warn('AI Mode prewarm failed:', error);
        return { success: false, reason: String(error?.message || error) };
      }
    }
    return prewarmBridgeConversation(conversationId);
  });

  ipcMain.handle('api:getBridgeComposerStatus', async () => {
    return bridgeComposerStatus;
  });

  ipcMain.handle('db:searchMessages', async (event, arg1, arg2) => {
    const query = typeof arg1 === 'object' ? arg1?.query : arg1;
    const mode = typeof arg1 === 'object' ? arg1?.mode : arg2;
    const targetDb = getDatabaseForMode(mode);
    return targetDb.searchMessages(String(query || ''));
  });

  ipcMain.handle('api:getImageDataUrl', async (event, payload) => {
    try {
      const rawImageId = typeof payload === 'string' ? payload : payload?.rawImageId;
      const conversationId = typeof payload === 'string' ? undefined : payload?.conversationId;
      const fileId = extractFileId(rawImageId) || String(rawImageId || '').replace(/^\/+/, '');
      if (!fileId) return null;

      const response = await fetchImageResponse(fileId, conversationId);
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
        const parsed = parseDataUrl(source);
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

        const fileId = extractFileId(requestPath) || requestPath;
        if (!fileId) return { success: false, error: 'Missing file id' };

        const response = await fetchImageResponse(fileId, srcConversationId);
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
    const mode = typeof payload === 'object' ? payload?.mode : undefined;
    if (normalizeWorkspaceMode(mode) === 'aimode') {
      return { success: false, markedCount: 0, reason: 'auditDeletions is only supported for ChatGPT mode' };
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
    const mode = normalizeWorkspaceMode(payload?.mode);
    const offset = Number(payload?.offset || 0);
    const limit = Number(payload?.limit || 20);
    if (mode === 'aimode') {
      try {
        const refs = await fetchAiModeConversationIndex(3000);
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

            if (threadId && aiModeThreadIdToConversationId.has(threadId)) {
              id = aiModeThreadIdToConversationId.get(threadId);
            }

            if (!id && threadId) {
              const candidateLiveId = deriveAiConversationId(ref);
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
              id = deriveAiConversationId(ref);
            }
            takenIds.add(id);

            aiModeConversationRefs.set(id, { ...ref });
            if (threadId) {
              aiModeThreadIdToConversationId.set(threadId, id);
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
        const removed = cleanupAiModeShadowConversations();
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
      for (const ref of aiModeConversationRefs.values()) {
        const threadId = String(ref?.threadId || '').trim();
        const mappedId = threadId && aiModeThreadIdToConversationId.has(threadId)
          ? aiModeThreadIdToConversationId.get(threadId)
          : deriveAiConversationId(ref);
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

  ipcMain.handle('api:sendMessage', async (event, { conversationId, content, model, image, files }) => {
    try {
      const fileList = Array.isArray(files) ? files : [];

      const prompt = String(content || '');
      if (!prompt.trim() && !image && fileList.length === 0) {
        throw new Error('Cannot send an empty message.');
      }

      const warmResult = await prewarmBridgeConversation(conversationId || null);
      if (!warmResult?.success) {
        throw new Error(bridgeComposerStatus.reason || 'Chat is not ready for sending yet.');
      }

      publishBridgeComposerStatus({
        conversationId: conversationId || null,
        state: 'sending',
        ready: false,
        reason: '',
      });

      const uiResult = await sendConversationViaUiAutomation({
        conversationId: conversationId || null,
        content: prompt,
        model,
        image,
        files: fileList,
      });

      if (!uiResult?.ok) {
        const detail = parseBackendErrorDetail(String(uiResult?.bodyText || uiResult?.statusText || ''));
        throw new Error(detail || 'Failed to send message via bridge window UI.');
      }

      publishBridgeComposerStatus({
        conversationId: conversationId || null,
        state: 'thinking',
        ready: false,
        reason: '',
      });
      monitorBridgeGeneration(conversationId || null).catch((error) => {
        console.warn('Bridge generation monitor failed:', error);
      });

      return { success: true };
    } catch (error) {
      publishBridgeComposerStatus({
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
    const mode = normalizeWorkspaceMode(payload?.mode);
    const conversationId = typeof payload === 'string' ? payload : payload?.conversationId;
    const force = typeof payload === 'string' ? false : !!payload?.force;
    if (!conversationId) throw new Error('Missing conversationId');
    if (mode === 'aimode') {
      const key = `aimode:${conversationId}`;
      const now = Date.now();
      if (!force && lastSync.has(key) && now - lastSync.get(key) < 30000) {
        return getLinearMessages(conversationId, aiDb);
      }

      try {
        const ref = await resolveAiModeConversationRef(conversationId);
        if (!ref) {
          lastSync.set(key, now);
          return getLinearMessages(conversationId, aiDb);
        }

        const opened = await openAiModeConversation(ref);
        if (!opened) {
          throw new Error('Could not open AI Mode conversation in bridge');
        }
        let remoteTurns = await scrapeAiModeMessagesFromBridge();
        if (remoteTurns.length <= 2) {
          await sleep(450);
          const retryTurns = await scrapeAiModeMessagesFromBridge();
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
      if (data.mapping) {
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
              const content = renderMessageContent(node.message, conversationId);
              db.upsertMessage({
                id: node.message.id,
                conversation_id: conversationId,
                role: node.message.author?.role || 'assistant',
                content: content || '',
                metadata_json: sanitizeMetadata(node.message.metadata),
                created_at: node.message.create_time || 0,
                parent_id: node.parent
              });
            }
          });
        })();
        lastSync.set(conversationId, now);
      }
      return getLinearMessages(conversationId);
    } catch (error) {
      console.error('Message sync failed:', error);
      throw error;
    }
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'chatgpt-image', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } }
]);

app.whenReady().then(() => {
  auth = new ChatGPTAuth(null);
  db = new ChatDatabase('chatgpt.db');
  aiDb = new ChatDatabase('aimode.db');
  setupIpc();
  createWindow();
  startOomMetricsProbe();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  if (OOM_DEBUG) {
    app.on('child-process-gone', (_event, details) => {
      console.error('[oom-main] child-process-gone', details);
      logRendererMetrics('child-process-gone');
    });
  }
});

app.on('window-all-closed', () => {
  if (oomMetricsTimer) {
    clearInterval(oomMetricsTimer);
    oomMetricsTimer = null;
  }
  if (bridgeWindow && !bridgeWindow.isDestroyed()) {
    bridgeWindow.close();
    bridgeWindow = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
