const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { app } = require('electron');
const readline = require('readline');

const DB_SEARCH_TOOL_DIR = path.resolve(__dirname, '..', 'tools', 'db-search');
const DB_SEARCH_MANIFEST = path.join(DB_SEARCH_TOOL_DIR, 'Cargo.toml');
const FUZZY_RANK_DIR = path.resolve(__dirname, '..', '..', 'fuzzy-rank');
const DB_SEARCH_REBUILD_ROOTS = [
  DB_SEARCH_TOOL_DIR,
  FUZZY_RANK_DIR,
];

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

class DbSearchWorker {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.child = null;
    this.readline = null;
    this.binaryPath = null;
    this.binaryMtimeMs = 0;
    this.nextRequestId = 1;
    this.pending = new Map();
  }

  ensureStarted() {
    const binaryPath = ensureDbSearchBinary();
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
    this.binaryPath = binaryPath;
    this.binaryMtimeMs = binaryMtimeMs;
    this.child = spawn(binaryPath, ['serve', '--db-path', this.dbPath], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const child = this.child;
    this.readline = readline.createInterface({ input: child.stdout });
    this.readline.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) console.warn('db-search worker:', text);
    });
    child.on('exit', (code, signal) => {
      const error = new Error(`db-search worker exited (${code ?? signal ?? 'unknown'})`);
      for (const { reject } of this.pending.values()) {
        reject(error);
      }
      this.pending.clear();
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
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.output || { total: 0, total_is_lower_bound: false, results: [] });
    } else {
      pending.reject(new Error(response.error || 'db-search worker request failed'));
    }
  }

  search(query, limit = 100) {
    this.ensureStarted();
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ id, command: 'search', query, limit });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  stop() {
    if (this.readline) this.readline.close();
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
    this.readline = null;
    this.binaryPath = null;
    this.binaryMtimeMs = 0;
  }
}

class ChatDatabase {
  constructor(filename = 'chatgpt.db') {
    const dbPath = path.isAbsolute(filename)
      ? filename
      : path.join(app.getPath('userData'), filename);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -32768');
    this.searchWorker = new DbSearchWorker(dbPath);
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at DATETIME,
        updated_at DATETIME,
        last_synced_updated_at DATETIME,
        current_node_id TEXT,
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
    const tableInfo = this.db.prepare("PRAGMA table_info(conversations)").all();
    const messagesTableInfo = this.db.prepare("PRAGMA table_info(messages)").all();
    
    const hasCurrentNode = tableInfo.some(col => col.name === 'current_node_id');
    if (!hasCurrentNode) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN current_node_id TEXT");
    }

    const hasDeletedOnWeb = tableInfo.some(col => col.name === 'is_deleted_on_web');
    if (!hasDeletedOnWeb) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN is_deleted_on_web INTEGER DEFAULT 0");
    }

    const hasLastSyncedUpdatedAt = tableInfo.some(col => col.name === 'last_synced_updated_at');
    if (!hasLastSyncedUpdatedAt) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN last_synced_updated_at DATETIME");
    }

    const hasMetadataJson = messagesTableInfo.some(col => col.name === 'metadata_json');
    if (!hasMetadataJson) {
      this.db.exec("ALTER TABLE messages ADD COLUMN metadata_json TEXT");
    }

    try {
      runDbSearchHelper(['ensure-index', '--db-path', this.dbPath]);
    } catch (error) {
      console.warn('db-search index setup failed, falling back to LIKE search until fixed:', error);
    }
  }

  getConversations() {
    return this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
  }

  getConversation(id) {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }

  getMessages(conversationId) {
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId);
  }

  getLinearPath(currentNodeId) {
    return this.db.prepare(`
      WITH RECURSIVE chat_path(id, conversation_id, role, content, metadata_json, created_at, parent_id) AS (
        SELECT id, conversation_id, role, content, metadata_json, created_at, parent_id
        FROM messages
        WHERE id = ?
        UNION ALL
        SELECT m.id, m.conversation_id, m.role, m.content, m.metadata_json, m.created_at, m.parent_id
        FROM messages m
        JOIN chat_path cp ON m.id = cp.parent_id
      )
      SELECT * FROM chat_path ORDER BY created_at ASC
    `).all(currentNodeId);
  }

  upsertConversation(conv) {
    const stmt = this.db.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at, last_synced_updated_at, current_node_id, is_deleted_on_web)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        updated_at = excluded.updated_at,
        last_synced_updated_at = COALESCE(excluded.last_synced_updated_at, conversations.last_synced_updated_at),
        current_node_id = excluded.current_node_id,
        is_deleted_on_web = excluded.is_deleted_on_web
    `);
    stmt.run(
      conv.id,
      conv.title,
      conv.created_at,
      conv.updated_at,
      conv.last_synced_updated_at ?? null,
      conv.current_node_id,
      conv.is_deleted_on_web || 0
    );
  }

  markAsDeletedOnWeb(id) {
    this.db.prepare('UPDATE conversations SET is_deleted_on_web = 1 WHERE id = ?').run(id);
  }

  deleteConversation(id) {
    const deleteFailure = this.db.prepare('DELETE FROM cache_failures WHERE conversation_id = ?');
    const deleteMsgs = this.db.prepare('DELETE FROM messages WHERE conversation_id = ?');
    const deleteConv = this.db.prepare('DELETE FROM conversations WHERE id = ?');
    
    this.db.transaction(() => {
      deleteFailure.run(id);
      deleteMsgs.run(id);
      deleteConv.run(id);
    })();
  }

  clearAll() {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM cache_failures').run();
      this.db.prepare('DELETE FROM messages').run();
      this.db.prepare('DELETE FROM conversations').run();
      this.db.prepare('DELETE FROM source_items').run();
    })();
  }

  getStats() {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE IFNULL(is_deleted_on_web, 0) = 0) AS conversation_count,
        (SELECT COUNT(*) FROM messages) AS message_count,
        (SELECT COUNT(DISTINCT conversation_id) FROM messages) AS cached_count,
        (SELECT MAX(updated_at) FROM conversations) AS latest_updated_at
    `).get();
    return {
      conversationCount: Number(row?.conversation_count || 0),
      messageCount: Number(row?.message_count || 0),
      cachedCount: Number(row?.cached_count || 0),
      latestUpdatedAt: row?.latest_updated_at == null ? null : Number(row.latest_updated_at),
    };
  }

  getSourceItem(sourceKey) {
    return this.db.prepare('SELECT * FROM source_items WHERE source_key = ?').get(sourceKey) || null;
  }

  upsertSourceItem({ sourceKey, sourcePath, fingerprint, metadata = null }) {
    this.db.prepare(`
      INSERT INTO source_items (source_key, source_path, fingerprint, imported_at, metadata_json)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        source_path = excluded.source_path,
        fingerprint = excluded.fingerprint,
        imported_at = CURRENT_TIMESTAMP,
        metadata_json = excluded.metadata_json
    `).run(sourceKey, sourcePath, fingerprint, metadata == null ? null : JSON.stringify(metadata));
  }

  importConversationSnapshot(conversation, messages, { replaceMessages = false } = {}) {
    this.db.transaction(() => {
      this.upsertConversation(conversation);
      if (replaceMessages) {
        this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversation.id);
      }
      for (const message of messages) this.upsertMessage(message);
      this.upsertConversation(conversation);
    })();
  }

  close() {
    this.searchWorker.stop();
    this.db.close();
  }

  upsertMessage(msg) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at, parent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        role = excluded.role,
        content = excluded.content,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at,
        parent_id = excluded.parent_id
    `);
    stmt.run(
      msg.id,
      msg.conversation_id,
      msg.role,
      msg.content,
      msg.metadata_json ?? null,
      msg.created_at,
      msg.parent_id
    );
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
      const results = this.db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.content, c.title as conversation_title
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        WHERE m.content LIKE ?
          AND m.role IN ('user', 'assistant')
        ORDER BY m.created_at DESC
        LIMIT 100
      `).all(`%${trimmed}%`);
      const total = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM messages m
        WHERE m.content LIKE ?
          AND m.role IN ('user', 'assistant')
      `).get(`%${trimmed}%`)?.count || results.length;
      return { total, total_is_lower_bound: false, results };
    }
  }

  upsertCacheFailure(conversationId, errorMessage, statusCode = null) {
    const stmt = this.db.prepare(`
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
    this.db.prepare('DELETE FROM cache_failures WHERE conversation_id = ?').run(conversationId);
  }

  getCacheDiagnostics(limit = 50) {
    const summary = this.db.prepare(`
      WITH conv AS (
        SELECT id, updated_at, last_synced_updated_at
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
      ),
      dirty AS (
        SELECT conv.id
        FROM conv
        JOIN cached ON cached.id = conv.id
        WHERE conv.last_synced_updated_at IS NULL
          OR conv.updated_at IS NULL
          OR conv.updated_at != conv.last_synced_updated_at
      )
      SELECT
        (SELECT COUNT(*) FROM conv) AS local_count,
        (SELECT COUNT(*) FROM conv JOIN cached ON cached.id = conv.id) AS cached_count,
        (SELECT COUNT(*) FROM uncached) AS uncached_count,
        (SELECT COUNT(*) FROM uncached JOIN cache_failures cf ON cf.conversation_id = uncached.id) AS failed_count,
        (SELECT COUNT(*) FROM dirty) AS dirty_count
    `).get();

    const uncachedRows = this.db.prepare(`
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
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(limit);

    const dirtyRows = this.db.prepare(`
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
        AND (
          c.last_synced_updated_at IS NULL
          OR c.updated_at IS NULL
          OR c.updated_at != c.last_synced_updated_at
        )
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(limit);

    const failedCount = Number(summary.failed_count || 0);
    const uncachedCount = Number(summary.uncached_count || 0);
    return {
      localCount: Number(summary.local_count || 0),
      cachedCount: Number(summary.cached_count || 0),
      uncachedCount,
      failedCount,
      dirtyCount: Number(summary.dirty_count || 0),
      unknownCount: Math.max(0, uncachedCount - failedCount),
      uncachedRows,
      dirtyRows,
    };
  }
}

module.exports = ChatDatabase;
