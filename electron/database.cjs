const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { app } = require('electron');
const readline = require('readline');
const { STANDARD_CACHE_FORMAT_VERSION } = require('./archive/standard/cacheVersion.cjs');
const {
  ArchiveRecoveryManager,
  DurableAuditJournal,
  archiveRootForDatabase,
} = require('./archive/safety/journal.cjs');
const {
  ARCHIVE_SAFETY_SCHEMA_VERSION,
  ARCHIVE_SAFETY_TRIGGER_COUNT,
  installArchiveSafetySchema,
  resetArchiveOperationContext,
} = require('./archive/safety/schema.cjs');

const DB_SEARCH_TOOL_DIR = path.resolve(__dirname, '..', 'tools', 'db-search');
const DB_SEARCH_MANIFEST = path.join(DB_SEARCH_TOOL_DIR, 'Cargo.toml');
const FUZZY_RANK_DIR = path.resolve(__dirname, '..', '..', 'fuzzy-rank');
const DB_SEARCH_REBUILD_ROOTS = [
  DB_SEARCH_TOOL_DIR,
  FUZZY_RANK_DIR,
];
const ARCHIVE_GUARD_STATES = new WeakMap();
const DESTRUCTIVE_ARCHIVE_CAPABILITY = Symbol('destructive-archive-capability');

function installArchiveGuardFunctions(db) {
  const state = {
    contextWriteAllowed: false,
    destructiveAllowed: false,
    writeAllowed: false,
  };
  ARCHIVE_GUARD_STATES.set(db, state);
  db.function('archive_context_write_allowed', () => (state.contextWriteAllowed ? 1 : 0));
  db.function('archive_destructive_allowed', () => (state.destructiveAllowed ? 1 : 0));
  db.function('archive_write_allowed', () => (state.writeAllowed ? 1 : 0));
}

function withArchiveGuard(db, key, value, callback) {
  const state = ARCHIVE_GUARD_STATES.get(db);
  if (!state) throw new Error('Archive guard state is unavailable.');
  const previous = state[key];
  state[key] = value;
  try {
    return callback();
  } finally {
    state[key] = previous;
  }
}

function sourceFilesUnder(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFilesUnder(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function getDbSearchBinaryCandidates() {
  const executableName = process.platform === 'win32' ? 'chatgpt-db-search.exe' : 'chatgpt-db-search';
  return [
    path.join(DB_SEARCH_TOOL_DIR, 'target', 'release', executableName),
    path.join(DB_SEARCH_TOOL_DIR, 'target', 'debug', executableName),
  ];
}

function getNewestDbSearchBinary() {
  for (const candidate of getDbSearchBinaryCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function dbSearchBinaryNeedsRebuild(binaryPath) {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return true;
  }

  const binaryMtime = fs.statSync(binaryPath).mtimeMs;
  const rebuildInputs = DB_SEARCH_REBUILD_ROOTS.flatMap((root) => [
    path.join(root, 'Cargo.toml'),
    path.join(root, 'Cargo.lock'),
    ...sourceFilesUnder(path.join(root, 'src')),
  ]);
  return rebuildInputs.some((filePath) => {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    return fs.statSync(filePath).mtimeMs > binaryMtime;
  });
}

function ensureDbSearchBinary() {
  const existingBinary = getNewestDbSearchBinary();
  if (existingBinary && !dbSearchBinaryNeedsRebuild(existingBinary)) {
    return existingBinary;
  }

  const build = spawnSync('cargo', ['build', '--release', '--manifest-path', DB_SEARCH_MANIFEST], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });

  if (build.status !== 0) {
    throw new Error((build.stderr || build.stdout || 'cargo build failed').trim());
  }

  const rebuiltBinary = getNewestDbSearchBinary();
  if (rebuiltBinary) {
    return rebuiltBinary;
  }

  throw new Error('db-search helper build succeeded but no binary was found');
}

function runDbSearchHelper(args) {
  const binaryPath = ensureDbSearchBinary();
  const result = spawnSync(binaryPath, args, {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'db-search helper failed').trim());
  }

  return result.stdout.trim();
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

class DbSearchWorker {
  constructor(dbPath, {
    diagnostics = null,
    databaseInstanceId = null,
    requestTimeoutMs = 30000,
    binaryResolver = ensureDbSearchBinary,
    spawnImpl = spawn,
  } = {}) {
    this.dbPath = dbPath;
    this.diagnostics = diagnostics;
    this.databaseInstanceId = databaseInstanceId;
    this.requestTimeoutMs = requestTimeoutMs;
    this.binaryResolver = binaryResolver;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.readline = null;
    this.binaryPath = null;
    this.binaryMtimeMs = 0;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.workerInstanceId = `db-search-${process.pid}-${crypto.randomUUID()}`;
    this.resourceId = null;
  }

  ensureStarted() {
    const binaryPath = this.binaryResolver();
    const binaryMtimeMs = fs.statSync(binaryPath).mtimeMs;
    if (
      this.child
      && !this.child.killed
      && this.child.exitCode === null
      && this.binaryPath === binaryPath
      && this.binaryMtimeMs === binaryMtimeMs
    ) {
      return;
    }

    this.stop();
    this.workerInstanceId = `db-search-${process.pid}-${crypto.randomUUID()}`;
    this.binaryPath = binaryPath;
    this.binaryMtimeMs = binaryMtimeMs;
    const binarySha256 = sha256File(binaryPath);
    this.child = this.spawnImpl(binaryPath, ['serve', '--db-path', this.dbPath], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const child = this.child;
    this.diagnostics?.record('worker-started', {
      worker: 'db-search',
      worker_instance_id: this.workerInstanceId,
      database_instance_id: this.databaseInstanceId,
      pid: child.pid,
      binary_path: binaryPath,
      binary_mtime_ms: binaryMtimeMs,
      binary_sha256: binarySha256,
    }, { component: 'db-search-worker' });
    const resourceId = this.diagnostics?.resourceOpen(null, {
      type: 'child-process',
      worker: 'db-search',
      worker_instance_id: this.workerInstanceId,
      database_instance_id: this.databaseInstanceId,
      pid: child.pid,
      binary_path: binaryPath,
      binary_sha256: binarySha256,
    }) || null;
    this.resourceId = resourceId;
    this.readline = readline.createInterface({ input: child.stdout });
    this.readline.on('line', (line) => this.handleLine(line));
    child.stdin.on('error', (error) => {
      this.diagnostics?.record('worker-stdin-error', {
        worker: 'db-search',
        worker_instance_id: this.workerInstanceId,
        error,
      }, { component: 'db-search-worker' });
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) {
        console.warn('db-search worker:', text);
        this.diagnostics?.record('worker-stderr', { worker: 'db-search', text }, { component: 'db-search-worker' });
      }
    });
    child.on('error', (error) => {
      this.diagnostics?.record('worker-error', { worker: 'db-search', error }, { component: 'db-search-worker' });
    });
    child.on('exit', (code, signal) => {
      const error = new Error(`db-search worker exited (${code ?? signal ?? 'unknown'})`);
      this.diagnostics?.record('worker-exited', {
        worker: 'db-search',
        worker_instance_id: this.workerInstanceId,
        code,
        signal,
        pending: this.pending.size,
      }, { component: 'db-search-worker' });
      for (const { reject, timer, taskId } of this.pending.values()) {
        clearTimeout(timer);
        this.diagnostics?.taskEnd(taskId, { error: error.message });
        reject(error);
      }
      this.pending.clear();
      this.diagnostics?.resourceClose(resourceId, {
        type: 'child-process',
        worker: 'db-search',
        code,
        signal,
      });
      if (this.resourceId === resourceId) this.resourceId = null;
      if (this.child === child) {
        this.child = null;
        this.readline = null;
        this.binaryPath = null;
        this.binaryMtimeMs = 0;
      }
    });
  }

  handleLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      console.warn('db-search worker returned invalid JSON:', error);
      this.diagnostics?.record('worker-invalid-response', {
        worker: 'db-search',
        error,
        response_length: Buffer.byteLength(line),
        response_sha256: crypto.createHash('sha256').update(line).digest('hex'),
      }, { component: 'db-search-worker' });
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      this.diagnostics?.taskEnd(pending.taskId, { state: 'completed', request_id: response.id });
      pending.resolve(response.output || { total: 0, total_is_lower_bound: false, results: [] });
    } else {
      this.diagnostics?.taskEnd(pending.taskId, { error: response.error || 'db-search worker request failed', request_id: response.id });
      pending.reject(new Error(response.error || 'db-search worker request failed'));
    }
  }

  search(query, limit = 100) {
    this.ensureStarted();
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ id, command: 'search', query, limit });
    const taskId = this.diagnostics?.taskStart(`db-search-${id}`, {
      worker: 'db-search',
      request_id: id,
      query_length: String(query || '').length,
      limit,
      database_instance_id: this.databaseInstanceId,
    }) || `db-search-${id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.diagnostics?.taskEnd(taskId, { error: 'db-search worker request timed out', request_id: id });
        reject(new Error('db-search worker request timed out'));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, taskId });
      this.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        this.diagnostics?.taskEnd(taskId, { error, request_id: id });
        reject(error);
      });
    });
  }

  stop() {
    if (this.readline) this.readline.close();
    if (this.child && !this.child.killed) this.child.kill();
    for (const { reject, timer, taskId } of this.pending.values()) {
      clearTimeout(timer);
      this.diagnostics?.taskEnd(taskId, { error: 'db-search worker stopped' });
      reject(new Error('db-search worker stopped'));
    }
    this.pending.clear();
    this.diagnostics?.resourceClose(this.resourceId, {
      type: 'child-process',
      worker: 'db-search',
      reason: 'worker-stop',
    });
    this.resourceId = null;
    this.child = null;
    this.readline = null;
    this.binaryPath = null;
    this.binaryMtimeMs = 0;
  }
}

class ChatDatabase {
  #db;
  #dbPath;
  #diagnosticResourceId = null;
  #activeOperationId = null;

  constructor(filename = 'chatgpt.db', {
    diagnostics = null,
    accountId = null,
    initializeSearchIndex = false,
  } = {}) {
    const dbPath = path.isAbsolute(filename)
      ? filename
      : path.join(app.getPath('userData'), filename);
    const databaseExisted = fs.existsSync(dbPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(dbPath), 0o700);
    this.#dbPath = dbPath;
    this.accountId = accountId;
    this.initializeSearchIndex = initializeSearchIndex;
    this.databaseInstanceId = `database-${process.pid}-${crypto.randomUUID()}`;
    this.diagnostics = diagnostics;
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.pragma('foreign_keys = ON');
    this.#db.pragma('recursive_triggers = ON');
    this.#db.pragma('busy_timeout = 5000');
    this.#db.pragma('temp_store = MEMORY');
    this.#db.pragma('cache_size = -32768');
    installArchiveGuardFunctions(this.#db);
    this.#db.function('archive_sha256', { deterministic: true }, (value) => (
      crypto.createHash('sha256').update(String(value ?? '')).digest('hex')
    ));
    try { fs.chmodSync(this.#dbPath, 0o600); } catch {}
    const archiveRoot = archiveRootForDatabase(dbPath);
    this.auditJournal = new DurableAuditJournal(archiveRoot, {
      buildInfo: diagnostics?.getBuildInfo?.() || null,
      maxBytes: Number(process.env.AIBACKMAN_AUDIT_MAX_BYTES || 256 * 1024 * 1024),
    });
    this.recoveryManager = new ArchiveRecoveryManager(archiveRoot, this.auditJournal);
    this.searchWorker = new DbSearchWorker(dbPath, {
      diagnostics,
      databaseInstanceId: this.databaseInstanceId,
    });
    const previousSchemaVersion = Number(this.#db.pragma('user_version', { simple: true }) || 0);
    const preflightTables = new Set(this.#db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map((row) => row.name));
    const hasConversations = preflightTables.has('conversations');
    const hasMessages = preflightTables.has('messages');
    if (databaseExisted && (!hasConversations || !hasMessages)) {
      const snapshot = this.recoveryManager.createDatabaseSnapshot({
        sqlite: this.#db,
        dbPath: this.#dbPath,
        reason: 'before-refusing-incomplete-archive-schema',
        force: true,
        includeEmptySchema: true,
      });
      this.#db.close();
      throw new Error(
        `Existing archive database is missing required content tables; startup refused instead of recreating empty data: `
        + `${this.#dbPath}. Recovery snapshot: ${snapshot?.snapshot_database || 'unavailable'}`
      );
    }
    const preflightTriggerCount = Number(this.#db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'archive_%'
    `).get()?.count || 0);
    if (
      previousSchemaVersion >= ARCHIVE_SAFETY_SCHEMA_VERSION
      && preflightTriggerCount < ARCHIVE_SAFETY_TRIGGER_COUNT
    ) {
      this.recoveryManager.createDatabaseSnapshot({
        sqlite: this.#db,
        dbPath: this.#dbPath,
        reason: `before-safety-trigger-repair-v${ARCHIVE_SAFETY_SCHEMA_VERSION}`,
        force: true,
        includeEmptySchema: true,
      });
    }
    if (previousSchemaVersion < ARCHIVE_SAFETY_SCHEMA_VERSION) {
      this.recoveryManager.createDatabaseSnapshot({
        sqlite: this.#db,
        dbPath: this.#dbPath,
        reason: `before-schema-migration-v${ARCHIVE_SAFETY_SCHEMA_VERSION}`,
        includeEmptySchema: true,
      });
    }
    const safetySchemaNeedsInstall = previousSchemaVersion < ARCHIVE_SAFETY_SCHEMA_VERSION
      || preflightTriggerCount !== ARCHIVE_SAFETY_TRIGGER_COUNT;
    this.init({ installSafetySchema: safetySchemaNeedsInstall });
    const identity = this.#db.prepare('SELECT * FROM archive_store_identity WHERE singleton = 1').get();
    if (!identity) {
      const createdAt = new Date().toISOString();
      withArchiveGuard(this.#db, 'writeAllowed', true, () => this.#db.prepare(`
          INSERT INTO archive_store_identity (singleton, store_instance_id, store_generation, created_at, updated_at)
          VALUES (1, ?, ?, ?, ?)
        `).run(`store-${crypto.randomUUID()}`, `generation-${crypto.randomUUID()}`, createdAt, createdAt));
    }
    const storedIdentity = this.#db.prepare('SELECT * FROM archive_store_identity WHERE singleton = 1').get();
    this.storeInstanceId = storedIdentity.store_instance_id;
    this.storeGeneration = storedIdentity.store_generation;
    this.repairStartupMetadata();
    this.#diagnosticResourceId = this.diagnostics?.resourceOpen(null, {
      type: 'sqlite-database',
      account_id: this.accountId,
      database_instance_id: this.databaseInstanceId,
      store_instance_id: this.storeInstanceId,
      database_path: this.#dbPath,
    }) || null;
    this.diagnostics?.record('database-opened', {
      account_id: this.accountId,
      database_instance_id: this.databaseInstanceId,
      store_instance_id: this.storeInstanceId,
      store_generation: this.storeGeneration,
      database_path: this.#dbPath,
    }, { component: 'archive-database' });
    if (previousSchemaVersion < ARCHIVE_SAFETY_SCHEMA_VERSION) {
      this.#db.pragma(`user_version = ${ARCHIVE_SAFETY_SCHEMA_VERSION}`);
    }
  }

  get dbPath() {
    return this.#dbPath;
  }

  init({ installSafetySchema = true } = {}) {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at DATETIME,
        updated_at DATETIME,
        last_synced_updated_at DATETIME,
        current_node_id TEXT,
        cache_format_version INTEGER,
        is_deleted_on_web INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        role TEXT,
        content TEXT,
        metadata_json TEXT,
        created_at DATETIME,
        parent_id TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE TABLE IF NOT EXISTS cache_failures (
        conversation_id TEXT PRIMARY KEY,
        last_error TEXT,
        status_code INTEGER,
        last_attempt_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        attempt_count INTEGER DEFAULT 1,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE TABLE IF NOT EXISTS source_items (
        source_key TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_messages_role_created ON messages(role, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC, id);
    `);

    // Migrations
    const tableInfo = this.#db.prepare("PRAGMA table_info(conversations)").all();
    const messagesTableInfo = this.#db.prepare("PRAGMA table_info(messages)").all();
    
    const hasCurrentNode = tableInfo.some(col => col.name === 'current_node_id');
    if (!hasCurrentNode) {
      this.#db.exec("ALTER TABLE conversations ADD COLUMN current_node_id TEXT");
    }

    const hasDeletedOnWeb = tableInfo.some(col => col.name === 'is_deleted_on_web');
    if (!hasDeletedOnWeb) {
      this.#db.exec("ALTER TABLE conversations ADD COLUMN is_deleted_on_web INTEGER DEFAULT 0");
    }

    const hasLastSyncedUpdatedAt = tableInfo.some(col => col.name === 'last_synced_updated_at');
    if (!hasLastSyncedUpdatedAt) {
      this.#db.exec("ALTER TABLE conversations ADD COLUMN last_synced_updated_at DATETIME");
    }

    const hasCacheFormatVersion = tableInfo.some(col => col.name === 'cache_format_version');
    if (!hasCacheFormatVersion) {
      this.#db.exec("ALTER TABLE conversations ADD COLUMN cache_format_version INTEGER");
    }

    const hasMetadataJson = messagesTableInfo.some(col => col.name === 'metadata_json');
    if (!hasMetadataJson) {
      this.#db.exec("ALTER TABLE messages ADD COLUMN metadata_json TEXT");
    }

    const contextOptions = {
      withContextWrite: (callback) => withArchiveGuard(this.#db, 'contextWriteAllowed', true, callback),
    };
    if (installSafetySchema) installArchiveSafetySchema(this.#db, contextOptions);
    else resetArchiveOperationContext(this.#db, contextOptions);

    if (this.initializeSearchIndex) {
      try {
        runDbSearchHelper(['ensure-index', '--db-path', this.#dbPath]);
      } catch (error) {
        console.warn('db-search index setup failed, falling back to LIKE search until fixed:', error);
      }
    }
  }

  repairStartupMetadata() {
    const candidates = this.#db.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM conversations
          WHERE cache_format_version = ?
            AND last_synced_updated_at IS NULL
            AND updated_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id
            )
        ) AS sync_markers,
        (
          SELECT COUNT(*)
          FROM messages
          WHERE parent_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM messages parent
              WHERE parent.id = messages.parent_id
                AND parent.conversation_id = messages.conversation_id
            )
        ) AS orphan_parents
    `).get(STANDARD_CACHE_FORMAT_VERSION);
    const syncMarkers = Number(candidates?.sync_markers || 0);
    const orphanParents = Number(candidates?.orphan_parents || 0);
    if (syncMarkers === 0 && orphanParents === 0) return;

    const repaired = this.runArchiveOperation({
      type: 'startup-metadata-repair',
      actor: 'aibackman-startup',
      reason: 'Repair known incomplete cache markers and invalid message parent references without removing archive content.',
      reasonCode: 'startup-metadata-repair',
      writerComponent: 'archive-startup-repair',
      details: {
        candidateSyncMarkers: syncMarkers,
        candidateOrphanParents: orphanParents,
      },
    }, () => {
      // A current-format live snapshot is authoritative even if an older
      // writer failed to copy the remote index timestamp into the sync marker.
      // Message-less index rows remain untouched because they are not cached.
      const repairedSyncMarkers = this.#db.prepare(`
        UPDATE conversations
        SET last_synced_updated_at = updated_at
        WHERE cache_format_version = ?
          AND last_synced_updated_at IS NULL
          AND updated_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id
          )
      `).run(STANDARD_CACHE_FORMAT_VERSION).changes;

      // Older ChatGPT live snapshots could persist mapping-node sentinels such
      // as `client-created-root` as message IDs. A parent absent from the same
      // conversation is a root, otherwise readers can fall back to the wrong
      // timestamp ordering.
      const repairedOrphanParents = this.#db.prepare(`
        UPDATE messages
        SET parent_id = NULL
        WHERE parent_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM messages parent
            WHERE parent.id = messages.parent_id
              AND parent.conversation_id = messages.conversation_id
          )
      `).run().changes;

      return { repairedSyncMarkers, repairedOrphanParents };
    });

    console.info(
      `[storage] startup metadata repair in ${path.basename(this.#dbPath)}: `
      + `${repaired.repairedSyncMarkers} sync marker(s), ${repaired.repairedOrphanParents} parent link(s)`
    );
  }

  getArchiveCounts() {
    const row = this.#db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM conversations) AS conversations,
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM source_items) AS source_items
    `).get();
    return {
      conversations: Number(row?.conversations || 0),
      messages: Number(row?.messages || 0),
      sourceItems: Number(row?.source_items || 0),
    };
  }

  runArchiveOperation(metadata, callback) {
    const destructive = metadata?.destructive === true;
    if (destructive && metadata?.destructiveCapability !== DESTRUCTIVE_ARCHIVE_CAPABILITY) {
      throw new Error('Destructive archive operations require an internal confirmed capability.');
    }
    if (this.#activeOperationId) return callback(this.#activeOperationId);

    const operationId = String(metadata?.operationId || crypto.randomUUID());
    const operationType = String(metadata?.type || 'archive-write');
    const actor = String(metadata?.actor || 'aibackman').slice(0, 200);
    const reason = String(metadata?.reason || operationType).slice(0, 2000);
    const reasonCode = String(metadata?.reasonCode || operationType).slice(0, 200);
    const writerComponent = String(metadata?.writerComponent || 'archive-database-api').slice(0, 200);
    const writerInstanceId = String(metadata?.writerInstanceId || this.databaseInstanceId).slice(0, 200);
    const actorTrust = 'asserted-in-process';
    const entityType = String(metadata?.entityType || 'database');
    const entityId = metadata?.entityId == null ? null : String(metadata.entityId);
    const before = this.getArchiveCounts();
    const taskId = this.diagnostics?.taskStart(`archive-${operationId}`, {
      operationId,
      operation_type: operationType,
      actor,
      reason_code: reasonCode,
      writer_component: writerComponent,
      database_instance_id: this.databaseInstanceId,
      store_instance_id: this.storeInstanceId,
    });

    try {
      this.auditJournal.append({
        action: 'operation-started',
        operation_id: operationId,
        operation_type: operationType,
        actor,
        reason,
        database_path: this.#dbPath,
        entity_type: entityType,
        entity_id: entityId,
        destructive,
        before,
        event_schema: 'aibackman-audit-event-v1',
        writer_component: writerComponent,
        writer_instance_id: writerInstanceId,
        store_instance_id: this.storeInstanceId,
        store_generation: this.storeGeneration,
        transaction_id: operationId,
        reason_code: reasonCode,
        details: metadata?.details || null,
      });
    } catch (error) {
      this.diagnostics?.taskEnd(taskId, { error, operationId });
      throw error;
    }

    let after = before;
    try {
      const execute = this.#db.transaction(() => {
        withArchiveGuard(this.#db, 'contextWriteAllowed', true, () => this.#db.prepare(`
            UPDATE archive_operation_context
            SET operation_id = ?, operation_type = ?, actor = ?, reason = ?,
                started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), destructive_allowed = ?,
                writer_component = ?, writer_instance_id = ?, store_instance_id = ?,
                store_generation = ?, transaction_id = ?, actor_trust = ?, reason_code = ?
            WHERE singleton = 1
          `).run(
            operationId,
            operationType,
            actor,
            reason,
            destructive ? 1 : 0,
            writerComponent,
            writerInstanceId,
            this.storeInstanceId,
            this.storeGeneration,
            operationId,
            actorTrust,
            reasonCode
          ));

        this.#activeOperationId = operationId;
        let result;
        try {
          result = withArchiveGuard(this.#db, 'writeAllowed', true, () => (
            withArchiveGuard(this.#db, 'destructiveAllowed', destructive, () => callback(operationId))
          ));
        } finally {
          this.#activeOperationId = null;
        }
        if (result && typeof result.then === 'function') {
          throw new Error('Archive database operations must be synchronous inside a transaction.');
        }
        after = this.getArchiveCounts();
        if (
          !destructive
          && (after.conversations < before.conversations || after.messages < before.messages)
        ) {
          throw new Error(
            `Non-destructive archive operation ${operationType} attempted to reduce stored content `
            + `(conversations ${before.conversations}->${after.conversations}, messages ${before.messages}->${after.messages}).`
          );
        }
        withArchiveGuard(this.#db, 'writeAllowed', true, () => this.#db.prepare(`
            INSERT INTO archive_audit_log (
              operation_id, operation_type, actor, action, entity_type, entity_id, reason, details_json,
              writer_component, writer_instance_id, store_instance_id, store_generation,
              transaction_id, actor_trust, reason_code, outcome, recorder
            ) VALUES (?, ?, ?, 'operation-completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', 'archive-api')
          `).run(
          operationId,
          operationType,
          actor,
          entityType,
          entityId,
          reason,
          JSON.stringify({ before, after, ...(metadata?.details || {}) }),
          writerComponent,
          writerInstanceId,
          this.storeInstanceId,
          this.storeGeneration,
          operationId,
          actorTrust,
          reasonCode
        ));
        withArchiveGuard(this.#db, 'contextWriteAllowed', true, () => this.#db.prepare(`
            UPDATE archive_operation_context
            SET operation_id = NULL, operation_type = NULL, actor = NULL, reason = NULL,
                started_at = NULL, destructive_allowed = 0, writer_component = NULL,
                writer_instance_id = NULL, store_instance_id = NULL, store_generation = NULL,
                transaction_id = NULL, actor_trust = 'unknown', reason_code = NULL
            WHERE singleton = 1
          `).run());
        return result;
      });
      const result = execute();
      try {
        this.auditJournal.append({
          action: 'operation-completed',
          operation_id: operationId,
          operation_type: operationType,
          actor,
          reason,
          database_path: this.#dbPath,
          entity_type: entityType,
          entity_id: entityId,
          destructive,
          before,
          after,
          event_schema: 'aibackman-audit-event-v1',
          writer_component: writerComponent,
          writer_instance_id: writerInstanceId,
          store_instance_id: this.storeInstanceId,
          store_generation: this.storeGeneration,
          transaction_id: operationId,
          reason_code: reasonCode,
          details: metadata?.details || null,
        });
      } catch (journalError) {
        console.error('The external archive audit journal could not record operation completion:', journalError);
      }
      this.diagnostics?.taskEnd(taskId, { state: 'completed', operationId, after });
      return result;
    } catch (error) {
      try {
        this.auditJournal.append({
          action: 'operation-failed',
          operation_id: operationId,
          operation_type: operationType,
          actor,
          reason,
          database_path: this.#dbPath,
          entity_type: entityType,
          entity_id: entityId,
          destructive,
          before,
          event_schema: 'aibackman-audit-event-v1',
          writer_component: writerComponent,
          writer_instance_id: writerInstanceId,
          store_instance_id: this.storeInstanceId,
          store_generation: this.storeGeneration,
          transaction_id: operationId,
          reason_code: reasonCode,
          error: String(error?.stack || error),
        });
      } catch (journalError) {
        console.error('The external archive audit journal could not record operation failure:', journalError);
      }
      this.diagnostics?.taskEnd(taskId, { error, operationId });
      throw error;
    }
  }

  recordSafetyEvent(action, entityType, entityId, details = {}) {
    if (!this.#activeOperationId) {
      return this.runArchiveOperation({
        type: 'record-safety-event',
        actor: 'archive-safety-runtime',
        reason: String(action),
        reasonCode: String(action),
        writerComponent: 'archive-database-api',
        entityType,
        entityId,
        details,
      }, () => this.recordSafetyEvent(action, entityType, entityId, details));
    }
    const context = this.#db.prepare(`
      SELECT operation_id, operation_type, actor, reason, writer_component, writer_instance_id,
             store_instance_id, store_generation, transaction_id, actor_trust, reason_code
      FROM archive_operation_context WHERE singleton = 1
    `).get() || {};
    this.#db.prepare(`
      INSERT INTO archive_audit_log (
        operation_id, operation_type, actor, action, entity_type, entity_id, reason, details_json,
        writer_component, writer_instance_id, store_instance_id, store_generation,
        transaction_id, actor_trust, reason_code, recorder
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'archive-api')
    `).run(
      context.operation_id || crypto.randomUUID(),
      context.operation_type || 'unscoped-safety-event',
      context.actor || 'aibackman',
      action,
      entityType,
      entityId == null ? null : String(entityId),
      context.reason || action,
      JSON.stringify(details),
      context.writer_component || 'archive-database-api',
      context.writer_instance_id || this.databaseInstanceId,
      context.store_instance_id || this.storeInstanceId,
      context.store_generation || this.storeGeneration,
      context.transaction_id || null,
      context.actor_trust || 'asserted-in-process',
      context.reason_code || action
    );
  }

  createRecoverySnapshot(reason, { force = false, operationId } = {}) {
    this.searchWorker.stop();
    const snapshot = this.recoveryManager.createDatabaseSnapshot({
      sqlite: this.#db,
      dbPath: this.#dbPath,
      reason,
      operationId,
      force,
    });
    if (snapshot) {
      this.recordSafetyEvent('database-snapshot-created', 'database', this.#dbPath, {
        reason,
        recoveryPath: snapshot.snapshot_database,
        sizeBytes: snapshot.size_bytes,
      });
    }
    return snapshot;
  }

  getAuditTrail(limit = 500) {
    const boundedLimit = Math.max(1, Math.min(5000, Number(limit) || 500));
    return this.#db.prepare(`
      SELECT * FROM archive_audit_log ORDER BY sequence DESC LIMIT ?
    `).all(boundedLimit);
  }

  getRecoveryRecords(entityType, entityId, limit = 5000) {
    return this.#db.prepare(`
      SELECT *
      FROM archive_recovery_records
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY sequence DESC
      LIMIT ?
    `).all(String(entityType), String(entityId), Math.max(1, Math.min(10000, Number(limit) || 5000)));
  }

  getArchiveOperationContext() {
    return this.#db.prepare(`
      SELECT operation_id, operation_type, actor, reason, destructive_allowed,
             writer_component, writer_instance_id, store_instance_id,
             store_generation, transaction_id, actor_trust, reason_code
      FROM archive_operation_context
      WHERE singleton = 1
    `).get() || null;
  }

  getSafetyStatus() {
    return {
      schemaVersion: Number(this.#db.pragma('user_version', { simple: true }) || 0),
      triggerCount: Number(this.#db.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'archive_%'
      `).get()?.count || 0),
      expectedTriggerCount: ARCHIVE_SAFETY_TRIGGER_COUNT,
      auditRows: Number(this.#db.prepare('SELECT COUNT(*) AS count FROM archive_audit_log').get()?.count || 0),
      recoveryRows: Number(this.#db.prepare('SELECT COUNT(*) AS count FROM archive_recovery_records').get()?.count || 0),
      storeInstanceId: this.storeInstanceId,
      storeGeneration: this.storeGeneration,
    };
  }

  getConversations() {
    return this.#db.prepare(`
      WITH message_recency AS (
        SELECT
          conversation_id,
          MAX(
            CASE
              WHEN typeof(created_at) IN ('integer', 'real') THEN CAST(created_at AS REAL)
              WHEN created_at IS NULL THEN NULL
              WHEN instr(CAST(created_at AS TEXT), '-') = 0
                AND instr(CAST(created_at AS TEXT), 'T') = 0
                AND instr(CAST(created_at AS TEXT), ':') = 0
              THEN CAST(created_at AS REAL)
              ELSE (julianday(created_at) - 2440587.5) * 86400.0
            END
          ) AS last_message_at,
          COUNT(*) AS message_count
        FROM messages
        GROUP BY conversation_id
      )
      SELECT
        conversations.*,
        message_recency.last_message_at,
        COALESCE(message_recency.message_count, 0) AS message_count
      FROM conversations
      LEFT JOIN message_recency ON message_recency.conversation_id = conversations.id
      ORDER BY
        COALESCE(
          message_recency.last_message_at,
          CASE
            WHEN typeof(conversations.updated_at) IN ('integer', 'real') THEN CAST(conversations.updated_at AS REAL)
            WHEN conversations.updated_at IS NULL THEN NULL
            WHEN instr(CAST(conversations.updated_at AS TEXT), '-') = 0
              AND instr(CAST(conversations.updated_at AS TEXT), 'T') = 0
              AND instr(CAST(conversations.updated_at AS TEXT), ':') = 0
            THEN CAST(conversations.updated_at AS REAL)
            ELSE (julianday(conversations.updated_at) - 2440587.5) * 86400.0
          END
        ) DESC,
        CASE
          WHEN typeof(conversations.created_at) IN ('integer', 'real') THEN CAST(conversations.created_at AS REAL)
          WHEN conversations.created_at IS NULL THEN NULL
          WHEN instr(CAST(conversations.created_at AS TEXT), '-') = 0
            AND instr(CAST(conversations.created_at AS TEXT), 'T') = 0
            AND instr(CAST(conversations.created_at AS TEXT), ':') = 0
          THEN CAST(conversations.created_at AS REAL)
          ELSE (julianday(conversations.created_at) - 2440587.5) * 86400.0
        END DESC,
        conversations.id
    `).all();
  }

  getConversation(id) {
    return this.#db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }

  getMessages(conversationId) {
    return this.#db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC').all(conversationId);
  }

  getMessage(id) {
    return this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(id) || null;
  }

  countMessages(conversationId) {
    return Number(this.#db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get(conversationId)?.count || 0);
  }

  hasMessages(conversationId) {
    return Boolean(this.#db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1').get(conversationId));
  }

  hasAssistantMessagesMissingModelMetadata(conversationId) {
    return Boolean(this.#db.prepare(`
      SELECT 1
      FROM messages
      WHERE conversation_id = ?
        AND role = 'assistant'
        AND length(trim(content)) > 0
        AND (
          metadata_json IS NULL
          OR NOT (
            metadata_json LIKE '%"model"%'
            OR metadata_json LIKE '%"model_slug"%'
            OR metadata_json LIKE '%"default_model_slug"%'
            OR metadata_json LIKE '%"requested_model_slug"%'
          )
        )
      LIMIT 1
    `).get(conversationId));
  }

  updateMessageMetadata(messageId, metadataJson) {
    const id = String(messageId || '').trim();
    if (!id) return false;
    return this.runArchiveOperation({
      type: 'update-message-metadata',
      actor: 'standard-archive-writer',
      reason: 'Update provider metadata while retaining the complete previous message revision.',
      entityType: 'message',
      entityId: id,
    }, () => {
      this.#db.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?').run(metadataJson, id);
      return true;
    });
  }

  getLinearPath(currentNodeId) {
    return this.#db.prepare(`
      WITH RECURSIVE chat_path(id, conversation_id, role, content, metadata_json, created_at, parent_id, depth) AS (
        SELECT id, conversation_id, role, content, metadata_json, created_at, parent_id, 0
        FROM messages
        WHERE id = ?
        UNION ALL
        SELECT m.id, m.conversation_id, m.role, m.content, m.metadata_json, m.created_at, m.parent_id, cp.depth + 1
        FROM messages m
        JOIN chat_path cp ON m.id = cp.parent_id AND m.conversation_id = cp.conversation_id
      )
      SELECT id, conversation_id, role, content, metadata_json, created_at, parent_id
      FROM chat_path
      ORDER BY depth DESC
    `).all(currentNodeId);
  }

  upsertConversation(conv) {
    return this.runArchiveOperation({
      type: 'upsert-conversation',
      actor: 'archive-database-api',
      reason: 'Insert or merge one normalized conversation row.',
      entityType: 'conversation',
      entityId: conv.id,
    }, () => {
      const stmt = this.#db.prepare(`
        INSERT INTO conversations (id, title, created_at, updated_at, last_synced_updated_at, current_node_id, cache_format_version, is_deleted_on_web)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = COALESCE(NULLIF(excluded.title, ''), conversations.title),
          created_at = COALESCE(excluded.created_at, conversations.created_at),
          updated_at = COALESCE(excluded.updated_at, conversations.updated_at),
          last_synced_updated_at = COALESCE(excluded.last_synced_updated_at, conversations.last_synced_updated_at),
          current_node_id = COALESCE(excluded.current_node_id, conversations.current_node_id),
          cache_format_version = COALESCE(excluded.cache_format_version, conversations.cache_format_version),
          is_deleted_on_web = excluded.is_deleted_on_web
      `);
      return stmt.run(
        conv.id,
        conv.title,
        conv.created_at,
        conv.updated_at,
        conv.last_synced_updated_at ?? null,
        conv.current_node_id,
        conv.cache_format_version ?? null,
        conv.is_deleted_on_web || 0
      );
    });
  }

  markAsDeletedOnWeb(id) {
    return this.runArchiveOperation({
      type: 'mark-conversation-deleted-on-web',
      actor: 'remote-deletion-audit',
      reason: 'The provider no longer returned this conversation; preserve it locally.',
      entityType: 'conversation',
      entityId: id,
    }, () => this.#db.prepare('UPDATE conversations SET is_deleted_on_web = 1 WHERE id = ?').run(id));
  }

  deleteConversation(id, { confirmation, reason, actor = 'user' } = {}) {
    if (String(confirmation || '') !== String(id)) {
      this.auditJournal.append({
        action: 'destructive-operation-blocked',
        operation_type: 'delete-conversation',
        actor,
        database_path: this.#dbPath,
        entity_type: 'conversation',
        entity_id: id,
        reason: 'The exact conversation id was not confirmed.',
      });
      throw new Error('Conversation deletion was blocked: the exact conversation id was not confirmed.');
    }
    if (!String(reason || '').trim()) {
      this.auditJournal.append({
        action: 'destructive-operation-blocked',
        operation_type: 'delete-conversation',
        actor,
        database_path: this.#dbPath,
        entity_type: 'conversation',
        entity_id: id,
        reason: 'No audit reason was supplied.',
      });
      throw new Error('Conversation deletion was blocked: an audit reason is required.');
    }
    const conversation = this.getConversation(id);
    if (!conversation) return { success: false, deleted: false, conversationId: id };
    const deleteFailure = this.#db.prepare('DELETE FROM cache_failures WHERE conversation_id = ?');
    const deleteMsgs = this.#db.prepare('DELETE FROM messages WHERE conversation_id = ?');
    const deleteConv = this.#db.prepare('DELETE FROM conversations WHERE id = ?');

    return this.runArchiveOperation({
      type: 'delete-conversation',
      actor,
      reason,
      entityType: 'conversation',
      entityId: id,
      destructive: true,
      destructiveCapability: DESTRUCTIVE_ARCHIVE_CAPABILITY,
      details: { title: conversation.title },
    }, (operationId) => {
      deleteFailure.run(id);
      const deletedMessages = deleteMsgs.run(id).changes;
      const deletedConversation = deleteConv.run(id).changes;
      return {
        success: deletedConversation === 1,
        deleted: deletedConversation === 1,
        conversationId: id,
        deletedMessages,
        recoveryOperationId: operationId,
      };
    });
  }

  clearAll({ confirmation, reason, actor = 'maintenance' } = {}) {
    if (confirmation !== 'CLEAR ENTIRE ARCHIVE') {
      this.auditJournal.append({
        action: 'destructive-operation-blocked',
        operation_type: 'clear-entire-archive',
        actor,
        database_path: this.#dbPath,
        reason: 'The full-archive confirmation phrase was not supplied.',
      });
      throw new Error('Archive clearing was blocked: explicit full-archive confirmation is required.');
    }
    if (!String(reason || '').trim()) {
      this.auditJournal.append({
        action: 'destructive-operation-blocked',
        operation_type: 'clear-entire-archive',
        actor,
        database_path: this.#dbPath,
        reason: 'No audit reason was supplied.',
      });
      throw new Error('Archive clearing was blocked: an audit reason is required.');
    }
    const operationId = crypto.randomUUID();
    const snapshot = this.createRecoverySnapshot('before-clear-entire-archive', {
      force: true,
      operationId,
    });
    return this.runArchiveOperation({
      operationId,
      type: 'clear-entire-archive',
      actor,
      reason,
      destructive: true,
      destructiveCapability: DESTRUCTIVE_ARCHIVE_CAPABILITY,
      details: { recoveryPath: snapshot?.snapshot_database || null },
    }, () => {
      this.#db.prepare('DELETE FROM cache_failures').run();
      this.#db.prepare('DELETE FROM messages').run();
      this.#db.prepare('DELETE FROM conversations').run();
      this.#db.prepare('DELETE FROM source_items').run();
      return { success: true, recoveryPath: snapshot?.snapshot_database || null };
    });
  }

  getStats() {
    const row = this.#db.prepare(`
      WITH eligible_messages AS (
        SELECT
          m.conversation_id,
          m.role,
          m.created_at,
          m.id,
          COALESCE(json_extract(m.metadata_json, '$.source'), '') AS source,
          COALESCE(json_extract(m.metadata_json, '$.phase'), '') AS phase
        FROM messages AS m
        JOIN conversations AS c ON c.id = m.conversation_id
        WHERE IFNULL(c.is_deleted_on_web, 0) = 0
          AND m.role IN ('user', 'assistant')
          AND trim(COALESCE(m.content, '')) <> ''
          AND COALESCE(json_extract(m.metadata_json, '$.is_thinking_preamble_message'), 0) != 1
          AND COALESCE(json_extract(m.metadata_json, '$.is_visually_hidden_from_conversation'), 0) != 1
      ),
      ordered_messages AS (
        SELECT
          eligible_messages.*,
          LAG(role) OVER (
            PARTITION BY conversation_id
            ORDER BY created_at, id
          ) AS previous_role
        FROM eligible_messages
      ),
      codex_runs AS (
        SELECT
          ordered_messages.*,
          SUM(
            CASE
              WHEN role = 'assistant'
                AND source IN ('codex-local', 'gemini-cli-local')
                AND COALESCE(previous_role, '') != 'assistant'
              THEN 1
              ELSE 0
            END
          ) OVER (
            PARTITION BY conversation_id
            ORDER BY created_at, id
            ROWS UNBOUNDED PRECEDING
          ) AS assistant_run
        FROM ordered_messages
      ),
      codex_responses AS (
        SELECT conversation_id, assistant_run
        FROM codex_runs
        WHERE role = 'assistant' AND source IN ('codex-local', 'gemini-cli-local')
        GROUP BY conversation_id, assistant_run
        HAVING MAX(CASE WHEN phase != 'commentary' THEN 1 ELSE 0 END) = 1
      )
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE IFNULL(is_deleted_on_web, 0) = 0) AS conversation_count,
        -- Keep internal/tool rows and Codex commentary fragments available for
        -- rendering, but do not present them as separate archive messages. A
        -- local agent response may contain several consecutive stream events,
        -- so count that run once.
        (
          SELECT COUNT(*)
          FROM eligible_messages
          WHERE NOT (
            role = 'assistant'
            AND source IN ('codex-local', 'gemini-cli-local')
          )
        ) + (SELECT COUNT(*) FROM codex_responses) AS message_count,
        (SELECT COUNT(DISTINCT conversation_id) FROM messages) AS cached_count,
        (
          SELECT MAX(
            CASE
              WHEN typeof(updated_at) IN ('integer', 'real') THEN CAST(updated_at AS REAL)
              WHEN updated_at IS NULL THEN NULL
              WHEN instr(CAST(updated_at AS TEXT), '-') = 0
                AND instr(CAST(updated_at AS TEXT), 'T') = 0
                AND instr(CAST(updated_at AS TEXT), ':') = 0
              THEN CAST(updated_at AS REAL)
              ELSE (julianday(updated_at) - 2440587.5) * 86400.0
            END
          )
          FROM conversations
        ) AS latest_updated_at
    `).get();
    return {
      conversationCount: Number(row?.conversation_count || 0),
      messageCount: Number(row?.message_count || 0),
      cachedCount: Number(row?.cached_count || 0),
      latestUpdatedAt: row?.latest_updated_at == null ? null : Number(row.latest_updated_at),
    };
  }

  getSourceItem(sourceKey) {
    return this.#db.prepare('SELECT * FROM source_items WHERE source_key = ?').get(sourceKey) || null;
  }

  upsertSourceItem({ sourceKey, sourcePath, fingerprint, metadata = null }) {
    return this.runArchiveOperation({
      type: 'upsert-source-item',
      actor: 'source-importer',
      reason: 'Record the source fingerprint used to populate the archive.',
      reasonCode: 'source-fingerprint-write',
      writerComponent: 'standard-archive-writer',
      entityType: 'source-item',
      entityId: sourceKey,
      details: { sourcePath, fingerprint },
    }, () => this.#db.prepare(`
      INSERT INTO source_items (source_key, source_path, fingerprint, imported_at, metadata_json)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        source_path = excluded.source_path,
        fingerprint = excluded.fingerprint,
        imported_at = CURRENT_TIMESTAMP,
        metadata_json = excluded.metadata_json
    `).run(sourceKey, sourcePath, fingerprint, metadata == null ? null : JSON.stringify(metadata)));
  }

  importConversationSnapshot(conversation, messages, { replaceMessages = false } = {}) {
    const incomingMessages = Array.isArray(messages) ? messages : [];
    return this.runArchiveOperation({
      type: 'merge-conversation-snapshot',
      actor: 'standard-archive-writer',
      reason: 'Merge a provider snapshot without removing previously cached messages.',
      entityType: 'conversation',
      entityId: conversation.id,
      details: { incomingMessages: incomingMessages.length, replacementRequested: !!replaceMessages },
    }, () => {
      const existingMessageIds = new Set(this.#db.prepare(`
        SELECT id FROM messages WHERE conversation_id = ?
      `).all(conversation.id).map((row) => row.id));
      const incomingMessageIds = new Set(incomingMessages.map((message) => message.id));
      const preservedMessageIds = [...existingMessageIds].filter((id) => !incomingMessageIds.has(id));

      this.upsertConversation(conversation);
      if (replaceMessages && preservedMessageIds.length > 0) {
        this.recordSafetyEvent('destructive-message-replacement-blocked', 'conversation', conversation.id, {
          preservedMessageCount: preservedMessageIds.length,
          incomingMessageCount: incomingMessages.length,
          samplePreservedMessageIds: preservedMessageIds.slice(0, 20),
        });
      }
      for (const message of incomingMessages) this.upsertMessage(message);
      this.upsertConversation(conversation);
      return {
        importedMessages: incomingMessages.length,
        preservedMessages: preservedMessageIds.length,
        replacementPrevented: !!replaceMessages && preservedMessageIds.length > 0,
      };
    });
  }

  restoreDeletedConversation(id) {
    if (this.getConversation(id)) {
      throw new Error('Conversation restore was blocked because a live row with that id already exists.');
    }
    const deletedConversation = this.#db.prepare(`
      SELECT *
      FROM archive_recovery_records
      WHERE entity_type = 'conversation' AND entity_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(id);
    if (!deletedConversation) throw new Error('No recoverable deletion was found for this conversation.');

    const conversation = JSON.parse(deletedConversation.payload_json);
    const messages = this.#db.prepare(`
      SELECT payload_json
      FROM archive_recovery_records
      WHERE operation_id = ? AND entity_type = 'message'
      ORDER BY sequence
    `).all(deletedConversation.operation_id)
      .map((row) => JSON.parse(row.payload_json))
      .filter((message) => message.conversation_id === id);

    return this.runArchiveOperation({
      type: 'restore-deleted-conversation',
      actor: 'user',
      reason: 'Restore a conversation from immutable recovery records.',
      entityType: 'conversation',
      entityId: id,
      details: { recoveryOperationId: deletedConversation.operation_id, messageCount: messages.length },
    }, () => {
      this.upsertConversation(conversation);
      for (const message of messages) this.upsertMessage(message);
      return { success: true, conversationId: id, restoredMessages: messages.length };
    });
  }

  restoreMessageRevision(id, { sequence = null, confirmation, reason, actor = 'user' } = {}) {
    if (String(confirmation || '') !== String(id)) {
      throw new Error('Message revision restore was blocked: the exact message id was not confirmed.');
    }
    if (!String(reason || '').trim()) {
      throw new Error('Message revision restore was blocked: an audit reason is required.');
    }
    if (!this.getMessage(id)) {
      throw new Error('Message revision restore was blocked because the live message no longer exists.');
    }
    const revision = sequence == null
      ? this.#db.prepare(`
          SELECT * FROM archive_recovery_records
          WHERE entity_type = 'message-revision' AND entity_id = ?
          ORDER BY sequence DESC LIMIT 1
        `).get(id)
      : this.#db.prepare(`
          SELECT * FROM archive_recovery_records
          WHERE entity_type = 'message-revision' AND entity_id = ? AND sequence = ?
        `).get(id, Number(sequence));
    if (!revision) throw new Error('No recoverable message revision was found.');
    const previous = JSON.parse(revision.payload_json);
    return this.runArchiveOperation({
      type: 'restore-message-revision',
      actor,
      reason,
      entityType: 'message',
      entityId: id,
      details: { recoverySequence: revision.sequence, recoveryOperationId: revision.operation_id },
    }, () => {
      this.upsertMessage(previous);
      return { success: true, messageId: id, recoverySequence: revision.sequence };
    });
  }

  restoreConversationRevision(id, { sequence = null, confirmation, reason, actor = 'user' } = {}) {
    if (String(confirmation || '') !== String(id)) {
      throw new Error('Conversation revision restore was blocked: the exact conversation id was not confirmed.');
    }
    if (!String(reason || '').trim()) {
      throw new Error('Conversation revision restore was blocked: an audit reason is required.');
    }
    if (!this.getConversation(id)) {
      throw new Error('Conversation revision restore was blocked because the live conversation no longer exists.');
    }
    const revision = sequence == null
      ? this.#db.prepare(`
          SELECT * FROM archive_recovery_records
          WHERE entity_type = 'conversation-revision' AND entity_id = ?
          ORDER BY sequence DESC LIMIT 1
        `).get(id)
      : this.#db.prepare(`
          SELECT * FROM archive_recovery_records
          WHERE sequence = ? AND entity_type = 'conversation-revision' AND entity_id = ?
        `).get(Number(sequence), id);
    if (!revision) throw new Error('No recoverable conversation revision was found.');
    const previous = JSON.parse(revision.payload_json);
    if (previous.id !== id) throw new Error('Conversation recovery identity mismatch.');
    return this.runArchiveOperation({
      type: 'restore-conversation-revision',
      actor,
      reason,
      reasonCode: 'explicit-conversation-revision-restore',
      entityType: 'conversation',
      entityId: id,
      details: { recoverySequence: revision.sequence, recoveryOperationId: revision.operation_id },
    }, () => {
      const result = this.#db.prepare(`
        UPDATE conversations
        SET title = ?, created_at = ?, updated_at = ?, last_synced_updated_at = ?,
            current_node_id = ?, cache_format_version = ?, is_deleted_on_web = ?
        WHERE id = ?
      `).run(
        previous.title,
        previous.created_at,
        previous.updated_at,
        previous.last_synced_updated_at,
        previous.current_node_id,
        previous.cache_format_version,
        previous.is_deleted_on_web,
        id
      );
      if (result.changes !== 1) throw new Error('Conversation revision restore target no longer exists.');
      return { success: true, conversationId: id, recoverySequence: revision.sequence };
    });
  }

  restoreSourceItemRevision(sourceKey, { sequence = null, confirmation, reason, actor = 'user' } = {}) {
    if (String(confirmation || '') !== String(sourceKey)) {
      throw new Error('Source-item revision restore was blocked: the exact source key was not confirmed.');
    }
    if (!String(reason || '').trim()) {
      throw new Error('Source-item revision restore was blocked: an audit reason is required.');
    }
    const revision = sequence == null
      ? this.#db.prepare(`
          SELECT * FROM archive_recovery_records
          WHERE entity_type IN ('source-item-revision', 'source-item') AND entity_id = ?
          ORDER BY sequence DESC LIMIT 1
        `).get(sourceKey)
      : this.#db.prepare(`
          SELECT * FROM archive_recovery_records
          WHERE sequence = ? AND entity_type IN ('source-item-revision', 'source-item') AND entity_id = ?
        `).get(Number(sequence), sourceKey);
    if (!revision) throw new Error('No recoverable source-item revision was found.');
    const previous = JSON.parse(revision.payload_json);
    if (previous.source_key !== sourceKey) throw new Error('Source-item recovery identity mismatch.');
    return this.runArchiveOperation({
      type: 'restore-source-item-revision',
      actor,
      reason,
      reasonCode: 'explicit-source-item-revision-restore',
      entityType: 'source-item',
      entityId: sourceKey,
      details: { recoverySequence: revision.sequence, recoveryOperationId: revision.operation_id },
    }, () => {
      this.#db.prepare(`
        INSERT INTO source_items (source_key, source_path, fingerprint, imported_at, metadata_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          source_path = excluded.source_path,
          fingerprint = excluded.fingerprint,
          imported_at = excluded.imported_at,
          metadata_json = excluded.metadata_json
      `).run(
        previous.source_key,
        previous.source_path,
        previous.fingerprint,
        previous.imported_at,
        previous.metadata_json
      );
      return { success: true, sourceKey, recoverySequence: revision.sequence };
    });
  }

  close() {
    this.searchWorker.stop();
    this.diagnostics?.resourceClose(this.#diagnosticResourceId, {
      type: 'sqlite-database',
      database_instance_id: this.databaseInstanceId,
    });
    this.#diagnosticResourceId = null;
    this.#db.close();
  }

  upsertMessage(msg) {
    return this.runArchiveOperation({
      type: 'upsert-message',
      actor: 'archive-database-api',
      reason: 'Insert or merge one normalized message row with revision recovery.',
      entityType: 'message',
      entityId: msg.id,
    }, () => {
      const stmt = this.#db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at, parent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        role = COALESCE(NULLIF(excluded.role, ''), messages.role),
        content = CASE
          WHEN trim(COALESCE(excluded.content, '')) = ''
            AND trim(COALESCE(messages.content, '')) != ''
            AND COALESCE(excluded.role, messages.role) != 'tool'
            AND COALESCE(
              CASE WHEN json_valid(excluded.metadata_json)
                THEN json_extract(excluded.metadata_json, '$.chatgpt_internal_protocol') END,
              0
            ) != 1
            AND COALESCE(
              CASE WHEN json_valid(excluded.metadata_json)
                THEN json_extract(excluded.metadata_json, '$.is_visually_hidden_from_conversation') END,
              0
            ) != 1
            AND COALESCE(
              CASE WHEN json_valid(excluded.metadata_json)
                THEN json_extract(excluded.metadata_json, '$.is_thinking_preamble_message') END,
              0
            ) != 1
          THEN messages.content
          ELSE excluded.content
        END,
        metadata_json = COALESCE(excluded.metadata_json, messages.metadata_json),
        created_at = COALESCE(excluded.created_at, messages.created_at),
        parent_id = COALESCE(excluded.parent_id, messages.parent_id)
    `);
      return stmt.run(
        msg.id,
        msg.conversation_id,
        msg.role,
        msg.content,
        msg.metadata_json ?? null,
        msg.created_at,
        msg.parent_id
      );
    });
  }

  async searchMessages(query) {
    const trimmed = String(query || '').trim();
    if (!trimmed) {
      return { total: 0, results: [] };
    }

    try {
      return await this.searchWorker.search(trimmed, 100);
    } catch (error) {
      console.warn('db-search helper failed, falling back to LIKE search:', error);
      const results = this.#db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.content, c.title as conversation_title
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        WHERE m.content LIKE ?
          AND m.role IN ('user', 'assistant')
        ORDER BY m.created_at DESC
        LIMIT 100
      `).all(`%${trimmed}%`);
      const total = this.#db.prepare(`
        SELECT COUNT(*) as count
        FROM messages m
        WHERE m.content LIKE ?
          AND m.role IN ('user', 'assistant')
      `).get(`%${trimmed}%`)?.count || results.length;
      return { total, total_is_lower_bound: false, results };
    }
  }

  upsertCacheFailure(conversationId, errorMessage, statusCode = null) {
    const stmt = this.#db.prepare(`
      INSERT INTO cache_failures (conversation_id, last_error, status_code, last_attempt_at, attempt_count)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, 1)
      ON CONFLICT(conversation_id) DO UPDATE SET
        last_error = excluded.last_error,
        status_code = excluded.status_code,
        last_attempt_at = CURRENT_TIMESTAMP,
        attempt_count = cache_failures.attempt_count + 1
    `);
    stmt.run(conversationId, errorMessage || 'Unknown cache failure', statusCode);
  }

  clearCacheFailure(conversationId) {
    this.#db.prepare('DELETE FROM cache_failures WHERE conversation_id = ?').run(conversationId);
  }

  getCacheDiagnostics(limit = 50) {
    const summary = this.#db.prepare(`
      WITH conv AS (
        SELECT id, updated_at, last_synced_updated_at, cache_format_version
        FROM conversations
        WHERE IFNULL(is_deleted_on_web, 0) = 0
      ),
      cached AS (
        SELECT DISTINCT conversation_id AS id FROM messages
      ),
      uncached AS (
        SELECT conv.id
        FROM conv
        LEFT JOIN cached ON cached.id = conv.id
        WHERE cached.id IS NULL
          AND conv.updated_at IS NOT NULL
          AND conv.last_synced_updated_at IS NULL
      ),
      new_messages AS (
        SELECT conv.id
        FROM conv
        JOIN cached ON cached.id = conv.id
        WHERE conv.cache_format_version = ${STANDARD_CACHE_FORMAT_VERSION}
          AND conv.updated_at IS NOT NULL
          AND conv.last_synced_updated_at IS NOT NULL
          AND conv.updated_at != conv.last_synced_updated_at
          AND (
            (
              typeof(conv.updated_at) IN ('integer', 'real')
              AND typeof(conv.last_synced_updated_at) IN ('integer', 'real')
            )
            OR (
              typeof(conv.updated_at) NOT IN ('integer', 'real')
              AND typeof(conv.last_synced_updated_at) NOT IN ('integer', 'real')
            )
          )
      ),
      resync AS (
        SELECT conv.id
        FROM conv
        LEFT JOIN cached ON cached.id = conv.id
        WHERE (
          cached.id IS NOT NULL
          AND (
            conv.cache_format_version IS NULL
            OR conv.cache_format_version != ${STANDARD_CACHE_FORMAT_VERSION}
            OR conv.updated_at IS NULL
            OR conv.last_synced_updated_at IS NULL
            OR (
              conv.updated_at != conv.last_synced_updated_at
              AND NOT (
                (
                  typeof(conv.updated_at) IN ('integer', 'real')
                  AND typeof(conv.last_synced_updated_at) IN ('integer', 'real')
                )
                OR (
                  typeof(conv.updated_at) NOT IN ('integer', 'real')
                  AND typeof(conv.last_synced_updated_at) NOT IN ('integer', 'real')
                )
              )
            )
          )
        )
        OR (
          cached.id IS NULL
          AND (
            conv.updated_at IS NULL
            OR conv.last_synced_updated_at IS NOT NULL
          )
        )
      )
      SELECT
        (SELECT COUNT(*) FROM conv) AS local_count,
        (SELECT COUNT(*) FROM conv JOIN cached ON cached.id = conv.id) AS cached_count,
        (SELECT COUNT(*) FROM uncached) AS uncached_count,
        (
          SELECT COUNT(*)
          FROM (
            SELECT id FROM uncached
            UNION
            SELECT id FROM resync
          ) dirty
          JOIN cache_failures cf ON cf.conversation_id = dirty.id
        ) AS failed_count,
        (
          SELECT COUNT(*)
          FROM uncached
          JOIN cache_failures cf ON cf.conversation_id = uncached.id
        ) AS failed_uncached_count,
        (SELECT COUNT(*) FROM new_messages) AS new_messages_count,
        (SELECT COUNT(*) FROM resync) AS resync_count
    `).get();

    const uncachedRows = this.#db.prepare(`
      SELECT
        c.id,
        c.title,
        c.updated_at,
        cf.last_error,
        cf.status_code,
        cf.last_attempt_at,
        cf.attempt_count
      FROM conversations c
      LEFT JOIN cache_failures cf ON cf.conversation_id = c.id
      WHERE IFNULL(c.is_deleted_on_web, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.conversation_id = c.id
        )
        AND c.updated_at IS NOT NULL
        AND c.last_synced_updated_at IS NULL
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(limit);

    const newMessageRows = this.#db.prepare(`
      SELECT
        c.id,
        c.title,
        c.updated_at,
        c.last_synced_updated_at
      FROM conversations c
        WHERE IFNULL(c.is_deleted_on_web, 0) = 0
        AND EXISTS (
          SELECT 1 FROM messages m WHERE m.conversation_id = c.id
        )
        AND c.cache_format_version = ${STANDARD_CACHE_FORMAT_VERSION}
        AND c.updated_at IS NOT NULL
        AND c.last_synced_updated_at IS NOT NULL
        AND c.updated_at != c.last_synced_updated_at
        AND (
          (
            typeof(c.updated_at) IN ('integer', 'real')
            AND typeof(c.last_synced_updated_at) IN ('integer', 'real')
          )
          OR (
            typeof(c.updated_at) NOT IN ('integer', 'real')
            AND typeof(c.last_synced_updated_at) NOT IN ('integer', 'real')
          )
        )
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(limit);

    const resyncRows = this.#db.prepare(`
      SELECT
        c.id,
        c.title,
        c.updated_at,
        c.last_synced_updated_at,
        c.cache_format_version,
        cf.last_error,
        cf.status_code,
        cf.last_attempt_at,
        cf.attempt_count,
        EXISTS (
          SELECT 1 FROM messages m WHERE m.conversation_id = c.id
        ) AS has_messages
      FROM conversations c
      LEFT JOIN cache_failures cf ON cf.conversation_id = c.id
      WHERE IFNULL(c.is_deleted_on_web, 0) = 0
        AND (
          (
            EXISTS (
              SELECT 1 FROM messages m WHERE m.conversation_id = c.id
            )
            AND (
              c.cache_format_version IS NULL
              OR c.cache_format_version != ${STANDARD_CACHE_FORMAT_VERSION}
              OR c.updated_at IS NULL
              OR c.last_synced_updated_at IS NULL
              OR (
                c.updated_at != c.last_synced_updated_at
                AND NOT (
                  (
                    typeof(c.updated_at) IN ('integer', 'real')
                    AND typeof(c.last_synced_updated_at) IN ('integer', 'real')
                  )
                  OR (
                    typeof(c.updated_at) NOT IN ('integer', 'real')
                    AND typeof(c.last_synced_updated_at) NOT IN ('integer', 'real')
                  )
                )
              )
            )
          )
          OR (
            NOT EXISTS (
              SELECT 1 FROM messages m WHERE m.conversation_id = c.id
            )
            AND (
              c.updated_at IS NULL
              OR c.last_synced_updated_at IS NOT NULL
            )
          )
        )
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(limit);

    const failedCount = Number(summary.failed_count || 0);
    const failedUncachedCount = Number(summary.failed_uncached_count || 0);
    const uncachedCount = Number(summary.uncached_count || 0);
    const newMessagesCount = Number(summary.new_messages_count || 0);
    const resyncCount = Number(summary.resync_count || 0);
    return {
      localCount: Number(summary.local_count || 0),
      cachedCount: Number(summary.cached_count || 0),
      uncachedCount,
      failedCount,
      newMessagesCount,
      resyncCount,
      dirtyCount: newMessagesCount + resyncCount,
      unknownCount: Math.max(0, uncachedCount - failedUncachedCount),
      uncachedRows,
      newMessageRows,
      resyncRows,
    };
  }
}

module.exports = ChatDatabase;
module.exports.DbSearchWorker = DbSearchWorker;
