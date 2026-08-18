const { readConversations } = require('../archive/standard/reader.cjs');
const { STANDARD_CACHE_FORMAT_VERSION } = require('../archive/standard/cacheVersion.cjs');

function withJitter(milliseconds, jitterRatio = 0.25) {
  const jitter = milliseconds * jitterRatio;
  return Math.max(0, Math.round(milliseconds + ((Math.random() * 2 - 1) * jitter)));
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

function sleepUntilCancelled(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Cache run cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Cache run cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createChatGptCacheService({ auth, db, conversations }) {
  let activeRun = null;

  async function cacheConversation(conversation, {
    maxRetries = 5,
    baseBackoffMs = 2500,
    requestTimeoutMs = 45000,
    signal,
  } = {}) {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      if (signal?.aborted) return { success: false, cancelled: true, status: null };
      try {
        const controller = new AbortController();
        const abortRequest = () => controller.abort();
        signal?.addEventListener('abort', abortRequest, { once: true });
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        let response;
        try {
          response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversation/${conversation.id}`, {
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abortRequest);
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          db.upsertCacheFailure(conversation.id, errorText || `HTTP ${response.status}`, response.status);
          const retriable = response.status === 429
            || response.status === 408
            || response.status === 425
            || (response.status >= 500 && response.status <= 504);
          if (!retriable || attempt === maxRetries - 1) {
            return { success: false, status: response.status };
          }
          const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
          await sleepUntilCancelled(retryAfterMs ?? withJitter(baseBackoffMs * (2 ** attempt)), signal);
          continue;
        }

        const data = await response.json();
        if (!data.mapping || !data.current_node) {
          db.upsertCacheFailure(conversation.id, 'Conversation has no mapping payload', response.status);
          return { success: false, status: response.status };
        }

        const existingMessages = conversations.getLinear(conversation.id);
        const remoteTurns = conversations.buildRemoteTurns(data, conversation.id);
        if (conversations.shouldPreserve(existingMessages, remoteTurns)) {
          db.upsertCacheFailure(
            conversation.id,
            'Preserved cached conversation because remote snapshot looked partial or interrupted',
            200
          );
          return { success: false, status: 200, preservedCached: true };
        }

        if (conversations.writeSnapshot(conversation, data)) {
          db.clearCacheFailure(conversation.id);
          return { success: true };
        }
        db.upsertCacheFailure(conversation.id, 'No cacheable message nodes in mapping', 200);
        return { success: false, status: 200 };
      } catch (error) {
        if (signal?.aborted) return { success: false, cancelled: true, status: null };
        db.upsertCacheFailure(conversation.id, String(error?.message || error), null);
        if (attempt === maxRetries - 1) return { success: false, status: null };
        await sleepUntilCancelled(withJitter(baseBackoffMs * (2 ** attempt)), signal);
      }
    }
    return { success: false, status: null };
  }

  async function cacheConversations(event, sourceConversations, signal) {
    let processed = 0;
    let failed = 0;
    let inspected = 0;
    const total = sourceConversations.filter((conversation) => !conversation.is_deleted_on_web).length;
    const publish = (stage, details = {}) => event.sender.send('api:cacheProgress', {
      stage,
      total,
      processed,
      failed,
      inspected,
      ...details,
    });
    publish('run-start');

    for (const conversation of sourceConversations) {
      if (signal.aborted) break;
      inspected += 1;
      publish('chat-start', { id: conversation.id, title: conversation.title || '' });
      const hasMessages = db.hasMessages(conversation.id);
      // Older scraper runs stored citations/reasoning metadata but discarded the
      // model fields. Treat those conversations as uncached so a later cache
      // run can refresh them with the model and effort metadata now preserved.
      const hasMissingModelMetadata = db.hasAssistantMessagesMissingModelMetadata(conversation.id);
      const needsFullSync = conversation.cache_format_version !== STANDARD_CACHE_FORMAT_VERSION
        || conversation.last_synced_updated_at == null
        || conversation.updated_at == null
        || conversation.updated_at !== conversation.last_synced_updated_at;

      if ((!hasMessages || hasMissingModelMetadata || needsFullSync) && !conversation.is_deleted_on_web) {
        const result = await cacheConversation(conversation, { signal });
        if (result.cancelled) break;
        if (result.success) {
          processed += 1;
          publish('chat-success', { current: processed, id: conversation.id });
        } else {
          failed += 1;
          publish('chat-fail', { current: processed, id: conversation.id });
        }

        const pauseMs = Math.floor(5000 + (Math.random() * 5001));
        publish('chat-pause', { id: conversation.id, pauseMs });
        try {
          await sleepUntilCancelled(pauseMs, signal);
        } catch (error) {
          if (signal.aborted) break;
          throw error;
        }
      } else {
        publish('chat-skip', { id: conversation.id });
      }
    }

    if (signal.aborted) {
      publish('run-cancelled');
      return { success: false, cancelled: true, processed, failed, inspected };
    }
    publish('run-complete');
    return { success: true, processed, failed };
  }

  async function start(event, sourceConversations) {
    if (activeRun) {
      return { success: false, processed: 0, failed: 0, reason: 'A cache run is already active' };
    }
    const controller = new AbortController();
    activeRun = controller;
    try {
      return await cacheConversations(event, sourceConversations, controller.signal);
    } finally {
      if (activeRun === controller) activeRun = null;
    }
  }

  function cancel() {
    if (!activeRun) return { success: false, reason: 'No cache run is active' };
    activeRun.abort();
    return { success: true };
  }

  return { cancel, start };
}

function registerChatGptCacheIpc({
  ipcMain,
  auth,
  db,
  getDatabase,
  resolveAccount,
  conversations,
  createConversations,
}) {
  const services = new Map();
  const contextFor = (payload) => {
    const targetDb = getDatabase ? getDatabase(payload) : db;
    if (!targetDb) throw new Error('No ChatGPT archive database is available for this account.');
    if (!services.has(targetDb)) {
      services.set(targetDb, createChatGptCacheService({
        auth,
        db: targetDb,
        conversations: createConversations ? createConversations(targetDb) : conversations,
      }));
    }
    return { db: targetDb, service: services.get(targetDb) };
  };
  const unsupported = () => ({
    success: false,
    processed: 0,
    failed: 0,
    reason: 'This account does not support live bulk caching',
  });

  ipcMain.handle('api:cancelCache', async () => {
    let cancelled = false;
    for (const service of services.values()) {
      if (service.cancel().success) cancelled = true;
    }
    return cancelled
      ? { success: true }
      : { success: false, reason: 'No cache run is active' };
  });
  ipcMain.handle('api:cacheAll', async (event, payload) => {
    if (!resolveAccount(payload)?.capabilities.cacheAll) return unsupported();
    const context = contextFor(payload);
    return context.service.start(event, readConversations(context.db));
  });
  ipcMain.handle('api:cacheFailed', async (event, payload) => {
    if (!resolveAccount(payload)?.capabilities.cacheAll) return unsupported();
    const context = contextFor(payload);
    const diagnostics = context.db.getCacheDiagnostics(5000);
    const failedIds = new Set(
      [...(diagnostics.uncachedRows || []), ...(diagnostics.resyncRows || [])]
        .filter((row) => row.last_error)
        .map((row) => row.id)
    );
    return context.service.start(
      event,
      readConversations(context.db).filter((conversation) => failedIds.has(conversation.id))
    );
  });
}

module.exports = {
  createChatGptCacheService,
  registerChatGptCacheIpc,
};
