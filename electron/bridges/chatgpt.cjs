const path = require('path');

function createChatGptRuntime({
  app,
  BrowserWindow,
  session,
  auth,
  db,
  getMainWindow,
  appendDebugEvent,
  debugMode: DEBUG_MODE,
  shouldShowWindow: shouldShowBridgeWindow,
  fastMode: BRIDGE_FAST_MODE,
  fastTurns: BRIDGE_FAST_TURNS,
  fastCache: BRIDGE_FAST_CACHE,
  resourceBlocking: BRIDGE_RESOURCE_BLOCKING,
  blockedResourceTypes: BRIDGE_BLOCKED_RESOURCE_TYPES,
}) {
  const appRoot = path.resolve(__dirname, '..');
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
  let bridgeRequestBlockerInstalled = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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
  if (getMainWindow() && !getMainWindow().isDestroyed()) {
    getMainWindow().webContents.send('api:bridgeComposerStatus', bridgeComposerStatus);
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
        const message = node?.message;
        const role = message?.author?.role;
        const metadata = message?.metadata;
        const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
        const hasVisibleContent = parts.some((part) => (
          typeof part === 'string' ? part.trim().length > 0 : !!part
        ));
        const isThinkingArtifact = metadata?.is_thinking_preamble_message === true
          || metadata?.is_visually_hidden_from_conversation === true;
        return (role === 'user' || role === 'assistant') && hasVisibleContent && !isThinkingArtifact;
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
  if (typeof webContents.getProcessMemoryInfo !== 'function') return null;
  try {
    const proc = await webContents.getProcessMemoryInfo();
    return {
      rssMB: formatKbToMB(proc.residentSet),
      privateMB: formatKbToMB(proc.private),
      sharedMB: formatKbToMB(proc.shared),
    };
  } catch (error) {
    if (DEBUG_MODE && !oomMemoryInfoWarned) {
      oomMemoryInfoWarned = true;
      console.warn('[oom-main] getProcessMemoryInfo unavailable:', String(error?.message || error));
    }
    return null;
  }
}

async function logRendererMetrics(reason) {
  if (!DEBUG_MODE) return;
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
    const mainPid = safePid(getMainWindow());
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
      getWebContentsMemorySummary(getMainWindow() && !getMainWindow().isDestroyed() ? getMainWindow().webContents : null),
      getWebContentsMemorySummary(bridgeWindow && !bridgeWindow.isDestroyed() ? bridgeWindow.webContents : null),
    ]);
    const payload = {
      ts: new Date().toISOString(),
      reason,
      main: slim(findByPid(mainPid)),
      bridge: slim(findByPid(bridgePid)),
      mainProc,
      bridgeProc,
    };
    console.info('[oom-main]', JSON.stringify(payload));
    appendDebugEvent('process-metrics', payload);
  } catch (error) {
    console.warn('[oom-main] metrics read failed', error);
    appendDebugEvent('process-metrics-failed', { reason, error });
  }
}

function attachRendererDiagnostics(label, webContents) {
  if (!DEBUG_MODE || !webContents) return;
  webContents.on('console-message', (_event, ...args) => {
    const first = args[0];
    const details = first && typeof first === 'object'
      ? first
      : { level: first, message: args[1], lineNumber: args[2], sourceId: args[3] };
    appendDebugEvent('renderer-console', {
      label,
      level: details.level,
      message: String(details.message || '').slice(0, 12000),
      lineNumber: details.lineNumber,
      sourceId: details.sourceId,
    });
  });
  webContents.on('preload-error', (_event, preloadPath, error) => {
    appendDebugEvent('renderer-preload-error', { label, preloadPath, error });
  });
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    appendDebugEvent('renderer-did-fail-load', {
      label,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    });
  });
  webContents.on('did-finish-load', () => {
    appendDebugEvent('renderer-did-finish-load', {
      label,
      url: webContents.isDestroyed() ? '' : webContents.getURL(),
      osProcessId: webContents.isDestroyed() ? null : webContents.getOSProcessId(),
    });
  });
  webContents.on('render-process-gone', (_event, details) => {
    console.error(`[oom-main] ${label} render-process-gone`, details);
    appendDebugEvent('renderer-process-gone', { label, details });
    logRendererMetrics(`${label}:render-process-gone`);
  });
  webContents.on('unresponsive', () => {
    console.error(`[oom-main] ${label} unresponsive`);
    appendDebugEvent('renderer-unresponsive', { label });
    logRendererMetrics(`${label}:unresponsive`);
  });
  webContents.on('responsive', () => {
    appendDebugEvent('renderer-responsive', { label });
  });
}

function startOomMetricsProbe() {
  if (!DEBUG_MODE || oomMetricsTimer) return;
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
      preload: path.join(appRoot, 'bridge-preload.cjs'),
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

async function navigateBridgeTo(url, options = {}) {
  const win = await ensureBridgeWindow();
  const homeUrl = 'https://chatgpt.com/';
  const targetUrl = url || homeUrl;
  const currentUrl = win.webContents.getURL();
  const forceReload = !!options.forceReload;

  if (currentUrl && normalizeChatgptUrl(currentUrl) === normalizeChatgptUrl(targetUrl)) {
    if (forceReload) {
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
    }
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

async function waitForBridgeComposer(win, conversationId, { timeoutMs = 30000 } = {}) {
  const expectedPath = conversationId ? `/c/${conversationId}` : '/';
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 0);
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

async function waitForBridgeConversationContent(win, conversationId, { timeoutMs = 30000 } = {}) {
  if (!win || win.isDestroyed() || !conversationId) return null;
  const expectedPath = `/c/${conversationId}`;
  const normalizedExpectedPath = expectedPath.replace(/\/+$/, '');
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0);
  const startTime = Date.now();
  let lastState = null;
  let stableCounter = 0;

  while (Date.now() < deadline) {
    if (win.isDestroyed()) throw new Error('Bridge window was closed while loading conversation');
    try {
      lastState = await win.webContents.executeJavaScript(
        `
          (() => {
            const deepResearchFrames = Array.from(document.querySelectorAll('iframe')).filter((iframe) => {
              const signature = String(iframe.getAttribute('title') || '') + ' ' + String(iframe.getAttribute('src') || '');
              return /deep[-_]research|connector_openai_deep_research/i.test(signature);
            }).length;
            const messageCount = document.querySelectorAll(
              '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-message-id]'
            ).length;
            return {
              path: location.pathname,
              readyState: document.readyState,
              messageCount,
              deepResearchFrames,
              bodyTextLength: String(document.body?.innerText || '').trim().length,
            };
          })();
        `,
        true
      );
    } catch (error) {
      const message = String(error?.message || error || '');
      if (!/execution context was destroyed|Object has been destroyed|Script failed to execute/i.test(message)) {
        throw error;
      }
      stableCounter = 0;
      await sleep(100);
      continue;
    }

    const normalizedPath = String(lastState?.path || '').replace(/\/+$/, '');
    const pathOk = normalizedPath === normalizedExpectedPath;
    const hasConversationContent = Number(lastState?.messageCount || 0) > 0
      || Number(lastState?.deepResearchFrames || 0) > 0;
    const documentSettled = lastState?.readyState === 'complete'
      && Number(lastState?.bodyTextLength || 0) > 0
      && Date.now() - startTime >= 5000;

    if (pathOk && (hasConversationContent || documentSettled)) {
      stableCounter += 1;
      if (stableCounter >= 3) return lastState;
    } else {
      stableCounter = 0;
    }
    await sleep(100);
  }

  throw new Error(`Bridge did not load conversation ${expectedPath}. Path: ${lastState?.path}`);
}

async function captureChatGptEmbeddedUi(win, conversationId, { timeoutMs = 0 } = {}) {
  if (!win || win.isDestroyed() || !conversationId) return [];
  const expectedPath = `/c/${conversationId}`;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);

  while (true) {
    if (win.isDestroyed()) return [];
    const currentUrl = String(win.webContents.getURL() || '');
    let currentPath = '';
    try {
      currentPath = new URL(currentUrl).pathname.replace(/\/+$/, '') || '/';
    } catch {
      currentPath = '';
    }

    if (currentPath === expectedPath) {
      try {
        const rawEntries = await win.webContents.executeJavaScript(
          `
            (() => {
              const entries = Array.from(document.querySelectorAll('iframe')).map((iframe) => {
                const title = String(iframe.getAttribute('title') || '');
                const src = String(iframe.getAttribute('src') || iframe.src || '');
                const isDeepResearch = /deep[-_]research|connector_openai_deep_research/i.test(title + ' ' + src);
                if (!isDeepResearch || !src) return null;
                const rect = iframe.getBoundingClientRect();
                const styleHeight = Number.parseFloat(String(iframe.style.height || ''));
                return {
                  title,
                  src,
                  height: Number.isFinite(styleHeight) && styleHeight > 0 ? styleHeight : rect.height,
                };
              }).filter(Boolean);
              if (entries.length > 0) return entries;

              const scrollables = [document.scrollingElement, ...document.querySelectorAll('main, [data-scroll-root], div')]
                .filter((element, index, all) => (
                  element
                  && all.indexOf(element) === index
                  && element.scrollHeight > element.clientHeight + 200
                ))
                .sort((a, b) => b.scrollHeight - a.scrollHeight)
                .slice(0, 6);
              for (const element of scrollables) {
                element.scrollTop = element.scrollHeight;
                try { element.dispatchEvent(new Event('scroll', { bubbles: true })); } catch {}
              }
              try { window.scrollTo(0, document.documentElement.scrollHeight); } catch {}
              return [];
            })();
          `,
          true
        );
        const entries = sanitizeEmbeddedUiEntries(rawEntries);
        if (entries.length > 0) return entries;
      } catch (error) {
        const message = String(error?.message || error || '');
        if (!/execution context was destroyed|Object has been destroyed|Script failed to execute/i.test(message)) {
          return [];
        }
      }
    }

    if (Date.now() >= deadline) return [];
    await sleep(200);
  }
}

function attachEmbeddedUiToConversation(conversationId, entries, preferredMessageIds = []) {
  const embeddedUi = sanitizeEmbeddedUiEntries(entries);
  if (!conversationId || embeddedUi.length === 0 || !db) return 0;

  const messages = db.getMessages(conversationId);
  const preferred = new Set((Array.isArray(preferredMessageIds) ? preferredMessageIds : []).filter(Boolean));
  let targets = messages.filter((message) => preferred.has(message.id));

  // ChatGPT can expose the same widget metadata on several mapping nodes. The
  // database needs one owner for one embedded result, otherwise the renderer
  // quite reasonably displays the same iframe repeatedly.
  if (targets.length > 1) {
    const widgetMessage = targets.find((message) => (
      message.role === 'tool'
      && messageContainsEmbeddedUi({ content: message.content, metadata: parseMetadataJson(message.metadata_json) })
    ));
    targets = [widgetMessage || targets.find((message) => message.role === 'tool') || targets[targets.length - 1]];
  }

  if (targets.length === 0) {
    targets = messages
      .filter((message) => message.role === 'tool' && messageContainsEmbeddedUi({ content: message.content, metadata: parseMetadataJson(message.metadata_json) }))
      .slice(-1);
  }

  if (targets.length === 0) {
    targets = messages.filter((message) => message.role === 'assistant' && !String(message.content || '').trim()).slice(-1);
  }

  if (targets.length === 0) return 0;

  db.db.transaction(() => {
    const targetIds = new Set(targets.map((message) => message.id));
    for (const message of messages) {
      if (targetIds.has(message.id)) continue;
      const metadata = parseMetadataJson(message.metadata_json);
      if (!Array.isArray(metadata.embedded_ui)) continue;
      delete metadata.embedded_ui;
      const serialized = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
      db.db.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?').run(serialized, message.id);
    }
    for (const message of targets) {
      const metadata = parseMetadataJson(message.metadata_json);
      metadata.embedded_ui = embeddedUi;
      db.db.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), message.id);
    }
  })();

  return targets.length;
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

async function prewarmBridgeConversation(conversationId, options = {}) {
  const normalizedConversationId = conversationId || null;
  const requireComposer = options.requireComposer !== false || !normalizedConversationId;
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
    const win = await navigateBridgeTo(targetUrl, options);
    if (shouldShowBridgeWindow()) {
      try {
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        if (!win.isFocused()) win.focus();
      } catch {}
    }
    if (requireComposer) {
      await waitForBridgeComposer(win, normalizedConversationId);
    } else {
      await waitForBridgeConversationContent(win, normalizedConversationId);
    }
    if (normalizedConversationId) {
      let embeddedUi = await captureChatGptEmbeddedUi(win, normalizedConversationId, {
        timeoutMs: requireComposer ? 1200 : 6000,
      });
      if (embeddedUi.length > 0) {
        embeddedUi = await captureChatGptEmbeddedUiSnapshots(win, embeddedUi, { timeoutMs: DEEP_RESEARCH_CAPTURE_TIMEOUT_MS });
        attachEmbeddedUiToConversation(normalizedConversationId, embeddedUi);
      }
    }
    if (warmToken !== bridgeWarmRequestToken) {
      return { success: false, superseded: true };
    }
    let composerReady = requireComposer;
    if (!requireComposer) {
      try {
        await waitForBridgeComposer(win, normalizedConversationId, { timeoutMs: 1500 });
        composerReady = true;
      } catch {
        composerReady = false;
      }
    }
    publishBridgeComposerStatus({
      conversationId: normalizedConversationId,
      state: composerReady ? 'ready' : 'loaded',
      ready: composerReady,
      reason: '',
    });
    return { success: true, composerReady };
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

const DEEP_RESEARCH_IFRAME_HOST = 'connector_openai_deep_research.web-sandbox.oaiusercontent.com';
const DEEP_RESEARCH_CAPTURE_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.CHATGPT_DEEP_RESEARCH_CAPTURE_TIMEOUT_MS || 12000)
);
const DEEP_RESEARCH_SNAPSHOT_FORMAT_VERSION = 3;

function sanitizeEmbeddedUiEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const output = [];
  const seen = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const rawSrc = typeof entry.src === 'string' ? entry.src.trim() : '';
    if (!rawSrc) continue;

    let parsed;
    try {
      parsed = new URL(rawSrc);
    } catch {
      continue;
    }

    if (parsed.protocol !== 'https:' || parsed.hostname !== DEEP_RESEARCH_IFRAME_HOST) continue;
    const src = parsed.toString();
    if (seen.has(src)) continue;
    seen.add(src);

    output.push({
      kind: 'deep-research',
      title: typeof entry.title === 'string' && entry.title.trim() && !/^internal:\/\//i.test(entry.title.trim())
        ? entry.title.trim().slice(0, 200)
        : 'Deep Research result',
      src,
      height: Math.max(320, Math.min(1200, Number(entry.height) || 484)),
      text: typeof entry.text === 'string' && entry.text.trim()
        ? entry.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 250000)
        : '',
      markdown: typeof entry.markdown === 'string' && entry.markdown.trim()
        ? entry.markdown.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 250000)
        : '',
      formatVersion: Number(entry.formatVersion) === DEEP_RESEARCH_SNAPSHOT_FORMAT_VERSION
        ? DEEP_RESEARCH_SNAPSHOT_FORMAT_VERSION
        : 0,
    });
  }

  return output;
}

function buildEmbeddedUiSnapshotScript() {
  return `
    (() => {
      const ignoredTags = /^(SCRIPT|STYLE|NOSCRIPT|SVG|CANVAS|TEMPLATE)$/;
      const semanticSelector = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table';

      const isHidden = (element) => {
        for (let current = element; current instanceof Element; current = current.parentElement) {
          if (current.hidden || current.getAttribute('aria-hidden') === 'true') return true;
          if (ignoredTags.test(current.tagName)) return true;
          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
          if (Number.parseFloat(style.opacity || '1') === 0) return true;
        }
        return false;
      };

      const intersects = (a, b) => (
        a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom
      );

      const isTextNodeVisible = (node) => {
        const parent = node.parentElement;
        if (!parent || isHidden(parent) || !String(node.nodeValue || '').trim()) return false;
        const range = document.createRange();
        range.selectNodeContents(node);
        let rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
        range.detach?.();
        if (rects.length === 0) return false;

        for (let current = parent; current instanceof Element; current = current.parentElement) {
          const style = getComputedStyle(current);
          const clipsX = /hidden|clip/.test(style.overflowX);
          const clipsY = /hidden|clip/.test(style.overflowY);
          if (!clipsX && !clipsY) continue;
          const clip = current.getBoundingClientRect();
          // Small clipped boxes are commonly animated counters. Large clipped
          // regions are document viewports whose off-screen report text must
          // still be included in the cached snapshot.
          if (clip.height > 80 && clip.width > 80) continue;
          rects = rects.filter((rect) => {
            if (!intersects(rect, clip)) return false;
            if (clipsX && (rect.right <= clip.left || rect.left >= clip.right)) return false;
            if (clipsY && (rect.bottom <= clip.top || rect.top >= clip.bottom)) return false;
            return true;
          });
          if (rects.length === 0) return false;
        }
        return true;
      };

      const cleanText = (value) => String(value || '')
        .replace(/(?:^|\\s)(?:[0-9]\\s+){10,}[0-9](?=\\s|$)/g, ' ')
        .replace(/\\s+/g, ' ')
        .replace(/\\s+([,.;:!?])/g, '$1')
        .trim();

      const visibleText = (element) => {
        if (!(element instanceof Element) || isHidden(element)) return '';
        const chunks = [];
        const visit = (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            if (isTextNodeVisible(node)) chunks.push(String(node.nodeValue || ''));
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
          if (node instanceof Element && ignoredTags.test(node.tagName)) return;
          if (node.shadowRoot) visit(node.shadowRoot);
          for (const child of node.childNodes || []) visit(child);
        };
        visit(element);
        return cleanText(chunks.join(' '));
      };

      const safeLinkHref = (element) => {
        const rawHref = String(
          element.getAttribute('href')
          || element.getAttribute('data-href')
          || element.getAttribute('data-url')
          || ''
        ).trim();
        if (!rawHref) return '';
        try {
          const parsed = new URL(rawHref, location.href);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
          return parsed.toString().replace(/\\(/g, '%28').replace(/\\)/g, '%29');
        } catch {
          return '';
        }
      };

      const inlineMarkdown = (element) => {
        const visit = (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            return isTextNodeVisible(node) ? String(node.nodeValue || '') : '';
          }
          if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
          if (node instanceof Element && (ignoredTags.test(node.tagName) || isHidden(node))) return '';
          if (node instanceof Element && node.tagName === 'BR') return '\\n';

          const parts = [];
          if (node.shadowRoot) parts.push(visit(node.shadowRoot));
          for (const child of node.childNodes || []) parts.push(visit(child));
          let content = parts.join('').replace(/\\s+/g, ' ').trim();
          if (!(node instanceof Element) || !content) return content;

          const tag = node.tagName;
          if (tag === 'A') {
            const href = safeLinkHref(node);
            if (href) {
              const label = content.replace(/([\\[\\]\\\\])/g, '\\\\$1');
              return '[' + label + '](' + href + ')';
            }
          }
          if (tag === 'STRONG' || tag === 'B') return '**' + content + '**';
          if (tag === 'EM' || tag === 'I') return '*' + content + '*';
          if (tag === 'DEL' || tag === 'S') return '~~' + content + '~~';
          if (tag === 'CODE' && node.parentElement?.tagName !== 'PRE') {
            const marker = String.fromCharCode(96);
            return marker + content.replace(new RegExp(marker, 'g'), marker + marker) + marker;
          }
          return content;
        };

        return visit(element)
          .replace(/[ \\t]+/g, ' ')
          .replace(/ *\\n */g, '\\n')
          .replace(/\\s+([,.;:!?])/g, '$1')
          .trim();
      };

      const collectRoots = () => {
        const roots = [document];
        const seen = new Set(roots);
        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          for (const element of root.querySelectorAll?.('*') || []) {
            if (element.shadowRoot && !seen.has(element.shadowRoot)) {
              seen.add(element.shadowRoot);
              roots.push(element.shadowRoot);
            }
          }
        }
        return roots;
      };

      const escapeCell = (value) => cleanText(value).replace(/\\|/g, '\\\\|');
      const tableMarkdown = (table) => {
        const rows = Array.from(table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr'))
          .map((row) => Array.from(row.querySelectorAll(':scope > th, :scope > td')).map(visibleText))
          .filter((cells) => cells.some(Boolean));
        if (rows.length === 0) return '';
        const width = Math.max(...rows.map((cells) => cells.length));
        const padded = rows.map((cells) => Array.from({ length: width }, (_, index) => escapeCell(cells[index] || '')));
        const header = padded[0];
        const divider = Array.from({ length: width }, () => '---');
        return [header, divider, ...padded.slice(1)].map((cells) => '| ' + cells.join(' | ') + ' |').join('\\n');
      };

      const blocks = [];
      const seenElements = new Set();
      const seenHeadings = new Set();
      for (const root of collectRoots()) {
        for (const element of root.querySelectorAll?.(semanticSelector) || []) {
          if (seenElements.has(element) || isHidden(element)) continue;
          seenElements.add(element);
          const semanticParent = element.parentElement?.closest(semanticSelector);
          if (semanticParent) continue;
          const tag = element.tagName.toLowerCase();
          const rawText = visibleText(element);
          if (!rawText) continue;

          let markdown = inlineMarkdown(element) || rawText;
          if (/^h[1-6]$/.test(tag)) {
            const headingKey = rawText.toLocaleLowerCase();
            if (seenHeadings.has(headingKey)) continue;
            seenHeadings.add(headingKey);
            markdown = '#'.repeat(Number(tag.slice(1))) + ' ' + markdown;
          }
          else if (tag === 'li') markdown = '- ' + markdown;
          else if (tag === 'blockquote') markdown = markdown.split('\\n').map((line) => '> ' + line).join('\\n');
          else if (tag === 'pre') {
            const fence = String.fromCharCode(96).repeat(3);
            markdown = fence + '\\n' + rawText + '\\n' + fence;
          }
          else if (tag === 'table') markdown = tableMarkdown(element) || rawText;

          if (/research completed/i.test(rawText) && /(?:[0-9]\\s+){10,}/.test(String(element.textContent || ''))) {
            const summary = rawText.split(/\\s*[·•]\\s*/)[0].trim();
            if (summary) markdown = summary;
          }

          const previous = blocks[blocks.length - 1];
          if (previous && previous.text.toLocaleLowerCase() === rawText.toLocaleLowerCase()) continue;
          blocks.push({ text: rawText, markdown });
        }
      }

      let markdown = blocks.map((block) => block.markdown).join('\\n\\n')
        .replace(/\\n{3,}/g, '\\n\\n').trim();
      let text = blocks.map((block) => block.text).join('\\n\\n')
        .replace(/\\n{3,}/g, '\\n\\n').trim();

      if (text.length < 200 && document.body) {
        text = visibleText(document.body);
        markdown = text;
      }

      const body = document.body;
      return {
        text,
        markdown,
        formatVersion: ${DEEP_RESEARCH_SNAPSHOT_FORMAT_VERSION},
        title: String(document.title || ''),
        height: Number(document.documentElement?.scrollHeight || body?.scrollHeight || 0),
      };
    })();
  `;
}

async function captureStandaloneEmbeddedUiSnapshot(entry, { timeoutMs = DEEP_RESEARCH_CAPTURE_TIMEOUT_MS } = {}) {
  if (!entry?.src) return entry;
  let captureWindow = null;
  try {
    captureWindow = new BrowserWindow({
      show: false,
      width: 1280,
      height: 1000,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    captureWindow.webContents.setAudioMuted(true);
    await captureWindow.loadURL(entry.src, {
      httpReferrer: 'https://chatgpt.com/',
      userAgent: ensureAppUserAgent(),
    });

    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0);
    while (!captureWindow.isDestroyed() && Date.now() < deadline) {
      try {
        const snapshot = await captureWindow.webContents.executeJavaScript(buildEmbeddedUiSnapshotScript(), true);
        const text = typeof snapshot?.text === 'string' ? snapshot.text.trim() : '';
        const markdown = typeof snapshot?.markdown === 'string' ? snapshot.markdown.trim() : '';
        if (text) {
          return {
            ...entry,
            text,
            markdown,
            formatVersion: DEEP_RESEARCH_SNAPSHOT_FORMAT_VERSION,
            height: Math.max(entry.height || 484, Number(snapshot.height) || 0),
          };
        }
      } catch {
        // The standalone result may still be creating its document.
      }
      await sleep(250);
    }
  } catch {
    // Some Deep Research results only work when initialized by ChatGPT.
  } finally {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy();
  }
  return entry;
}

async function captureChatGptEmbeddedUiSnapshots(win, entries, { timeoutMs = 0 } = {}) {
  if (!win || win.isDestroyed() || !Array.isArray(entries) || entries.length === 0) return entries;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const bestSnapshots = new Map();
  let lastFrameDiagnostics = [];

  const normalizeUrl = (value) => {
    try {
      const parsed = new URL(String(value || ''));
      return `${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch {
      return String(value || '');
    }
  };

  while (true) {
    if (win.isDestroyed()) return entries;
    const allFrames = Array.isArray(win.webContents.mainFrame?.framesInSubtree)
      ? win.webContents.mainFrame.framesInSubtree
      : [];
    const connectorRoots = allFrames.filter((frame) => {
      if (!frame || frame.isDestroyed?.()) return false;
      try {
        return new URL(String(frame.url || '')).hostname === DEEP_RESEARCH_IFRAME_HOST;
      } catch {
        return false;
      }
    });
    const frameCandidates = [];
    const seenFrames = new Set();
    for (const root of connectorRoots) {
      const sourceUrl = normalizeUrl(root.url);
      const subtree = Array.isArray(root.framesInSubtree) ? root.framesInSubtree : [root];
      for (const frame of subtree) {
        if (!frame || frame.isDestroyed?.()) continue;
        if (seenFrames.has(frame)) continue;
        seenFrames.add(frame);
        frameCandidates.push({ frame, sourceUrl });
      }
    }

    const frameDiagnostics = [];
    for (const candidate of frameCandidates) {
      const { frame, sourceUrl } = candidate;
      try {
        const snapshot = await frame.executeJavaScript(buildEmbeddedUiSnapshotScript(), true);
        const text = typeof snapshot?.text === 'string' ? snapshot.text.trim() : '';
        const markdown = typeof snapshot?.markdown === 'string' ? snapshot.markdown.trim() : '';
        frameDiagnostics.push({
          url: normalizeUrl(frame.url),
          sourceUrl,
          textLength: text.length,
          title: typeof snapshot?.title === 'string' ? snapshot.title.slice(0, 120) : '',
        });
        if (!text) continue;
        const url = normalizeUrl(frame.url);
        const snapshotKey = `${sourceUrl}\n${url}`;
        const previous = bestSnapshots.get(snapshotKey);
        if (!previous || text.length > previous.text.length) {
          bestSnapshots.set(snapshotKey, {
            ...snapshot,
            text,
            markdown,
            url,
            sourceUrl,
          });
        }
      } catch (error) {
        frameDiagnostics.push({
          url: normalizeUrl(frame.url),
          sourceUrl,
          textLength: 0,
          error: String(error?.message || error || 'frame execution failed').slice(0, 200),
        });
        // The iframe may be navigating while the parent chat settles.
      }
    }
    lastFrameDiagnostics = frameDiagnostics;

    const captured = entries.map((entry) => {
      const normalizedEntryUrl = normalizeUrl(entry.src);
      const matching = Array.from(bestSnapshots.values())
        .filter((snapshot) => entries.length === 1 || snapshot.sourceUrl === normalizedEntryUrl)
        .sort((a, b) => b.text.length - a.text.length)[0];
      if (!matching) return entry;
      return {
        ...entry,
        text: matching.text,
        markdown: matching.markdown,
        formatVersion: DEEP_RESEARCH_SNAPSHOT_FORMAT_VERSION,
        height: Math.max(entry.height || 484, Number(matching.height) || 0),
      };
    });

    if (captured.every((entry) => typeof entry.text === 'string' && entry.text.trim())) return captured;
    if (Date.now() >= deadline) {
      const fallbackCaptured = [];
      for (const entry of captured) {
        if (entry.text?.trim()) {
          fallbackCaptured.push(entry);
          continue;
        }
        fallbackCaptured.push(await captureStandaloneEmbeddedUiSnapshot(entry));
      }
      if (fallbackCaptured.some((entry) => !entry.text?.trim())) {
        console.warn('Deep Research capture returned no rendered text:', {
          sources: entries.map((entry) => entry.src),
          frames: lastFrameDiagnostics,
        });
      }
      return fallbackCaptured;
    }
    await sleep(200);
  }
}

function parseMetadataJson(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function messageContainsEmbeddedUi(message) {
  if (!message || typeof message !== 'object') return false;
  try {
    const raw = JSON.stringify(message).toLowerCase();
    return raw.includes('embedded ui')
      || raw.includes('deep-research')
      || raw.includes('deep_research')
      || raw.includes('connector_openai_deep_research')
      || raw.includes('web-sandbox');
  } catch {
    return false;
  }
}

function getEmbeddedUiMessageIds(data) {
  if (!data || typeof data !== 'object' || !data.mapping || typeof data.mapping !== 'object') return [];
  const mapping = data.mapping;
  const chain = [];
  const visited = new Set();
  let nodeId = data.current_node;
  let guard = 0;

  while (nodeId && mapping[nodeId] && !visited.has(nodeId) && guard < 12000) {
    visited.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId]?.parent || null;
    guard += 1;
  }

  chain.reverse();
  return chain
    .filter((node) => node?.message && messageContainsEmbeddedUi(node.message))
    .map((node) => node.message.id)
    .filter(Boolean);
}

function mergeEmbeddedUiMetadataJson(messageId, freshMetadataJson, dbInstance = db) {
  const fresh = parseMetadataJson(freshMetadataJson);
  const existingRow = messageId
    ? dbInstance?.db.prepare('SELECT metadata_json FROM messages WHERE id = ?').get(messageId)
    : null;
  const existing = parseMetadataJson(existingRow?.metadata_json);

  if (!fresh.embedded_ui && Array.isArray(existing.embedded_ui) && existing.embedded_ui.length > 0) {
    fresh.embedded_ui = sanitizeEmbeddedUiEntries(existing.embedded_ui);
  }

  return Object.keys(fresh).length > 0 ? JSON.stringify(fresh) : null;
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
  // Embedded result widgets
  'embedded_ui',
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

    if (key === 'embedded_ui') {
      const embeddedUi = sanitizeEmbeddedUiEntries(value);
      if (embeddedUi.length > 0) output[key] = embeddedUi;
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

  function shutdown() {
    if (oomMetricsTimer) {
      clearInterval(oomMetricsTimer);
      oomMetricsTimer = null;
    }
    if (bridgeWindow && !bridgeWindow.isDestroyed()) bridgeWindow.close();
    bridgeWindow = null;
  }

  return {
    attachEmbeddedUiToConversation,
    attachRendererDiagnostics,
    captureEmbeddedUi: captureChatGptEmbeddedUi,
    captureEmbeddedUiSnapshots: captureChatGptEmbeddedUiSnapshots,
    deepResearchCaptureTimeoutMs: DEEP_RESEARCH_CAPTURE_TIMEOUT_MS,
    ensureAppUserAgent,
    ensureBridgeWindow,
    extractFileId,
    fetchImageResponse,
    getBridgeWindow: () => bridgeWindow,
    getComposerStatus: () => bridgeComposerStatus,
    getEmbeddedUiMessageIds,
    logRendererMetrics,
    mergeEmbeddedUiMetadataJson,
    messageContainsEmbeddedUi,
    monitorGeneration: monitorBridgeGeneration,
    navigateBridgeTo,
    parseBackendErrorDetail,
    parseDataUrl,
    prewarmConversation: prewarmBridgeConversation,
    publishComposerStatus: publishBridgeComposerStatus,
    renderMessageContent,
    sanitizeMetadata,
    sendConversation: sendConversationViaUiAutomation,
    shutdown,
    startMetrics: startOomMetricsProbe,
  };
}

module.exports = createChatGptRuntime;
