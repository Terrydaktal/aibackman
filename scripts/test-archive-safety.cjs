const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const ChatDatabase = require('../electron/database.cjs');
const { DurableAuditJournal } = require('../electron/archive/safety/journal.cjs');
const {
  ARCHIVE_SAFETY_SCHEMA_VERSION,
  ARCHIVE_SAFETY_TRIGGER_COUNT,
} = require('../electron/archive/safety/schema.cjs');
const { STANDARD_CACHE_FORMAT_VERSION } = require('../electron/archive/standard/cacheVersion.cjs');
const {
  writeNormalizedArchive,
  writeNormalizedConversation,
} = require('../electron/archive/standard/writer.cjs');

function conversation(id, title, messages) {
  return {
    id,
    title,
    created_at: 100,
    updated_at: 200,
    current_node_id: messages.at(-1)?.id || null,
    messages: messages.map((message, index) => ({
      id: message.id,
      conversation_id: id,
      role: message.role,
      content: message.content,
      metadata_json: message.metadata_json ?? null,
      created_at: 101 + index,
      parent_id: index === 0 ? null : messages[index - 1].id,
    })),
  };
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-safety-tests-'));
  const dbPath = path.join(root, 'protected.db');
  const db = new ChatDatabase(dbPath, { initializeSearchIndex: false });
  let external = null;
  try {
    const legacyPath = path.join(root, 'legacy.db');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT, created_at DATETIME, updated_at DATETIME
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT,
        created_at DATETIME, parent_id TEXT
      );
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('legacy-chat', 'Legacy chat', 1, 2);
      INSERT INTO messages (id, conversation_id, role, content, created_at, parent_id)
      VALUES ('legacy-message', 'legacy-chat', 'user', 'Preserve before migration', 1, NULL);
    `);
    legacy.close();
    const migrated = new ChatDatabase(legacyPath, { initializeSearchIndex: false });
    try {
      assert.equal(migrated.getMessages('legacy-chat')[0].content, 'Preserve before migration');
      assert.equal(migrated.getSafetyStatus().schemaVersion, ARCHIVE_SAFETY_SCHEMA_VERSION);
      const migrationSnapshots = fs.readdirSync(path.join(root, 'recovery', 'database-snapshots', 'legacy.db'));
      assert.ok(migrationSnapshots.some((entry) => entry.endsWith('.db')));
    } finally {
      migrated.close();
    }

    const incompletePath = path.join(root, 'incomplete.db');
    const incomplete = new Database(incompletePath);
    incomplete.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT, created_at DATETIME, updated_at DATETIME
      );
      INSERT INTO conversations (id, title) VALUES ('surviving-chat', 'Must not be hidden');
    `);
    incomplete.close();
    assert.throws(
      () => new ChatDatabase(incompletePath, { initializeSearchIndex: false }),
      /missing required content tables; startup refused/i
    );
    const incompleteSnapshots = fs.readdirSync(
      path.join(root, 'recovery', 'database-snapshots', 'incomplete.db')
    );
    assert.ok(incompleteSnapshots.some((entry) => entry.includes('before-refusing-incomplete-archive-schema')));

    const repairPath = path.join(root, 'repair.db');
    const repairDatabase = new ChatDatabase(repairPath, { initializeSearchIndex: false });
    repairDatabase.close();
    const damagedSafety = new Database(repairPath);
    damagedSafety.exec('DROP TRIGGER archive_messages_no_unguarded_delete');
    damagedSafety.close();
    const repairedSafety = new ChatDatabase(repairPath, { initializeSearchIndex: false });
    try {
      assert.equal(repairedSafety.getSafetyStatus().triggerCount, ARCHIVE_SAFETY_TRIGGER_COUNT);
      const repairSnapshots = fs.readdirSync(
        path.join(root, 'recovery', 'database-snapshots', 'repair.db')
      );
      assert.ok(repairSnapshots.some((entry) => entry.includes('before-safety-trigger-repair')));
    } finally {
      repairedSafety.close();
    }

    const staleContextPath = path.join(root, 'stale-context.db');
    const staleContextSeed = new ChatDatabase(staleContextPath, { initializeSearchIndex: false });
    staleContextSeed.close();
    const staleContextRaw = new Database(staleContextPath);
    staleContextRaw.function('archive_context_write_allowed', () => 1);
    staleContextRaw.prepare(`
      UPDATE archive_operation_context
      SET operation_id = 'interrupted-operation', operation_type = 'interrupted-test',
          actor = 'test-suite', destructive_allowed = 1, actor_trust = 'asserted-in-process'
      WHERE singleton = 1
    `).run();
    staleContextRaw.close();
    const clearedContextDatabase = new ChatDatabase(staleContextPath, { initializeSearchIndex: false });
    try {
      assert.equal(clearedContextDatabase.getArchiveOperationContext().operation_id, null);
      assert.equal(clearedContextDatabase.getArchiveOperationContext().destructive_allowed, 0);
      assert.equal(clearedContextDatabase.getSafetyStatus().triggerCount, ARCHIVE_SAFETY_TRIGGER_COUNT);
    } finally {
      clearedContextDatabase.close();
    }

    const startupRepairPath = path.join(root, 'startup-repair.db');
    const startupRepairSeed = new ChatDatabase(startupRepairPath, { initializeSearchIndex: false });
    startupRepairSeed.upsertConversation({
      id: 'startup-repair-chat',
      title: 'Startup repair regression',
      created_at: '2026-08-18T00:00:00.000Z',
      updated_at: '2026-08-18T00:01:00.000Z',
      last_synced_updated_at: null,
      current_node_id: 'startup-repair-message',
      cache_format_version: STANDARD_CACHE_FORMAT_VERSION,
      is_deleted_on_web: 0,
    });
    startupRepairSeed.upsertMessage({
      id: 'startup-repair-message',
      conversation_id: 'startup-repair-chat',
      role: 'assistant',
      content: 'Preserve this cached message during startup repair.',
      metadata_json: null,
      created_at: 1,
      parent_id: 'missing-mapping-node',
    });
    startupRepairSeed.close();

    const startupRepairDatabase = new ChatDatabase(startupRepairPath, { initializeSearchIndex: false });
    try {
      const repairedConversation = startupRepairDatabase.getConversation('startup-repair-chat');
      const repairedMessage = startupRepairDatabase.getMessage('startup-repair-message');
      assert.equal(repairedConversation.last_synced_updated_at, repairedConversation.updated_at);
      assert.equal(repairedMessage.parent_id, null);
      assert.equal(startupRepairDatabase.countMessages('startup-repair-chat'), 1);

      const conversationRecovery = startupRepairDatabase
        .getRecoveryRecords('conversation-revision', 'startup-repair-chat')[0];
      const messageRecovery = startupRepairDatabase
        .getRecoveryRecords('message-revision', 'startup-repair-message')[0];
      assert.ok(conversationRecovery.operation_id);
      assert.equal(messageRecovery.operation_id, conversationRecovery.operation_id);
      assert.ok(startupRepairDatabase.getAuditTrail(500).some((entry) => (
        entry.operation_id === conversationRecovery.operation_id
        && entry.operation_type === 'startup-metadata-repair'
        && entry.action === 'operation-completed'
      )));
    } finally {
      startupRepairDatabase.close();
    }

    const original = conversation('protected-chat', 'Protected chat', [
      { id: 'message-1', role: 'user', content: 'Original prompt' },
      { id: 'message-2', role: 'assistant', content: 'Original answer' },
    ]);
    writeNormalizedConversation(db, original);
    external = new Database(dbPath);
    external.pragma('busy_timeout = 5000');

    db.upsertSourceItem({
      sourceKey: 'test-source',
      sourcePath: '/test/source.json',
      fingerprint: 'fingerprint-1',
    });
    db.upsertSourceItem({
      sourceKey: 'test-source',
      sourcePath: '/test/source-new.json',
      fingerprint: 'fingerprint-2',
    });
    const sourceRevision = db.getRecoveryRecords('source-item-revision', 'test-source')[0];
    assert.equal(JSON.parse(sourceRevision.payload_json).fingerprint, 'fingerprint-1');
    db.restoreSourceItemRevision('test-source', {
      sequence: sourceRevision.sequence,
      confirmation: 'test-source',
      reason: 'Exercise exact source metadata recovery.',
    });
    assert.equal(db.getSourceItem('test-source').fingerprint, 'fingerprint-1');
    assert.throws(
      () => external.prepare('DELETE FROM source_items WHERE source_key = ?').run('test-source'),
      /guarded operation|no such function/i
    );

    assert.throws(
      () => external.prepare('DELETE FROM messages WHERE id = ?').run('message-1'),
      /guarded operation|no such function/i
    );
    assert.equal(db.getMessages('protected-chat').length, 2);
    assert.throws(
      () => external.prepare(`
        INSERT OR REPLACE INTO messages (
          id, conversation_id, role, content, metadata_json, created_at, parent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('message-1', 'protected-chat', 'user', 'Replacement bypass', null, 101, null),
      /guarded operation|no such function/i
    );
    assert.throws(
      () => external.prepare(`
        INSERT INTO archive_audit_log (
          operation_id, operation_type, actor, action, entity_type
        ) VALUES ('forged', 'forged', 'forged', 'forged', 'database')
      `).run(),
      /guarded database API|no such function/i
    );
    assert.throws(
      () => external.prepare(`
        INSERT INTO archive_recovery_records (
          operation_id, entity_type, entity_id, payload_json
        ) VALUES ('forged', 'message', 'forged', '{}')
      `).run(),
      /guarded database API|no such function/i
    );
    assert.equal(db.getMessages('protected-chat').find((message) => message.id === 'message-1').content, 'Original prompt');

    const partialReplacement = conversation('protected-chat', 'Protected chat revised', [
      { id: 'message-1', role: 'user', content: 'Revised prompt' },
    ]);
    const mergeResult = writeNormalizedConversation(db, partialReplacement, { replaceMessages: true });
    assert.equal(mergeResult.replacementPrevented, true);
    assert.equal(mergeResult.preservedMessages, 1);
    assert.deepEqual(
      db.getMessages('protected-chat').map((message) => message.id).sort(),
      ['message-1', 'message-2']
    );
    assert.equal(db.getMessages('protected-chat').find((message) => message.id === 'message-1').content, 'Revised prompt');
    const recoverableRevision = db.getRecoveryRecords('message-revision', 'message-1')[0];
    assert.ok(recoverableRevision);
    assert.equal(JSON.parse(recoverableRevision.payload_json).content, 'Original prompt');
    const conversationRevision = db.getRecoveryRecords('conversation-revision', 'protected-chat')
      .find((record) => JSON.parse(record.payload_json).title === 'Protected chat');
    assert.ok(conversationRevision);
    db.restoreConversationRevision('protected-chat', {
      sequence: conversationRevision.sequence,
      confirmation: 'protected-chat',
      reason: 'Exercise exact conversation metadata recovery.',
    });
    assert.equal(db.getConversation('protected-chat').title, 'Protected chat');

    assert.throws(
      () => external.prepare(`
        UPDATE archive_operation_context
        SET operation_id = 'self-authorized-delete', destructive_allowed = 1
        WHERE singleton = 1
      `).run(),
      /guarded database API|no such function/i
    );
    assert.throws(
      () => db.runArchiveOperation({
        type: 'unconfirmed-destructive-test',
        actor: 'test-suite',
        reason: 'A caller must not mint its own destructive capability.',
        destructive: true,
      }, () => undefined),
      /internal confirmed capability/i
    );

    const rollbackCounts = db.getArchiveCounts();
    assert.throws(() => db.runArchiveOperation({
      type: 'forced-rollback-test',
      actor: 'test-suite',
      reason: 'Verify failed transactions leave no archive rows.',
    }, () => {
      db.upsertMessage({
        id: 'rollback-message',
        conversation_id: 'protected-chat',
        role: 'user',
        content: 'must rollback',
        created_at: 999,
        parent_id: null,
      });
      throw new Error('synthetic rollback');
    }), /synthetic rollback/);
    assert.deepEqual(db.getArchiveCounts(), rollbackCounts);
    assert.equal(db.getArchiveOperationContext().operation_id, null);

    const messageRevision = db.getAuditTrail(500).find((entry) => (
      entry.action === 'update' && entry.entity_type === 'message' && entry.entity_id === 'message-1'
    ));
    assert.ok(messageRevision);
    assert.equal(JSON.parse(messageRevision.before_json).content_length, 'Original prompt'.length);
    assert.equal(JSON.parse(messageRevision.after_json).content_length, 'Revised prompt'.length);
    assert.ok(db.getAuditTrail(500).some((entry) => entry.action === 'destructive-message-replacement-blocked'));
    writeNormalizedConversation(db, conversation('protected-chat', 'Protected chat', [
      { id: 'message-1', role: 'user', content: '' },
    ]));
    assert.equal(db.getMessages('protected-chat').find((message) => message.id === 'message-1').content, 'Revised prompt');
    db.restoreMessageRevision('message-1', {
      sequence: recoverableRevision.sequence,
      confirmation: 'message-1',
      reason: 'Verify complete message revision recovery.',
      actor: 'test-suite',
    });
    assert.equal(db.getMessage('message-1').content, 'Original prompt');
    const revisedRevision = db.getRecoveryRecords('message-revision', 'message-1')[0];
    db.restoreMessageRevision('message-1', {
      sequence: revisedRevision.sequence,
      confirmation: 'message-1',
      reason: 'Restore the current test state after exercising recovery.',
      actor: 'test-suite',
    });
    assert.equal(db.getMessage('message-1').content, 'Revised prompt');

    writeNormalizedConversation(db, conversation('protocol-chat', 'Protocol chat', [
      { id: 'protocol-message', role: 'assistant', content: 'Internal protocol gunk' },
    ]));
    writeNormalizedConversation(db, conversation('protocol-chat', 'Protocol chat', [
      {
        id: 'protocol-message',
        role: 'assistant',
        content: '',
        metadata_json: JSON.stringify({ chatgpt_internal_protocol: true }),
      },
    ]));
    assert.equal(db.getMessages('protocol-chat')[0].content, '');
    assert.ok(db.getAuditTrail(500).some((entry) => (
      entry.action === 'update'
      && entry.entity_id === 'protocol-message'
      && JSON.parse(entry.before_json).content_length === 'Internal protocol gunk'.length
    )));

    assert.throws(
      () => external.prepare('DELETE FROM archive_audit_log').run(),
      /append-only/i
    );
    assert.throws(
      () => db.deleteConversation('protected-chat'),
      /exact conversation id was not confirmed/i
    );

    const deletion = db.deleteConversation('protected-chat', {
      confirmation: 'protected-chat',
      reason: 'Archive safety regression test.',
      actor: 'test-suite',
    });
    assert.equal(deletion.deleted, true);
    assert.equal(deletion.deletedMessages, 2);
    assert.equal(db.getConversation('protected-chat'), undefined);
    assert.equal(db.getRecoveryRecords('conversation', 'protected-chat').length, 1);
    assert.equal(db.getRecoveryRecords('message', 'message-1').length, 1);
    assert.throws(
      () => external.prepare('DELETE FROM archive_recovery_records').run(),
      /immutable/i
    );
    assert.throws(
      () => external.prepare("UPDATE archive_store_identity SET store_generation = 'forged' WHERE singleton = 1").run(),
      /immutable/i
    );

    const restored = db.restoreDeletedConversation('protected-chat');
    assert.equal(restored.restoredMessages, 2);
    assert.equal(db.getMessages('protected-chat').length, 2);

    writeNormalizedArchive({
      db,
      replaceExisting: true,
      sourcePath: '/test/partial-backup',
      conversations: [conversation('new-chat', 'New chat', [
        { id: 'new-message', role: 'user', content: 'New content' },
      ])],
    });
    assert.ok(db.getConversation('protected-chat'));
    assert.ok(db.getConversation('new-chat'));
    assert.ok(db.getAuditTrail(500).some((entry) => entry.action === 'destructive-archive-replacement-blocked'));
    const messageInsert = db.getAuditTrail(500).find((entry) => (
      entry.action === 'insert' && entry.entity_type === 'message' && entry.entity_id === 'new-message'
    ));
    assert.ok(messageInsert);
    assert.equal(messageInsert.event_schema, 'aibackman-audit-event-v1');
    assert.equal(messageInsert.writer_component, 'archive-database-api');
    assert.ok(messageInsert.store_instance_id);
    assert.ok(messageInsert.store_generation);
    assert.equal(JSON.parse(messageInsert.after_json).content, undefined);

    const snapshot = db.createRecoverySnapshot('archive-safety-test', { force: true });
    assert.ok(snapshot);
    assert.equal(fs.existsSync(snapshot.snapshot_database), true);
    assert.equal(fs.existsSync(`${snapshot.snapshot_database}.json`), true);

    assert.throws(
      () => db.clearAll(),
      /explicit full-archive confirmation/i
    );
    db.clearAll({
      confirmation: 'CLEAR ENTIRE ARCHIVE',
      reason: 'Archive safety regression test for guarded full clearing.',
      actor: 'test-suite',
    });
    assert.equal(db.getArchiveCounts().conversations, 0);
    assert.equal(db.getArchiveCounts().messages, 0);
    assert.ok(db.getAuditTrail(500).some((entry) => entry.operation_type === 'clear-entire-archive'));
    assert.ok(db.restoreDeletedConversation('protected-chat').restoredMessages >= 2);

    const journalPath = path.join(root, 'audit', 'archive-mutations.jsonl');
    assert.equal(fs.existsSync(journalPath), true);
    const journal = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(journal.some((entry) => entry.action === 'operation-started'));
    assert.ok(journal.some((entry) => entry.action === 'operation-completed'));
    assert.equal(db.auditJournal.verifyIntegrity().valid, true);

    const tamperRoot = path.join(root, 'tamper-audit');
    const tamperJournal = new DurableAuditJournal(tamperRoot, { maxEventBytes: 1024 });
    tamperJournal.append({ action: 'tamper-test', value: 'original' });
    const tamperPath = path.join(tamperRoot, 'audit', 'archive-mutations.jsonl');
    fs.writeFileSync(tamperPath, fs.readFileSync(tamperPath, 'utf8').replace('original', 'modified'));
    assert.equal(tamperJournal.verifyIntegrity().valid, false);
    assert.throws(
      () => new DurableAuditJournal(tamperRoot, { maxEventBytes: 1024 }),
      /integrity check failed/i
    );

    const budgetRoot = path.join(root, 'budget-refusal');
    const budgetPath = path.join(budgetRoot, 'budget.db');
    const previousBudget = process.env.AIBACKMAN_AUDIT_MAX_BYTES;
    process.env.AIBACKMAN_AUDIT_MAX_BYTES = String(1024 * 1024);
    let budgetDb = null;
    try {
      budgetDb = new ChatDatabase(budgetPath, { initializeSearchIndex: false });
      let exhausted = false;
      for (let index = 0; index < 40 && !exhausted; index += 1) {
        try {
          budgetDb.auditJournal.append({ action: 'budget-fill', index, payload: 'x'.repeat(60000) });
        } catch (error) {
          assert.match(error.message, /budget exhausted/i);
          exhausted = true;
        }
      }
      assert.equal(exhausted, true);
      for (let index = 0; index < 1000; index += 1) {
        try {
          budgetDb.auditJournal.append({ action: 'budget-pack', index, payload: 'x'.repeat(100) });
        } catch (error) {
          assert.match(error.message, /budget exhausted/i);
          break;
        }
      }
      const beforeBudgetRefusal = budgetDb.getArchiveCounts();
      assert.throws(() => budgetDb.upsertConversation({
        id: 'must-not-commit',
        title: 'Must not commit',
        created_at: 1,
        updated_at: 1,
        current_node_id: null,
        is_deleted_on_web: 0,
      }), /budget exhausted/i);
      assert.deepEqual(budgetDb.getArchiveCounts(), beforeBudgetRefusal);
    } finally {
      budgetDb?.close();
      if (previousBudget == null) delete process.env.AIBACKMAN_AUDIT_MAX_BYTES;
      else process.env.AIBACKMAN_AUDIT_MAX_BYTES = previousBudget;
    }

    console.log('Archive safety regression checks passed.');
  } finally {
    external?.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
