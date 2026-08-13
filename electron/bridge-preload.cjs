const { contextBridge } = require('electron');

const parseArg = (prefix, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (!hit) return fallback;
  const value = hit.slice(prefix.length);
  return value === '' ? fallback : value;
};

const fastModeEnabled = parseArg('--bridge-fast-mode=', '1') !== '0';
const maxTurns = Math.max(1, Number(parseArg('--bridge-fast-turns=', '1')) || 1);
const cacheSize = Math.max(1, Number(parseArg('--bridge-fast-cache=', '5')) || 5);

function installFastModeMainWorld(maxTurnsArg, cacheSizeArg) {
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

  const MAX_TURNS = Math.max(1, Number(maxTurnsArg) || 1);
  const CACHE_SIZE = Math.max(1, Number(cacheSizeArg) || 5);
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
    const message = node && node.message ? node.message : null;
    const role = message && message.author ? message.author.role : null;
    const metadata = message ? message.metadata : null;
    const parts = message && message.content && Array.isArray(message.content.parts) ? message.content.parts : [];
    const hasVisibleContent = parts.some((part) => (
      typeof part === 'string' ? part.trim().length > 0 : !!part
    ));
    const isThinkingArtifact = !!metadata && (
      metadata.is_thinking_preamble_message === true
      || metadata.is_visually_hidden_from_conversation === true
    );
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
      nid = mapping[nid] && mapping[nid].parent ? mapping[nid].parent : null;
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
      nid = mapping[nid] && mapping[nid].parent ? mapping[nid].parent : null;
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

    const kept = new Set();
    for (let i = 0; i < cutoff; i++) {
      if (!isVisibleNode(mapping[chain[i]])) kept.add(chain[i]);
    }
    for (let i = cutoff; i < chain.length; i++) {
      kept.add(chain[i]);
    }

    const keptChain = chain.filter((id) => kept.has(id));
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
    const isConversationGet = method === 'GET' && /^\/backend-api\/conversation\/[^/]+$/.test(pathname);
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

    const conversationMatch = pathname.match(/^\/backend-api\/conversation\/([^/]+)$/);
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
}

if (fastModeEnabled) {
  let installedByMainWorld = false;
  try {
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({
        func: installFastModeMainWorld,
        args: [maxTurns, cacheSize],
      });
      installedByMainWorld = true;
    }
  } catch {
    installedByMainWorld = false;
  }

  if (!installedByMainWorld) {
    const fallbackScript = `(${installFastModeMainWorld.toString()})(${JSON.stringify(maxTurns)}, ${JSON.stringify(cacheSize)});`;
    const inject = () => {
      const root = document.documentElement || document.head;
      if (!root) return false;
      const script = document.createElement('script');
      script.textContent = fallbackScript;
      root.appendChild(script);
      script.remove();
      return true;
    };

    if (!inject()) {
      let attempts = 0;
      const timer = setInterval(() => {
        attempts++;
        if (inject() || attempts > 200) clearInterval(timer);
      }, 0);
      window.addEventListener('DOMContentLoaded', () => {
        inject();
        clearInterval(timer);
      }, { once: true });
    }
  }
}
