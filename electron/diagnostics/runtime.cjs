const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { BUILD_INFO_SCHEMA, readBuildInfo } = require('./build-info.cjs');

const DIAGNOSTIC_SCHEMA = 'aibackman-diagnostic-event-v1';
const SNAPSHOT_SCHEMA = 'aibackman-diagnostic-snapshot-v1';
const MAX_STRING = 4000;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_EVENTS = 1000;
const MAX_QUEUE = 2000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 768 * 1024;
const MAX_TOTAL_DIAGNOSTIC_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_RATE_PER_SECOND = 1000;
const DEFAULT_ACTIVATION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const SECRET_KEY = /(token|secret|password|passwd|cookie|authorization|api[-_]?key|private[-_]?key|session)/i;
const SECRET_VALUE = /\b(Bearer|Basic|sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,})\S*/gi;

function truncate(value, limit = MAX_STRING) {
  const text = String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`;
}

function redact(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return truncate(value).replace(SECRET_VALUE, '$1 [REDACTED]');
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return redact({ name: value.name, message: value.message, stack: value.stack }, key);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
      result[childKey] = redact(childValue, childKey);
    }
    return result;
  }
  return value;
}

function safeJson(value, maxBytes = MAX_EVENT_BYTES) {
  let result;
  try {
    result = JSON.stringify(redact(value));
  } catch {
    result = JSON.stringify({ value: '[unserializable]' });
  }
  if (Buffer.byteLength(result) <= maxBytes) return result;
  let low = 0;
  let high = result.length;
  let candidate = JSON.stringify({ truncated: true });
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const next = JSON.stringify({ value: result.slice(0, middle), truncated: true });
    if (Buffer.byteLength(next) <= maxBytes) {
      candidate = next;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (Buffer.byteLength(candidate) <= maxBytes) return candidate;
  return maxBytes >= 4 ? 'null' : '';
}

function boundedValue(value, maxBytes = 8192) {
  try { return JSON.parse(safeJson(value, maxBytes)); }
  catch { return '[unserializable]'; }
}

function makeInstanceId(prefix) {
  return `${prefix}-${process.pid}-${crypto.randomUUID()}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function boundedRecent(values, { maxItems, maxBytes }) {
  const retained = [];
  let bytes = 2;
  for (const value of values.slice(-maxItems).reverse()) {
    const bounded = boundedValue(value, 8192);
    const valueBytes = Buffer.byteLength(safeJson(bounded, 8192)) + 1;
    if (bytes + valueBytes > maxBytes) continue;
    retained.unshift(bounded);
    bytes += valueBytes;
  }
  return { retained, omitted: Math.max(0, values.length - retained.length), bytes };
}

function listDiagnosticFiles(directory) {
  const files = [];
  const visit = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        try { fs.chmodSync(entryPath, 0o700); } catch {}
        visit(entryPath);
      } else if (entry.isFile()) {
        try { fs.chmodSync(entryPath, 0o600); } catch {}
        try {
          const stat = fs.statSync(entryPath);
          files.push({ path: entryPath, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    }
  };
  visit(directory);
  return files;
}

function secureAndPruneDiagnosticFiles(directory, {
  maxBytes = MAX_TOTAL_DIAGNOSTIC_BYTES,
  retentionDays = DEFAULT_RETENTION_DAYS,
} = {}) {
  if (!fs.existsSync(directory)) {
    return { removedFiles: 0, removedBytes: 0, retainedBytes: 0, maxBytes, retentionDays };
  }
  try { fs.chmodSync(directory, 0o700); } catch {}
  const now = Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  let files = listDiagnosticFiles(directory);
  let removedFiles = 0;
  let removedBytes = 0;
  const remove = (entry) => {
    try {
      fs.unlinkSync(entry.path);
      removedFiles += 1;
      removedBytes += entry.size;
      return true;
    } catch {
      return false;
    }
  };
  for (const entry of files) {
    if (now - entry.mtimeMs > maxAgeMs) remove(entry);
  }
  files = listDiagnosticFiles(directory).sort((left, right) => left.mtimeMs - right.mtimeMs);
  let totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of files) {
    if (totalBytes <= maxBytes) break;
    if (now - entry.mtimeMs < DEFAULT_ACTIVATION_TTL_MS * 2) continue;
    if (remove(entry)) totalBytes -= entry.size;
  }
  return { removedFiles, removedBytes, retainedBytes: totalBytes, maxBytes, retentionDays };
}

function inactiveRuntime(mode, buildInfo) {
  const noop = () => null;
  return Object.freeze({
    active: false,
    mode,
    sessionId: null,
    processInstanceId: null,
    start: noop,
    stop: async () => undefined,
    record: noop,
    snapshot: () => null,
    setState: noop,
    taskStart: noop,
    taskUpdate: noop,
    taskEnd: noop,
    resourceOpen: noop,
    resourceClose: noop,
    getPaths: noop,
    getBuildInfo: () => buildInfo,
  });
}

function createDiagnosticRuntime({
  app,
  mode,
  enabled,
  buildInfo,
  rootPath,
  activationTtlMs = null,
  retentionDays = null,
  totalCaptureBytes = null,
}) {
  const active = Boolean(enabled && mode && mode !== 'release-minimal');
  if (!active) return inactiveRuntime(mode, buildInfo);
  const sessionId = makeInstanceId('session');
  const processInstanceId = makeInstanceId('main');
  let running = true;
  let started = false;
  const state = {
    phase: 'created',
    heartbeat_at: null,
    heartbeat_monotonic_ms: null,
    generation: 0,
    last_error: null,
  };
  const tasks = new Map();
  const resources = new Map();
  const events = [];
  let sequence = 0;
  let dropped = 0;
  let queuedBytes = 0;
  let writtenBytes = 0;
  let writeChain = Promise.resolve();
  let heartbeatTimer = null;
  let activationTimer = null;
  let supervisor = null;
  let supervisorPending = 0;
  let supervisorDropped = 0;
  let taskEntriesDropped = 0;
  let resourceEntriesDropped = 0;
  let rateWindowStartedAt = Date.now();
  let rateWindowEvents = 0;
  let stopPromise = null;
  let cleanupStats = null;
  let paths = null;

  function nowMonotonic() {
    return Number(process.hrtime.bigint() / 1000000n);
  }

  function resolveRoot() {
    if (rootPath) return path.resolve(rootPath);
    if (app?.getPath) return path.resolve(app.getPath('userData'), 'debug');
    return path.resolve(process.env.AIBACKMAN_DEBUG_DIR || path.join(os.homedir(), '.config', 'aibackman', 'debug'));
  }

  function appendToSupervisor(message) {
    if (!supervisor?.connected) return;
    if (supervisorPending >= 1000) {
      supervisorDropped += 1;
      return;
    }
    try {
      supervisorPending += 1;
      supervisor.send({
        ...message,
        schema: DIAGNOSTIC_SCHEMA,
        build_id: buildInfo?.build_id || 'unavailable',
        session_id: sessionId,
        process_instance_id: processInstanceId,
      }, () => { supervisorPending = Math.max(0, supervisorPending - 1); });
    } catch {
      supervisorPending = Math.max(0, supervisorPending - 1);
      // The supervisor is a best-effort independent observer. The bounded local
      // event ring remains authoritative if its IPC channel is unavailable.
    }
  }

  function queueWrite(line) {
    if (!paths?.events) return;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_EVENT_BYTES || writtenBytes + queuedBytes + bytes > MAX_FILE_BYTES || queuedBytes + bytes > MAX_QUEUE * MAX_EVENT_BYTES) {
      dropped += 1;
      return;
    }
    queuedBytes += bytes;
    writeChain = writeChain.then(async () => {
      queuedBytes -= bytes;
      try {
        await fs.promises.appendFile(paths.events, line, { encoding: 'utf8', mode: 0o600 });
        writtenBytes += bytes;
      } catch (error) {
        state.last_error = { type: 'diagnostic-write', message: truncate(error.message) };
        dropped += 1;
      }
    });
  }

  function record(event, payload = {}, context = {}) {
    if (!running) return null;
    const now = Date.now();
    if (now - rateWindowStartedAt >= 1000) {
      rateWindowStartedAt = now;
      rateWindowEvents = 0;
    }
    if (rateWindowEvents >= MAX_EVENT_RATE_PER_SECOND) {
      dropped += 1;
      return null;
    }
    rateWindowEvents += 1;
    const item = {
      schema: DIAGNOSTIC_SCHEMA,
      sequence: ++sequence,
      occurred_at: new Date().toISOString(),
      monotonic_ms: nowMonotonic(),
      session_id: sessionId,
      process_instance_id: processInstanceId,
      component: context.component || 'main',
      event: String(event),
      build_id: buildInfo?.build_id || 'unavailable',
      operation_id: context.operationId || payload?.operationId || payload?.operation_id || null,
      parent_operation_id: context.parentOperationId || null,
      payload: boundedValue(payload, Math.floor(MAX_EVENT_BYTES / 2)),
    };
    const line = `${safeJson(item)}\n`;
    if (events.length >= MAX_EVENTS) {
      events.shift();
      dropped += 1;
    }
    events.push(item);
    queueWrite(line);
    appendToSupervisor({ type: 'event', event: item });
    return item;
  }

  function setState(nextState, payload = {}) {
    state.phase = String(nextState);
    state.generation += 1;
    record('state-changed', { state: state.phase, ...payload });
    appendToSupervisor({ type: 'state', state: { ...state } });
  }

  function taskStart(taskId, payload = {}) {
    const id = String(taskId || crypto.randomUUID());
    const task = { task_id: id, started_at: new Date().toISOString(), state: 'running', ...boundedValue(payload) };
    if (!tasks.has(id) && tasks.size >= 200) {
      tasks.delete(tasks.keys().next().value);
      taskEntriesDropped += 1;
    }
    tasks.set(id, task);
    record('task-started', task, { operationId: payload.operationId || id });
    return id;
  }

  function taskUpdate(taskId, payload = {}) {
    const id = String(taskId);
    const previous = tasks.get(id) || { task_id: id };
    const next = { ...previous, ...boundedValue(payload), updated_at: new Date().toISOString() };
    tasks.set(id, next);
    record('task-updated', next, { operationId: payload.operationId || id });
  }

  function taskEnd(taskId, payload = {}) {
    const id = String(taskId);
    const previous = tasks.get(id) || { task_id: id };
    const next = { ...previous, ...boundedValue(payload), state: payload.error ? 'failed' : 'completed', ended_at: new Date().toISOString() };
    tasks.set(id, next);
    record('task-ended', next, { operationId: payload.operationId || id });
    if (tasks.size > 200) tasks.delete(tasks.keys().next().value);
  }

  function resourceOpen(resourceId, payload = {}) {
    const id = String(resourceId || crypto.randomUUID());
    if (!resources.has(id) && resources.size >= 200) {
      resources.delete(resources.keys().next().value);
      resourceEntriesDropped += 1;
    }
    resources.set(id, { resource_id: id, opened_at: new Date().toISOString(), ...boundedValue(payload) });
    record('resource-opened', resources.get(id));
    return id;
  }

  function resourceClose(resourceId, payload = {}) {
    const id = String(resourceId);
    const resource = resources.get(id);
    if (resource) record('resource-closed', { ...resource, ...redact(payload), closed_at: new Date().toISOString() });
    resources.delete(id);
  }

  function snapshot(extra = {}) {
    const boundedTasks = boundedRecent([...tasks.values()], { maxItems: 200, maxBytes: 160 * 1024 });
    const boundedResources = boundedRecent([...resources.values()], { maxItems: 200, maxBytes: 160 * 1024 });
    const boundedEvents = boundedRecent(events, { maxItems: 100, maxBytes: 256 * 1024 });
    const snapshotValue = {
      schema: SNAPSHOT_SCHEMA,
      captured_at: new Date().toISOString(),
      consistency: 'best-effort-cross-process',
      session_id: sessionId,
      process_instance_id: processInstanceId,
      mode,
      build: redact(buildInfo || { schema: BUILD_INFO_SCHEMA, build_id: 'unavailable' }),
      state: { ...state },
      tasks: boundedTasks.retained,
      resources: boundedResources.retained,
      event_ring: {
        retained: events.length,
        dropped,
        next_sequence: sequence + 1,
        queued_bytes: queuedBytes,
        written_bytes: writtenBytes,
        max_events: MAX_EVENTS,
        max_file_bytes: MAX_FILE_BYTES,
        max_event_rate_per_second: MAX_EVENT_RATE_PER_SECOND,
        supervisor_dropped: supervisorDropped,
      },
      registry_bounds: {
        tasks_omitted: boundedTasks.omitted + taskEntriesDropped,
        resources_omitted: boundedResources.omitted + resourceEntriesDropped,
        events_omitted: boundedEvents.omitted,
        max_snapshot_bytes: MAX_SNAPSHOT_BYTES,
      },
      recent_events: boundedEvents.retained,
      ...boundedValue(extra, 8192),
    };
    const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshotValue));
    if (snapshotBytes > MAX_SNAPSHOT_BYTES) {
      snapshotValue.recent_events = [];
      snapshotValue.registry_bounds.events_omitted += boundedEvents.retained.length;
    }
    snapshotValue.snapshot_bytes = Buffer.byteLength(JSON.stringify(snapshotValue));
    appendToSupervisor({ type: 'snapshot', snapshot: snapshotValue });
    return snapshotValue;
  }

  function start() {
    if (started) return paths;
    started = true;
    const directory = resolveRoot();
    const crashes = path.join(directory, 'crashes');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(crashes, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch {}
    try { fs.chmodSync(crashes, 0o700); } catch {}
    cleanupStats = secureAndPruneDiagnosticFiles(directory, {
      maxBytes: positiveInteger(
        totalCaptureBytes ?? process.env.AIBACKMAN_DIAGNOSTIC_TOTAL_BYTES,
        MAX_TOTAL_DIAGNOSTIC_BYTES
      ),
      retentionDays: positiveInteger(
        retentionDays ?? process.env.AIBACKMAN_DIAGNOSTIC_RETENTION_DAYS,
        DEFAULT_RETENTION_DAYS
      ),
    });
    const supervisorId = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    paths = {
      directory,
      events: path.join(directory, `events-${sessionId}.jsonl`),
      chromium: path.join(directory, `chromium-${sessionId}.log`),
      crashDumps: crashes,
      snapshot: path.join(directory, `snapshot-${sessionId}.json`),
      capabilities: path.join(directory, `capabilities-${sessionId}.json`),
      buildInfo: path.join(directory, `build-info-${sessionId}.json`),
      // Keep the Unix-domain socket name short enough for Linux's sockaddr_un
      // limit even when the configured diagnostics root is moderately nested.
      supervisorSocket: path.join(directory, `supervisor-${supervisorId}.sock`),
      supervisorToken: path.join(directory, `supervisor-${supervisorId}.token`),
      supervisorState: path.join(directory, `supervisor-state-${sessionId}.json`),
    };
    fs.closeSync(fs.openSync(paths.events, 'a', 0o600));
    try { fs.chmodSync(paths.events, 0o600); } catch {}
    fs.writeFileSync(paths.buildInfo, `${JSON.stringify(buildInfo || {}, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(paths.capabilities, `${JSON.stringify({
      schema: 'aibackman-diagnostic-capabilities-v1',
      mode,
      build_id: buildInfo?.build_id || 'unavailable',
      supervisor_id: supervisorId,
      controls: ['capabilities', 'build-info', 'snapshot', 'events'],
      limits: {
        max_event_bytes: MAX_EVENT_BYTES,
        max_events: MAX_EVENTS,
        max_event_rate_per_second: MAX_EVENT_RATE_PER_SECOND,
        max_file_bytes: MAX_FILE_BYTES,
        max_snapshot_bytes: MAX_SNAPSHOT_BYTES,
        max_total_capture_bytes: cleanupStats.maxBytes,
        activation_ttl_ms: Math.min(
          positiveInteger(activationTtlMs ?? process.env.AIBACKMAN_DIAGNOSTIC_TTL_MS, DEFAULT_ACTIVATION_TTL_MS),
          DEFAULT_ACTIVATION_TTL_MS
        ),
      },
      retention: cleanupStats,
      redaction: 'keys-and-credential-shaped-values',
      consistency: 'best-effort-cross-process',
    }, null, 2)}\n`, { mode: 0o600 });
    setState('starting');
    heartbeatTimer = setInterval(() => {
      state.heartbeat_at = new Date().toISOString();
      state.heartbeat_monotonic_ms = nowMonotonic();
      record('heartbeat', { phase: state.phase });
      appendToSupervisor({ type: 'heartbeat', heartbeat: { at: state.heartbeat_at, monotonic_ms: state.heartbeat_monotonic_ms } });
    }, 2000);
    heartbeatTimer.unref?.();
    try {
      const supervisorPath = path.join(__dirname, 'supervisor.cjs');
      supervisor = spawn(process.execPath, [
        supervisorPath,
        '--supervisor',
        '--socket', paths.supervisorSocket,
        '--token-file', paths.supervisorToken,
        '--state-file', paths.supervisorState,
      ], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AIBACKMAN_SUPERVISOR_BUILD_ID: buildInfo?.build_id || 'unavailable' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      supervisor.on('error', () => { supervisor = null; });
      supervisor.on('exit', () => { supervisor = null; });
      supervisor.send({ type: 'build', build: buildInfo, mode, session_id: sessionId, process_instance_id: processInstanceId });
    } catch (error) {
      state.last_error = { type: 'supervisor-start', message: truncate(error.message) };
      record('supervisor-start-failed', state.last_error);
    }
    setState('running');
    const ttlMs = Math.min(
      positiveInteger(activationTtlMs ?? process.env.AIBACKMAN_DIAGNOSTIC_TTL_MS, DEFAULT_ACTIVATION_TTL_MS),
      DEFAULT_ACTIVATION_TTL_MS
    );
    activationTimer = setTimeout(() => {
      record('activation-ttl-expired', { ttl_ms: ttlMs });
      void stop('activation-ttl-expired');
    }, ttlMs);
    activationTimer.unref?.();
    return paths;
  }

  async function stop(reason = 'shutdown') {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (!started) {
        running = false;
        return;
      }
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (activationTimer) clearTimeout(activationTimer);
      heartbeatTimer = null;
      activationTimer = null;
      setState('stopping', { reason });
      await writeChain;
      const finalSnapshot = snapshot({ final: true, stop_reason: reason });
      try { fs.writeFileSync(paths.snapshot, `${JSON.stringify(finalSnapshot, null, 2)}\n`, { mode: 0o600 }); } catch {}
      const child = supervisor;
      if (child) {
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          child.once('exit', finish);
          try { child.send({ type: 'shutdown' }); } catch { finish(); }
          setTimeout(finish, 500).unref?.();
        });
      }
      supervisor = null;
      running = false;
      try { fs.unlinkSync(paths.supervisorSocket); } catch {}
      try { fs.unlinkSync(paths.supervisorToken); } catch {}
    })();
    return stopPromise;
  }

  return {
    get active() { return running; },
    mode,
    sessionId,
    processInstanceId,
    start,
    stop,
    record,
    snapshot,
    setState,
    taskStart,
    taskUpdate,
    taskEnd,
    resourceOpen,
    resourceClose,
    getPaths: () => paths,
    getBuildInfo: () => buildInfo,
  };
}

module.exports = {
  DIAGNOSTIC_SCHEMA,
  SNAPSHOT_SCHEMA,
  MAX_EVENT_BYTES,
  MAX_EVENTS,
  MAX_FILE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_TOTAL_DIAGNOSTIC_BYTES,
  redact,
  safeJson,
  secureAndPruneDiagnosticFiles,
  createDiagnosticRuntime,
};
