#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const ChatDatabase = require('../electron/database.cjs');
const {
  ARCHIVE_SAFETY_SCHEMA_VERSION,
  ARCHIVE_SAFETY_TRIGGER_COUNT,
} = require('../electron/archive/safety/schema.cjs');

function parseArguments(argv) {
  const roots = [];
  let verifyOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') {
      if (!argv[index + 1]) throw new Error('--root requires a directory path.');
      roots.push(path.resolve(argv[index + 1]));
      index += 1;
    } else if (argv[index] === '--verify-only') {
      verifyOnly = true;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (roots.length === 0) {
    const configRoot = process.env.XDG_CONFIG_HOME
      ? path.resolve(process.env.XDG_CONFIG_HOME)
      : path.join(os.homedir(), '.config');
    roots.push(path.join(configRoot, 'aibackman'));
    const legacy = path.join(configRoot, 'chatgpt');
    if (fs.existsSync(legacy)) roots.push(legacy);
  }
  return { roots: [...new Set(roots)], verifyOnly };
}

function archiveCandidates(root) {
  const candidates = [path.join(root, 'chatgpt.db'), path.join(root, 'aimode.db')];
  const accountRoot = path.join(root, 'accounts');
  if (fs.existsSync(accountRoot)) {
    for (const entry of fs.readdirSync(accountRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.db')) candidates.push(path.join(accountRoot, entry.name));
    }
  }
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function inspectDatabase(dbPath) {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map((row) => row.name));
    const hasConversations = tables.has('conversations');
    const hasMessages = tables.has('messages');
    return {
      path: dbPath,
      schemaVersion: Number(sqlite.pragma('user_version', { simple: true }) || 0),
      conversations: hasConversations
        ? Number(sqlite.prepare('SELECT COUNT(*) AS count FROM conversations').get()?.count || 0)
        : null,
      messages: hasMessages
        ? Number(sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count || 0)
        : null,
      integrity: String(sqlite.pragma('quick_check', { simple: true }) || 'unknown'),
      archiveSchemaComplete: hasConversations && hasMessages,
    };
  } finally {
    sqlite.close();
  }
}

function migrateDatabase(before, verifyOnly) {
  if (before.integrity.toLowerCase() !== 'ok') {
    throw new Error(`Refusing to migrate a database that failed quick_check: ${before.path}`);
  }
  if (!before.archiveSchemaComplete && verifyOnly) {
    return {
      ...before,
      requiredSchemaVersion: ARCHIVE_SAFETY_SCHEMA_VERSION,
      safe: false,
      migrated: false,
      error: 'required archive content tables are missing',
    };
  }
  if (verifyOnly) {
    return {
      ...before,
      requiredSchemaVersion: ARCHIVE_SAFETY_SCHEMA_VERSION,
      safe: before.schemaVersion >= ARCHIVE_SAFETY_SCHEMA_VERSION,
      migrated: false,
    };
  }
  const database = new ChatDatabase(before.path, { initializeSearchIndex: false });
  try {
    if (before.schemaVersion < ARCHIVE_SAFETY_SCHEMA_VERSION) {
      database.recordSafetyEvent('safety-schema-migrated', 'database', before.path, {
        fromSchemaVersion: before.schemaVersion,
        toSchemaVersion: ARCHIVE_SAFETY_SCHEMA_VERSION,
      });
    }
    const safety = database.getSafetyStatus();
    const counts = database.getArchiveCounts();
    if (counts.conversations !== before.conversations || counts.messages !== before.messages) {
      throw new Error(`Archive counts changed while installing safety schema: ${before.path}`);
    }
    if (
      safety.schemaVersion < ARCHIVE_SAFETY_SCHEMA_VERSION
      || safety.triggerCount !== ARCHIVE_SAFETY_TRIGGER_COUNT
    ) {
      throw new Error(`Safety schema verification failed after migration: ${before.path}`);
    }
    return {
      path: before.path,
      beforeSchemaVersion: before.schemaVersion,
      schemaVersion: safety.schemaVersion,
      conversations: counts.conversations,
      messages: counts.messages,
      triggerCount: safety.triggerCount,
      auditRows: safety.auditRows,
      recoveryRows: safety.recoveryRows,
      storeInstanceId: safety.storeInstanceId,
      migrated: before.schemaVersion < safety.schemaVersion,
      verified: true,
    };
  } finally {
    database.close();
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.verifyOnly) {
    for (const root of options.roots) {
      if (!fs.existsSync(root)) continue;
      fs.chmodSync(root, 0o700);
      const accountRoot = path.join(root, 'accounts');
      if (fs.existsSync(accountRoot)) fs.chmodSync(accountRoot, 0o700);
      const catalogPath = path.join(root, 'archive-catalog.db');
      if (fs.existsSync(catalogPath)) fs.chmodSync(catalogPath, 0o600);
    }
  }
  const targets = options.roots
    .flatMap((root) => archiveCandidates(root))
    .map(inspectDatabase)
    .filter(Boolean);
  if (targets.length === 0) throw new Error(`No AIBackman archive databases found under: ${options.roots.join(', ')}`);
  const results = targets.map((target) => migrateDatabase(target, options.verifyOnly));
  const failures = results.filter((result) => options.verifyOnly && !result.safe);
  console.log(JSON.stringify({
    mode: options.verifyOnly ? 'verify-only' : 'migrate',
    requiredSchemaVersion: ARCHIVE_SAFETY_SCHEMA_VERSION,
    roots: options.roots,
    databases: results,
  }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
