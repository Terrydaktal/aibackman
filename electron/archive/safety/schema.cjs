// Bump this before adding any future archive migration. ChatDatabase uses the
// version change to take and verify a full pre-migration snapshot first.
const ARCHIVE_SAFETY_SCHEMA_VERSION = 4;
const ARCHIVE_SAFETY_TRIGGER_COUNT = 37;

function resetArchiveOperationContext(db, { withContextWrite = (callback) => callback() } = {}) {
  const context = db.prepare(`
    SELECT operation_id, operation_type, actor, reason, started_at, destructive_allowed,
           writer_component, writer_instance_id, store_instance_id, store_generation,
           transaction_id, actor_trust, reason_code
    FROM archive_operation_context
    WHERE singleton = 1
  `).get();
  if (!context) return false;
  const alreadyClear = context.operation_id == null
    && context.operation_type == null
    && context.actor == null
    && context.reason == null
    && context.started_at == null
    && Number(context.destructive_allowed || 0) === 0
    && context.writer_component == null
    && context.writer_instance_id == null
    && context.store_instance_id == null
    && context.store_generation == null
    && context.transaction_id == null
    && context.actor_trust === 'unknown'
    && context.reason_code == null;
  if (alreadyClear) return false;

  withContextWrite(() => db.prepare(`
    UPDATE archive_operation_context
    SET operation_id = NULL,
        operation_type = NULL,
        actor = NULL,
        reason = NULL,
        started_at = NULL,
        destructive_allowed = 0,
        writer_component = NULL,
        writer_instance_id = NULL,
        store_instance_id = NULL,
        store_generation = NULL,
        transaction_id = NULL,
        actor_trust = 'unknown',
        reason_code = NULL
    WHERE singleton = 1
  `).run());
  return true;
}

function installArchiveSafetySchema(db, { withContextWrite = (callback) => callback() } = {}) {
  // Create the extended tables before recreating the triggers below. The
  // ALTERs keep existing user databases migratable without replacing them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_operation_context (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      operation_id TEXT,
      operation_type TEXT,
      actor TEXT,
      reason TEXT,
      started_at TEXT,
      destructive_allowed INTEGER NOT NULL DEFAULT 0 CHECK (destructive_allowed IN (0, 1)),
      writer_component TEXT,
      writer_instance_id TEXT,
      store_instance_id TEXT,
      store_generation TEXT,
      transaction_id TEXT,
      actor_trust TEXT NOT NULL DEFAULT 'unknown',
      reason_code TEXT
    );
    CREATE TABLE IF NOT EXISTS archive_audit_log (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      operation_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      reason TEXT,
      before_json TEXT,
      after_json TEXT,
      details_json TEXT,
      event_schema TEXT NOT NULL DEFAULT 'aibackman-audit-event-v1',
      writer_component TEXT,
      writer_instance_id TEXT,
      store_instance_id TEXT,
      store_generation TEXT,
      transaction_id TEXT,
      outcome TEXT NOT NULL DEFAULT 'committed',
      recorder TEXT NOT NULL DEFAULT 'sqlite-trigger',
      actor_trust TEXT NOT NULL DEFAULT 'unknown',
      reason_code TEXT
    );
    CREATE TABLE IF NOT EXISTS archive_store_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      store_instance_id TEXT NOT NULL,
      store_generation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const ensureColumns = (table, columns) => {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  ensureColumns('archive_operation_context', {
    writer_component: 'TEXT', writer_instance_id: 'TEXT', store_instance_id: 'TEXT',
    store_generation: 'TEXT', transaction_id: 'TEXT', actor_trust: "TEXT NOT NULL DEFAULT 'unknown'", reason_code: 'TEXT',
  });
  ensureColumns('archive_audit_log', {
    event_schema: "TEXT NOT NULL DEFAULT 'aibackman-audit-event-v1'", writer_component: 'TEXT', writer_instance_id: 'TEXT',
    store_instance_id: 'TEXT', store_generation: 'TEXT', transaction_id: 'TEXT', outcome: "TEXT NOT NULL DEFAULT 'committed'",
    recorder: "TEXT NOT NULL DEFAULT 'sqlite-trigger'", actor_trust: "TEXT NOT NULL DEFAULT 'unknown'", reason_code: 'TEXT',
  });
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_operation_context (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      operation_id TEXT,
      operation_type TEXT,
      actor TEXT,
      reason TEXT,
      started_at TEXT,
      destructive_allowed INTEGER NOT NULL DEFAULT 0 CHECK (destructive_allowed IN (0, 1))
    );

    INSERT INTO archive_operation_context (singleton, destructive_allowed)
    SELECT 1, 0
    WHERE NOT EXISTS (SELECT 1 FROM archive_operation_context WHERE singleton = 1);

    CREATE TABLE IF NOT EXISTS archive_audit_log (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      operation_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      reason TEXT,
      before_json TEXT,
      after_json TEXT,
      details_json TEXT
    );

    CREATE TABLE IF NOT EXISTS archive_recovery_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      operation_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_archive_audit_operation
      ON archive_audit_log(operation_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_archive_audit_entity
      ON archive_audit_log(entity_type, entity_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_archive_recovery_entity
      ON archive_recovery_records(entity_type, entity_id, sequence DESC);

    DROP TRIGGER IF EXISTS archive_audit_log_no_update;
    DROP TRIGGER IF EXISTS archive_audit_log_no_delete;
    DROP TRIGGER IF EXISTS archive_audit_log_no_untrusted_insert;
    DROP TRIGGER IF EXISTS archive_recovery_no_update;
    DROP TRIGGER IF EXISTS archive_recovery_no_delete;
    DROP TRIGGER IF EXISTS archive_recovery_no_untrusted_insert;
    DROP TRIGGER IF EXISTS archive_context_no_delete;
    DROP TRIGGER IF EXISTS archive_context_no_insert;
    DROP TRIGGER IF EXISTS archive_context_no_untrusted_update;
    DROP TRIGGER IF EXISTS archive_store_identity_no_update;
    DROP TRIGGER IF EXISTS archive_store_identity_no_delete;
    DROP TRIGGER IF EXISTS archive_store_identity_no_untrusted_insert;
    DROP TRIGGER IF EXISTS archive_conversations_no_unguarded_insert;
    DROP TRIGGER IF EXISTS archive_conversations_no_unguarded_update;
    DROP TRIGGER IF EXISTS archive_messages_no_unguarded_insert;
    DROP TRIGGER IF EXISTS archive_messages_no_unguarded_update;
    DROP TRIGGER IF EXISTS archive_source_items_no_unguarded_insert;
    DROP TRIGGER IF EXISTS archive_source_items_no_unguarded_update;
    DROP TRIGGER IF EXISTS archive_messages_no_unguarded_delete;
    DROP TRIGGER IF EXISTS archive_conversations_no_unguarded_delete;
    DROP TRIGGER IF EXISTS archive_source_items_no_unguarded_delete;
    DROP TRIGGER IF EXISTS archive_message_identity_immutable;
    DROP TRIGGER IF EXISTS archive_conversation_identity_immutable;
    DROP TRIGGER IF EXISTS archive_message_content_no_accidental_blank;
    DROP TRIGGER IF EXISTS archive_conversation_insert_audit;
    DROP TRIGGER IF EXISTS archive_conversation_update_audit;
    DROP TRIGGER IF EXISTS archive_conversation_update_recovery;
    DROP TRIGGER IF EXISTS archive_conversation_delete_recovery;
    DROP TRIGGER IF EXISTS archive_message_update_audit;
    DROP TRIGGER IF EXISTS archive_message_update_recovery;
    DROP TRIGGER IF EXISTS archive_message_insert_audit;
    DROP TRIGGER IF EXISTS archive_message_delete_recovery;
    DROP TRIGGER IF EXISTS archive_source_item_insert_audit;
    DROP TRIGGER IF EXISTS archive_source_item_update_audit;
    DROP TRIGGER IF EXISTS archive_source_item_update_recovery;
    DROP TRIGGER IF EXISTS archive_source_item_delete_audit;
    DROP TRIGGER IF EXISTS archive_source_item_delete_recovery;

    CREATE TRIGGER archive_audit_log_no_update
    BEFORE UPDATE ON archive_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'The archive audit log is append-only');
    END;

    CREATE TRIGGER archive_audit_log_no_delete
    BEFORE DELETE ON archive_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'The archive audit log is append-only');
    END;

    CREATE TRIGGER archive_audit_log_no_untrusted_insert
    BEFORE INSERT ON archive_audit_log
    WHEN archive_write_allowed() != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive audit rows can only be appended by the guarded database API');
    END;

    CREATE TRIGGER archive_recovery_no_update
    BEFORE UPDATE ON archive_recovery_records
    BEGIN
      SELECT RAISE(ABORT, 'Archive recovery records are immutable');
    END;

    CREATE TRIGGER archive_recovery_no_delete
    BEFORE DELETE ON archive_recovery_records
    BEGIN
      SELECT RAISE(ABORT, 'Archive recovery records are immutable');
    END;

    CREATE TRIGGER archive_recovery_no_untrusted_insert
    BEFORE INSERT ON archive_recovery_records
    WHEN archive_write_allowed() != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive recovery rows can only be appended by the guarded database API');
    END;

    CREATE TRIGGER archive_context_no_delete
    BEFORE DELETE ON archive_operation_context
    BEGIN
      SELECT RAISE(ABORT, 'The archive write guard cannot be deleted');
    END;

    CREATE TRIGGER archive_context_no_insert
    BEFORE INSERT ON archive_operation_context
    BEGIN
      SELECT RAISE(ABORT, 'The archive write guard cannot be inserted directly');
    END;

    CREATE TRIGGER archive_context_no_untrusted_update
    BEFORE UPDATE ON archive_operation_context
    WHEN archive_context_write_allowed() != 1
    BEGIN
      SELECT RAISE(ABORT, 'The archive write guard can only be changed by the guarded database API');
    END;

    CREATE TRIGGER archive_store_identity_no_update
    BEFORE UPDATE ON archive_store_identity
    BEGIN
      SELECT RAISE(ABORT, 'Archive store identity is immutable');
    END;

    CREATE TRIGGER archive_store_identity_no_delete
    BEFORE DELETE ON archive_store_identity
    BEGIN
      SELECT RAISE(ABORT, 'Archive store identity is immutable');
    END;

    CREATE TRIGGER archive_store_identity_no_untrusted_insert
    BEFORE INSERT ON archive_store_identity
    WHEN archive_write_allowed() != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive store identity can only be created by the guarded database API');
    END;

    CREATE TRIGGER archive_conversations_no_unguarded_insert
    BEFORE INSERT ON conversations
    WHEN archive_write_allowed() != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive conversation writes require a guarded operation');
    END;

    CREATE TRIGGER archive_conversations_no_unguarded_update
    BEFORE UPDATE ON conversations
    WHEN archive_write_allowed() != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive conversation writes require a guarded operation');
    END;

    CREATE TRIGGER archive_messages_no_unguarded_insert
    BEFORE INSERT ON messages
    WHEN archive_write_allowed() != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive message writes require a guarded operation');
    END;

    CREATE TRIGGER archive_messages_no_unguarded_update
    BEFORE UPDATE ON messages
    WHEN archive_write_allowed() != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive message writes require a guarded operation');
    END;

    CREATE TRIGGER archive_source_items_no_unguarded_insert
    BEFORE INSERT ON source_items
    WHEN archive_write_allowed() != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive source-item writes require a guarded operation');
    END;

    CREATE TRIGGER archive_source_items_no_unguarded_update
    BEFORE UPDATE ON source_items
    WHEN archive_write_allowed() != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive source-item writes require a guarded operation');
    END;

    CREATE TRIGGER archive_messages_no_unguarded_delete
    BEFORE DELETE ON messages
    WHEN archive_destructive_allowed() != 1 OR COALESCE((
      SELECT destructive_allowed FROM archive_operation_context WHERE singleton = 1
    ), 0) != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive message deletion requires an explicit guarded operation');
    END;

    CREATE TRIGGER archive_conversations_no_unguarded_delete
    BEFORE DELETE ON conversations
    WHEN archive_destructive_allowed() != 1 OR COALESCE((
      SELECT destructive_allowed FROM archive_operation_context WHERE singleton = 1
    ), 0) != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive conversation deletion requires an explicit guarded operation');
    END;

    CREATE TRIGGER archive_source_items_no_unguarded_delete
    BEFORE DELETE ON source_items
    WHEN archive_destructive_allowed() != 1 OR COALESCE((
      SELECT destructive_allowed FROM archive_operation_context WHERE singleton = 1
    ), 0) != 1
    BEGIN
      SELECT RAISE(ABORT, 'Archive source-item deletion requires an explicit guarded operation');
    END;

    CREATE TRIGGER archive_message_identity_immutable
    BEFORE UPDATE OF id, conversation_id ON messages
    WHEN OLD.id IS NOT NEW.id OR OLD.conversation_id IS NOT NEW.conversation_id
    BEGIN
      SELECT RAISE(ABORT, 'Archive message identity cannot be overwritten');
    END;

    CREATE TRIGGER archive_conversation_identity_immutable
    BEFORE UPDATE OF id ON conversations
    WHEN OLD.id IS NOT NEW.id
    BEGIN
      SELECT RAISE(ABORT, 'Archive conversation identity cannot be overwritten');
    END;

    CREATE TRIGGER archive_message_content_no_accidental_blank
    BEFORE UPDATE OF content ON messages
    WHEN trim(COALESCE(OLD.content, '')) != ''
      AND trim(COALESCE(NEW.content, '')) = ''
      AND COALESCE(NEW.role, OLD.role) != 'tool'
      AND COALESCE(
        CASE WHEN json_valid(NEW.metadata_json)
          THEN json_extract(NEW.metadata_json, '$.chatgpt_internal_protocol') END,
        0
      ) != 1
      AND COALESCE(
        CASE WHEN json_valid(NEW.metadata_json)
          THEN json_extract(NEW.metadata_json, '$.is_visually_hidden_from_conversation') END,
        0
      ) != 1
      AND COALESCE(
        CASE WHEN json_valid(NEW.metadata_json)
          THEN json_extract(NEW.metadata_json, '$.is_thinking_preamble_message') END,
        0
      ) != 1
    BEGIN
      SELECT RAISE(ABORT, 'Non-empty archive message content cannot be overwritten with an empty value');
    END;

    CREATE TRIGGER archive_conversation_insert_audit
    AFTER INSERT ON conversations
    BEGIN
      INSERT INTO archive_audit_log (
        operation_id, operation_type, actor, action, entity_type, entity_id, reason, after_json,
        writer_component, writer_instance_id, store_instance_id, store_generation,
        transaction_id, actor_trust, reason_code
      ) VALUES (
        COALESCE((SELECT operation_id FROM archive_operation_context WHERE singleton = 1), lower(hex(randomblob(16)))),
        COALESCE((SELECT operation_type FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        COALESCE((SELECT actor FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        'insert',
        'conversation',
        NEW.id,
        (SELECT reason FROM archive_operation_context WHERE singleton = 1),
        json_object(
          'id', NEW.id,
          'title', NEW.title,
          'created_at', NEW.created_at,
          'updated_at', NEW.updated_at,
          'last_synced_updated_at', NEW.last_synced_updated_at,
          'current_node_id', NEW.current_node_id,
          'cache_format_version', NEW.cache_format_version,
          'is_deleted_on_web', NEW.is_deleted_on_web
        ),
        COALESCE((SELECT writer_component FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        (SELECT writer_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_generation FROM archive_operation_context WHERE singleton = 1),
        (SELECT transaction_id FROM archive_operation_context WHERE singleton = 1),
        COALESCE((SELECT actor_trust FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        (SELECT reason_code FROM archive_operation_context WHERE singleton = 1)
      );
    END;

    CREATE TRIGGER archive_conversation_update_audit
    AFTER UPDATE ON conversations
    WHEN OLD.title IS NOT NEW.title
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.updated_at IS NOT NEW.updated_at
      OR OLD.last_synced_updated_at IS NOT NEW.last_synced_updated_at
      OR OLD.current_node_id IS NOT NEW.current_node_id
      OR OLD.cache_format_version IS NOT NEW.cache_format_version
      OR OLD.is_deleted_on_web IS NOT NEW.is_deleted_on_web
    BEGIN
      INSERT INTO archive_audit_log (
        operation_id, operation_type, actor, action, entity_type, entity_id, reason, before_json, after_json,
        writer_component, writer_instance_id, store_instance_id, store_generation,
        transaction_id, actor_trust, reason_code
      ) VALUES (
        COALESCE((SELECT operation_id FROM archive_operation_context WHERE singleton = 1), lower(hex(randomblob(16)))),
        COALESCE((SELECT operation_type FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        COALESCE((SELECT actor FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        'update',
        'conversation',
        OLD.id,
        (SELECT reason FROM archive_operation_context WHERE singleton = 1),
        json_object(
          'id', OLD.id,
          'title', OLD.title,
          'created_at', OLD.created_at,
          'updated_at', OLD.updated_at,
          'last_synced_updated_at', OLD.last_synced_updated_at,
          'current_node_id', OLD.current_node_id,
          'cache_format_version', OLD.cache_format_version,
          'is_deleted_on_web', OLD.is_deleted_on_web
        ),
        json_object(
          'id', NEW.id,
          'title', NEW.title,
          'created_at', NEW.created_at,
          'updated_at', NEW.updated_at,
          'last_synced_updated_at', NEW.last_synced_updated_at,
          'current_node_id', NEW.current_node_id,
          'cache_format_version', NEW.cache_format_version,
          'is_deleted_on_web', NEW.is_deleted_on_web
        ),
        COALESCE((SELECT writer_component FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        (SELECT writer_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_generation FROM archive_operation_context WHERE singleton = 1),
        (SELECT transaction_id FROM archive_operation_context WHERE singleton = 1),
        COALESCE((SELECT actor_trust FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        (SELECT reason_code FROM archive_operation_context WHERE singleton = 1)
      );
    END;

    CREATE TRIGGER archive_conversation_update_recovery
    BEFORE UPDATE ON conversations
    WHEN OLD.title IS NOT NEW.title
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.updated_at IS NOT NEW.updated_at
      OR OLD.last_synced_updated_at IS NOT NEW.last_synced_updated_at
      OR OLD.current_node_id IS NOT NEW.current_node_id
      OR OLD.cache_format_version IS NOT NEW.cache_format_version
      OR OLD.is_deleted_on_web IS NOT NEW.is_deleted_on_web
    BEGIN
      INSERT INTO archive_recovery_records (operation_id, entity_type, entity_id, payload_json)
      VALUES (
        (SELECT operation_id FROM archive_operation_context WHERE singleton = 1),
        'conversation-revision',
        OLD.id,
        json_object(
          'id', OLD.id,
          'title', OLD.title,
          'created_at', OLD.created_at,
          'updated_at', OLD.updated_at,
          'last_synced_updated_at', OLD.last_synced_updated_at,
          'current_node_id', OLD.current_node_id,
          'cache_format_version', OLD.cache_format_version,
          'is_deleted_on_web', OLD.is_deleted_on_web
        )
      );
    END;

    CREATE TRIGGER archive_conversation_delete_recovery
    BEFORE DELETE ON conversations
    WHEN archive_destructive_allowed() = 1 AND COALESCE((
      SELECT destructive_allowed FROM archive_operation_context WHERE singleton = 1
    ), 0) = 1
    BEGIN
      INSERT INTO archive_recovery_records (operation_id, entity_type, entity_id, payload_json)
      VALUES (
        (SELECT operation_id FROM archive_operation_context WHERE singleton = 1),
        'conversation',
        OLD.id,
        json_object(
          'id', OLD.id,
          'title', OLD.title,
          'created_at', OLD.created_at,
          'updated_at', OLD.updated_at,
          'last_synced_updated_at', OLD.last_synced_updated_at,
          'current_node_id', OLD.current_node_id,
          'cache_format_version', OLD.cache_format_version,
          'is_deleted_on_web', OLD.is_deleted_on_web
        )
      );
      INSERT INTO archive_audit_log (
        operation_id, operation_type, actor, action, entity_type, entity_id, reason, before_json,
        writer_component, writer_instance_id, store_instance_id, store_generation,
        transaction_id, actor_trust, reason_code
      ) VALUES (
        (SELECT operation_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT operation_type FROM archive_operation_context WHERE singleton = 1),
        (SELECT actor FROM archive_operation_context WHERE singleton = 1),
        'delete',
        'conversation',
        OLD.id,
        (SELECT reason FROM archive_operation_context WHERE singleton = 1),
        json_object('id', OLD.id, 'title', OLD.title, 'updated_at', OLD.updated_at),
        COALESCE((SELECT writer_component FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        (SELECT writer_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_generation FROM archive_operation_context WHERE singleton = 1),
        (SELECT transaction_id FROM archive_operation_context WHERE singleton = 1),
        COALESCE((SELECT actor_trust FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        (SELECT reason_code FROM archive_operation_context WHERE singleton = 1)
      );
    END;

    CREATE TRIGGER archive_source_item_insert_audit
    AFTER INSERT ON source_items
    BEGIN
      INSERT INTO archive_audit_log (
        operation_id, operation_type, actor, action, entity_type, entity_id, reason, after_json,
        writer_component, writer_instance_id, store_instance_id, store_generation,
        transaction_id, actor_trust, reason_code
      ) VALUES (
        COALESCE((SELECT operation_id FROM archive_operation_context WHERE singleton = 1), lower(hex(randomblob(16)))),
        COALESCE((SELECT operation_type FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        COALESCE((SELECT actor FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        'insert', 'source-item', NEW.source_key,
        (SELECT reason FROM archive_operation_context WHERE singleton = 1),
        json_object(
          'source_key', NEW.source_key,
          'source_path_length', length(COALESCE(NEW.source_path, '')),
          'source_path_sha256', archive_sha256(COALESCE(NEW.source_path, '')),
          'fingerprint', NEW.fingerprint,
          'metadata_length', length(COALESCE(NEW.metadata_json, ''))
        ),
        COALESCE((SELECT writer_component FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        (SELECT writer_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_generation FROM archive_operation_context WHERE singleton = 1),
        (SELECT transaction_id FROM archive_operation_context WHERE singleton = 1),
        COALESCE((SELECT actor_trust FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        (SELECT reason_code FROM archive_operation_context WHERE singleton = 1)
      );
    END;

    CREATE TRIGGER archive_source_item_update_audit
    AFTER UPDATE ON source_items
    WHEN OLD.source_path IS NOT NEW.source_path
      OR OLD.fingerprint IS NOT NEW.fingerprint
      OR OLD.metadata_json IS NOT NEW.metadata_json
    BEGIN
      INSERT INTO archive_audit_log (
        operation_id, operation_type, actor, action, entity_type, entity_id, reason, before_json, after_json,
        writer_component, writer_instance_id, store_instance_id, store_generation,
        transaction_id, actor_trust, reason_code
      ) VALUES (
        COALESCE((SELECT operation_id FROM archive_operation_context WHERE singleton = 1), lower(hex(randomblob(16)))),
        COALESCE((SELECT operation_type FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        COALESCE((SELECT actor FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        'update', 'source-item', OLD.source_key,
        (SELECT reason FROM archive_operation_context WHERE singleton = 1),
        json_object('source_key', OLD.source_key, 'source_path_length', length(COALESCE(OLD.source_path, '')), 'source_path_sha256', archive_sha256(COALESCE(OLD.source_path, '')), 'fingerprint', OLD.fingerprint, 'metadata_length', length(COALESCE(OLD.metadata_json, ''))),
        json_object('source_key', NEW.source_key, 'source_path_length', length(COALESCE(NEW.source_path, '')), 'source_path_sha256', archive_sha256(COALESCE(NEW.source_path, '')), 'fingerprint', NEW.fingerprint, 'metadata_length', length(COALESCE(NEW.metadata_json, ''))),
        COALESCE((SELECT writer_component FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        (SELECT writer_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_generation FROM archive_operation_context WHERE singleton = 1),
        (SELECT transaction_id FROM archive_operation_context WHERE singleton = 1),
        COALESCE((SELECT actor_trust FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        (SELECT reason_code FROM archive_operation_context WHERE singleton = 1)
      );
    END;

    CREATE TRIGGER archive_source_item_update_recovery
    BEFORE UPDATE ON source_items
    WHEN OLD.source_path IS NOT NEW.source_path
      OR OLD.fingerprint IS NOT NEW.fingerprint
      OR OLD.imported_at IS NOT NEW.imported_at
      OR OLD.metadata_json IS NOT NEW.metadata_json
    BEGIN
      INSERT INTO archive_recovery_records (operation_id, entity_type, entity_id, payload_json)
      VALUES (
        (SELECT operation_id FROM archive_operation_context WHERE singleton = 1),
        'source-item-revision',
        OLD.source_key,
        json_object(
          'source_key', OLD.source_key,
          'source_path', OLD.source_path,
          'fingerprint', OLD.fingerprint,
          'imported_at', OLD.imported_at,
          'metadata_json', OLD.metadata_json
        )
      );
    END;

    CREATE TRIGGER archive_source_item_delete_recovery
    BEFORE DELETE ON source_items
    WHEN archive_destructive_allowed() = 1
      AND COALESCE((SELECT destructive_allowed FROM archive_operation_context WHERE singleton = 1), 0) = 1
    BEGIN
      INSERT INTO archive_recovery_records (operation_id, entity_type, entity_id, payload_json)
      VALUES (
        (SELECT operation_id FROM archive_operation_context WHERE singleton = 1),
        'source-item',
        OLD.source_key,
        json_object(
          'source_key', OLD.source_key,
          'source_path', OLD.source_path,
          'fingerprint', OLD.fingerprint,
          'imported_at', OLD.imported_at,
          'metadata_json', OLD.metadata_json
        )
      );
    END;

    CREATE TRIGGER archive_source_item_delete_audit
    BEFORE DELETE ON source_items
    WHEN archive_destructive_allowed() = 1
      AND COALESCE((SELECT destructive_allowed FROM archive_operation_context WHERE singleton = 1), 0) = 1
    BEGIN
      INSERT INTO archive_audit_log (
        operation_id, operation_type, actor, action, entity_type, entity_id, reason, before_json,
        writer_component, writer_instance_id, store_instance_id, store_generation,
        transaction_id, actor_trust, reason_code
      ) VALUES (
        (SELECT operation_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT operation_type FROM archive_operation_context WHERE singleton = 1),
        (SELECT actor FROM archive_operation_context WHERE singleton = 1),
        'delete', 'source-item', OLD.source_key,
        (SELECT reason FROM archive_operation_context WHERE singleton = 1),
        json_object('source_key', OLD.source_key, 'source_path_length', length(COALESCE(OLD.source_path, '')), 'source_path_sha256', archive_sha256(COALESCE(OLD.source_path, '')), 'fingerprint', OLD.fingerprint, 'metadata_length', length(COALESCE(OLD.metadata_json, ''))),
        COALESCE((SELECT writer_component FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        (SELECT writer_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_generation FROM archive_operation_context WHERE singleton = 1),
        (SELECT transaction_id FROM archive_operation_context WHERE singleton = 1),
        COALESCE((SELECT actor_trust FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        (SELECT reason_code FROM archive_operation_context WHERE singleton = 1)
      );
    END;

    CREATE TRIGGER archive_message_insert_audit
    AFTER INSERT ON messages
    BEGIN
      INSERT INTO archive_audit_log (
        operation_id, operation_type, actor, action, entity_type, entity_id, reason, after_json,
        writer_component, writer_instance_id, store_instance_id, store_generation,
        transaction_id, actor_trust, reason_code
      ) VALUES (
        COALESCE((SELECT operation_id FROM archive_operation_context WHERE singleton = 1), lower(hex(randomblob(16)))),
        COALESCE((SELECT operation_type FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        COALESCE((SELECT actor FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        'insert', 'message', NEW.id,
        (SELECT reason FROM archive_operation_context WHERE singleton = 1),
        json_object(
          'id', NEW.id,
          'conversation_id', NEW.conversation_id,
          'role', NEW.role,
          'content_length', length(COALESCE(NEW.content, '')),
          'content_sha256', archive_sha256(COALESCE(NEW.content, '')),
          'metadata_length', length(COALESCE(NEW.metadata_json, '')),
          'created_at', NEW.created_at,
          'parent_id', NEW.parent_id
        ),
        COALESCE((SELECT writer_component FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        (SELECT writer_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_generation FROM archive_operation_context WHERE singleton = 1),
        (SELECT transaction_id FROM archive_operation_context WHERE singleton = 1),
        COALESCE((SELECT actor_trust FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        (SELECT reason_code FROM archive_operation_context WHERE singleton = 1)
      );
    END;

    CREATE TRIGGER archive_message_update_recovery
    BEFORE UPDATE ON messages
    WHEN OLD.role IS NOT NEW.role
      OR OLD.content IS NOT NEW.content
      OR OLD.metadata_json IS NOT NEW.metadata_json
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.parent_id IS NOT NEW.parent_id
    BEGIN
      INSERT INTO archive_recovery_records (operation_id, entity_type, entity_id, payload_json)
      VALUES (
        COALESCE((SELECT operation_id FROM archive_operation_context WHERE singleton = 1), lower(hex(randomblob(16)))),
        'message-revision',
        OLD.id,
        json_object(
          'id', OLD.id,
          'conversation_id', OLD.conversation_id,
          'role', OLD.role,
          'content', OLD.content,
          'metadata_json', OLD.metadata_json,
          'created_at', OLD.created_at,
          'parent_id', OLD.parent_id
        )
      );
    END;

    CREATE TRIGGER archive_message_update_audit
    AFTER UPDATE ON messages
    WHEN OLD.role IS NOT NEW.role
      OR OLD.content IS NOT NEW.content
      OR OLD.metadata_json IS NOT NEW.metadata_json
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.parent_id IS NOT NEW.parent_id
    BEGIN
      INSERT INTO archive_audit_log (
        operation_id, operation_type, actor, action, entity_type, entity_id, reason, before_json, after_json,
        writer_component, writer_instance_id, store_instance_id, store_generation,
        transaction_id, actor_trust, reason_code
      ) VALUES (
        COALESCE((SELECT operation_id FROM archive_operation_context WHERE singleton = 1), lower(hex(randomblob(16)))),
        COALESCE((SELECT operation_type FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        COALESCE((SELECT actor FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        'update', 'message', OLD.id,
        (SELECT reason FROM archive_operation_context WHERE singleton = 1),
        json_object(
          'id', OLD.id,
          'conversation_id', OLD.conversation_id,
          'role', OLD.role,
          'content_length', length(COALESCE(OLD.content, '')),
          'content_sha256', archive_sha256(COALESCE(OLD.content, '')),
          'metadata_length', length(COALESCE(OLD.metadata_json, '')),
          'created_at', OLD.created_at,
          'parent_id', OLD.parent_id
        ),
        json_object(
          'id', NEW.id,
          'conversation_id', NEW.conversation_id,
          'role', NEW.role,
          'content_length', length(COALESCE(NEW.content, '')),
          'content_sha256', archive_sha256(COALESCE(NEW.content, '')),
          'metadata_length', length(COALESCE(NEW.metadata_json, '')),
          'created_at', NEW.created_at,
          'parent_id', NEW.parent_id
        ),
        COALESCE((SELECT writer_component FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        (SELECT writer_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_generation FROM archive_operation_context WHERE singleton = 1),
        (SELECT transaction_id FROM archive_operation_context WHERE singleton = 1),
        COALESCE((SELECT actor_trust FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        (SELECT reason_code FROM archive_operation_context WHERE singleton = 1)
      );
    END;

    CREATE TRIGGER archive_message_delete_recovery
    BEFORE DELETE ON messages
    WHEN archive_destructive_allowed() = 1 AND COALESCE((
      SELECT destructive_allowed FROM archive_operation_context WHERE singleton = 1
    ), 0) = 1
    BEGIN
      INSERT INTO archive_recovery_records (operation_id, entity_type, entity_id, payload_json)
      VALUES (
        (SELECT operation_id FROM archive_operation_context WHERE singleton = 1),
        'message',
        OLD.id,
        json_object(
          'id', OLD.id,
          'conversation_id', OLD.conversation_id,
          'role', OLD.role,
          'content', OLD.content,
          'metadata_json', OLD.metadata_json,
          'created_at', OLD.created_at,
          'parent_id', OLD.parent_id
        )
      );
      INSERT INTO archive_audit_log (
        operation_id, operation_type, actor, action, entity_type, entity_id, reason, before_json,
        writer_component, writer_instance_id, store_instance_id, store_generation,
        transaction_id, actor_trust, reason_code
      ) VALUES (
        (SELECT operation_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT operation_type FROM archive_operation_context WHERE singleton = 1),
        (SELECT actor FROM archive_operation_context WHERE singleton = 1),
        'delete',
        'message',
        OLD.id,
        (SELECT reason FROM archive_operation_context WHERE singleton = 1),
        json_object(
          'id', OLD.id,
          'conversation_id', OLD.conversation_id,
          'role', OLD.role,
          'content_length', length(COALESCE(OLD.content, '')),
          'content_sha256', archive_sha256(COALESCE(OLD.content, '')),
          'metadata_length', length(COALESCE(OLD.metadata_json, ''))
        ),
        COALESCE((SELECT writer_component FROM archive_operation_context WHERE singleton = 1), 'unscoped-sql'),
        (SELECT writer_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_instance_id FROM archive_operation_context WHERE singleton = 1),
        (SELECT store_generation FROM archive_operation_context WHERE singleton = 1),
        (SELECT transaction_id FROM archive_operation_context WHERE singleton = 1),
        COALESCE((SELECT actor_trust FROM archive_operation_context WHERE singleton = 1), 'unknown'),
        (SELECT reason_code FROM archive_operation_context WHERE singleton = 1)
      );
    END;
  `);

  // A crashed process must never leave the persistent guard open. Normal
  // destructive operations also reset this row before committing.
  resetArchiveOperationContext(db, { withContextWrite });
}

module.exports = {
  ARCHIVE_SAFETY_SCHEMA_VERSION,
  ARCHIVE_SAFETY_TRIGGER_COUNT,
  installArchiveSafetySchema,
  resetArchiveOperationContext,
};
