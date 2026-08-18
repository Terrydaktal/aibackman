const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const VERIFIED_JOURNAL_STATES = new Map();

function archiveRootForDatabase(dbPath) {
  const parent = path.dirname(path.resolve(dbPath));
  return path.basename(parent) === 'accounts' ? path.dirname(parent) : parent;
}

function safePathSegment(value, fallback = 'archive') {
  const segment = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return segment || fallback;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  let directory = null;
  try {
    directory = fs.openSync(path.dirname(filePath), 'r');
    fs.fsyncSync(directory);
  } catch {
    // Directory fsync is not available on every supported filesystem. The
    // rename remains atomic and the file itself is fully written first.
  } finally {
    if (directory != null) {
      try { fs.closeSync(directory); } catch {}
    }
  }
}

class DurableAuditJournal {
  constructor(rootPath, { buildInfo = null, maxBytes = 256 * 1024 * 1024, maxEventBytes = 64 * 1024 } = {}) {
    this.rootPath = path.resolve(rootPath);
    this.auditDirectory = path.join(this.rootPath, 'audit');
    this.filePath = path.join(this.auditDirectory, 'archive-mutations.jsonl');
    this.lockPath = `${this.filePath}.lock`;
    fs.mkdirSync(this.auditDirectory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.auditDirectory, 0o700); } catch {}
    if (fs.existsSync(this.filePath)) {
      try { fs.chmodSync(this.filePath, 0o600); } catch {}
    }
    this.buildInfo = buildInfo;
    this.maxBytes = Math.max(1024 * 1024, Number(maxBytes) || 256 * 1024 * 1024);
    this.maxEventBytes = Math.max(1024, Number(maxEventBytes) || 64 * 1024);
    this.sequence = 0;
    this.previousHash = null;
    this.ensureIntegrity();
    this.loadTail();
  }

  ensureIntegrity() {
    if (!fs.existsSync(this.filePath)) {
      VERIFIED_JOURNAL_STATES.delete(this.filePath);
      return;
    }
    const stat = fs.statSync(this.filePath);
    const identity = `${stat.size}:${stat.mtimeMs}`;
    if (VERIFIED_JOURNAL_STATES.get(this.filePath) === identity) return;
    const result = this.verifyIntegrity();
    if (!result.valid) {
      throw new Error(
        `Archive audit journal integrity check failed at sequence ${result.first_invalid_sequence || 'unknown'}: ${this.filePath}`
      );
    }
    VERIFIED_JOURNAL_STATES.set(this.filePath, identity);
  }

  rememberVerifiedState() {
    if (!fs.existsSync(this.filePath)) return;
    const stat = fs.statSync(this.filePath);
    VERIFIED_JOURNAL_STATES.set(this.filePath, `${stat.size}:${stat.mtimeMs}`);
  }

  loadTail() {
    if (!fs.existsSync(this.filePath)) return;
    const stat = fs.statSync(this.filePath);
    if (stat.size > this.maxBytes) throw new Error(`Archive audit journal exceeds its safety budget: ${this.filePath}`);
    // Every record is capped, so only the tail can contain the previous
    // record. Avoid rereading a potentially large audit journal on every
    // mutation; the exclusive lock still serializes multiple DB handles.
    const readBytes = Math.min(stat.size, this.maxEventBytes + 2);
    const descriptor = fs.openSync(this.filePath, 'r');
    const buffer = Buffer.alloc(readBytes);
    try { fs.readSync(descriptor, buffer, 0, readBytes, stat.size - readBytes); }
    finally { fs.closeSync(descriptor); }
    const last = buffer.toString('utf8').trim().split('\n').filter(Boolean).at(-1);
    if (!last) return;
    try {
      const record = JSON.parse(last);
      this.sequence = Number(record.sequence || 0);
      this.previousHash = record.integrity?.hash || crypto.createHash('sha256').update(last).digest('hex');
    } catch {
      throw new Error(`Archive audit journal is not valid JSON: ${this.filePath}`);
    }
  }

  append(event) {
    let lockDescriptor = null;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        lockDescriptor = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeSync(lockDescriptor, `${process.pid}\n`);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const lockStat = fs.statSync(this.lockPath);
          let stale = Date.now() - lockStat.mtimeMs > 30000;
          try {
            const owner = Number(fs.readFileSync(this.lockPath, 'utf8').trim());
            if (owner > 0) {
              try { process.kill(owner, 0); stale = false; } catch (ownerError) {
                if (ownerError.code === 'ESRCH') stale = true;
              }
            }
          } catch {}
          if (stale) fs.unlinkSync(this.lockPath);
        } catch {}
        // better-sqlite3 mutations are synchronous too; a short bounded wait
        // prevents two database handles from resetting the hash-chain tail.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    if (lockDescriptor == null) throw new Error('Timed out acquiring the archive audit journal lock.');
    try {
      this.ensureIntegrity();
      this.loadTail();
      const payload = {
        schema: 'aibackman-audit-event-v1',
        sequence: ++this.sequence,
        event_id: crypto.randomUUID(),
        occurred_at: new Date().toISOString(),
        build_id: this.buildInfo?.build_id || event.build_id || null,
        ...event,
      };
      const hash = crypto.createHash('sha256')
        .update(`${this.previousHash || ''}\0${JSON.stringify(payload)}`)
        .digest('hex');
      const record = { ...payload, integrity: { previous_hash: this.previousHash, hash } };
      const line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) > this.maxEventBytes) {
        this.sequence -= 1;
        throw new Error(`Archive audit event exceeds its safety budget (${this.maxEventBytes} bytes); mutation refused.`);
      }
      const currentBytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
      if (currentBytes + Buffer.byteLength(line) > this.maxBytes) {
        this.sequence -= 1;
        throw new Error(`Archive audit journal safety budget exhausted (${this.maxBytes} bytes); mutation refused.`);
      }
      const descriptor = fs.openSync(this.filePath, 'a', 0o600);
      try {
        fs.writeSync(descriptor, line);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      if (currentBytes === 0) {
        let directory = null;
        try {
          directory = fs.openSync(this.auditDirectory, 'r');
          fs.fsyncSync(directory);
        } catch {} finally {
          if (directory != null) {
            try { fs.closeSync(directory); } catch {}
          }
        }
      }
      this.previousHash = hash;
      this.rememberVerifiedState();
      return record;
    } finally {
      try { fs.closeSync(lockDescriptor); } catch {}
      try { fs.unlinkSync(this.lockPath); } catch {}
    }
  }

  verifyIntegrity() {
    if (!fs.existsSync(this.filePath)) return { valid: true, records: 0, legacyRecords: 0 };
    const lines = fs.readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean);
    let previousHash = null;
    let legacyRecords = 0;
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return { valid: false, records: lines.length, legacyRecords, first_invalid_sequence: 'invalid-json' };
      }
      if (!record.integrity?.hash) {
        legacyRecords += 1;
        previousHash = crypto.createHash('sha256').update(line).digest('hex');
        continue;
      }
      const { integrity, ...payload } = record;
      const expected = crypto.createHash('sha256')
        .update(`${previousHash || ''}\0${JSON.stringify(payload)}`)
        .digest('hex');
      if (integrity.previous_hash !== previousHash || integrity.hash !== expected) {
        return { valid: false, records: lines.length, legacyRecords, first_invalid_sequence: record.sequence };
      }
      previousHash = integrity.hash;
    }
    return { valid: true, records: lines.length, legacyRecords };
  }
}

class ArchiveRecoveryManager {
  constructor(rootPath, journal = new DurableAuditJournal(rootPath)) {
    this.rootPath = path.resolve(rootPath);
    this.recoveryRoot = path.join(this.rootPath, 'recovery');
    this.journal = journal;
    fs.mkdirSync(this.recoveryRoot, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.recoveryRoot, 0o700); } catch {}
  }

  createDatabaseSnapshot({
    sqlite,
    dbPath,
    reason,
    operationId = crypto.randomUUID(),
    force = false,
    includeEmptySchema = false,
  }) {
    const databasePath = path.resolve(dbPath);
    if (!fs.existsSync(databasePath)) return null;

    const archiveTables = new Set(sqlite.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('conversations', 'messages')
    `).all().map((row) => row.name));
    let rowCount = 0;
    if (archiveTables.has('conversations')) {
      rowCount += Number(sqlite.prepare('SELECT COUNT(*) AS count FROM conversations').get()?.count || 0);
    }
    if (archiveTables.has('messages')) {
      rowCount += Number(sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count || 0);
    }
    if (!force && (archiveTables.size === 0 || (!includeEmptySchema && rowCount === 0))) return null;

    const checkpoint = sqlite.pragma('wal_checkpoint(FULL)')?.[0] || {};
    if (
      Number(checkpoint.busy || 0) !== 0
      || Number(checkpoint.checkpointed || 0) < Number(checkpoint.log || 0)
    ) {
      throw new Error(`Could not checkpoint every WAL frame before snapshotting ${databasePath}.`);
    }
    const snapshotDirectory = path.join(
      this.recoveryRoot,
      'database-snapshots',
      safePathSegment(path.basename(databasePath))
    );
    fs.mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
    const basename = `${timestampForPath()}-${safePathSegment(reason, 'snapshot')}-${operationId}`;
    const snapshotPath = path.join(snapshotDirectory, `${basename}.db`);
    const temporaryPath = `${snapshotPath}.tmp`;
    fs.copyFileSync(databasePath, temporaryPath, fs.constants.COPYFILE_EXCL);

    let quickCheck = 'unknown';
    const snapshot = new Database(temporaryPath, { readonly: true, fileMustExist: true });
    try {
      quickCheck = String(snapshot.pragma('quick_check', { simple: true }) || 'unknown');
      if (quickCheck.toLowerCase() !== 'ok') {
        throw new Error(`Snapshot integrity check failed: ${quickCheck}`);
      }
    } finally {
      snapshot.close();
    }
    fs.renameSync(temporaryPath, snapshotPath);
    try { fs.chmodSync(snapshotPath, 0o600); } catch {}
    const snapshotDescriptor = fs.openSync(snapshotPath, 'r');
    try {
      fs.fsyncSync(snapshotDescriptor);
    } finally {
      fs.closeSync(snapshotDescriptor);
    }

    const manifest = {
      format: 'aibackman-database-snapshot-v1',
      created_at: new Date().toISOString(),
      operation_id: operationId,
      reason,
      source_database: databasePath,
      snapshot_database: snapshotPath,
      size_bytes: fs.statSync(snapshotPath).size,
      source_row_count: rowCount,
      quick_check: quickCheck,
    };
    writeJsonAtomically(`${snapshotPath}.json`, manifest);
    this.journal.append({
      action: 'database-snapshot-created',
      operation_id: operationId,
      reason,
      database_path: databasePath,
      recovery_path: snapshotPath,
      row_count: rowCount,
    });
    return manifest;
  }

  quarantineDatabaseFiles({ dbPath, account, reason, operationId = crypto.randomUUID() }) {
    const databasePath = path.resolve(dbPath);
    const directory = path.join(
      this.recoveryRoot,
      'deleted-accounts',
      `${timestampForPath()}-${safePathSegment(account?.id, 'account')}-${operationId}`
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

    const moved = [];
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const source = `${databasePath}${suffix}`;
        if (!fs.existsSync(source)) continue;
        const destination = path.join(directory, `${path.basename(databasePath)}${suffix}`);
        fs.renameSync(source, destination);
        try { fs.chmodSync(destination, 0o600); } catch {}
        moved.push({ source, destination });
      }
      const manifest = {
        format: 'aibackman-deleted-account-v1',
        created_at: new Date().toISOString(),
        operation_id: operationId,
        reason,
        account,
        original_database: databasePath,
        files: moved.map(({ destination }) => destination),
      };
      writeJsonAtomically(path.join(directory, 'manifest.json'), manifest);
      this.journal.append({
        action: 'account-database-quarantined',
        operation_id: operationId,
        reason,
        account_id: account?.id || null,
        database_path: databasePath,
        recovery_path: directory,
        file_count: moved.length,
      });
      return { directory, moved, manifest };
    } catch (error) {
      for (const { source, destination } of moved.reverse()) {
        if (fs.existsSync(destination) && !fs.existsSync(source)) fs.renameSync(destination, source);
      }
      throw error;
    }
  }
}

module.exports = {
  ArchiveRecoveryManager,
  DurableAuditJournal,
  archiveRootForDatabase,
  safePathSegment,
};
