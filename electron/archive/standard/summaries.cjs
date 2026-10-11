// Disposable derived data. Content/revisions remain authoritative; invalidation
// is committed by SQLite triggers in the same transaction as every content write.
const VERSION = 2;
const unixTime = (column) => `CASE
  WHEN typeof(${column}) IN ('integer', 'real') THEN CAST(${column} AS REAL)
  WHEN ${column} IS NULL THEN NULL
  WHEN instr(CAST(${column} AS TEXT), '-') = 0
    AND instr(CAST(${column} AS TEXT), 'T') = 0
    AND instr(CAST(${column} AS TEXT), ':') = 0 THEN CAST(${column} AS REAL)
  ELSE (julianday(${column}) - 2440587.5) * 86400.0 END`;

function installSummaries(db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS derived_summary_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS derived_conversation_summaries (
        conversation_id TEXT PRIMARY KEY, message_count INTEGER NOT NULL,
        display_count INTEGER NOT NULL, last_message_at REAL, latest_visible_at REAL,
        invalid_metadata_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS derived_summary_dirty (conversation_id TEXT PRIMARY KEY);
    `);
    if (!db.prepare('PRAGMA table_info(derived_conversation_summaries)').all().some((column) => column.name === 'invalid_metadata_count')) {
      db.exec('ALTER TABLE derived_conversation_summaries ADD COLUMN invalid_metadata_count INTEGER NOT NULL DEFAULT 0');
    }
    const version = db.prepare('SELECT version FROM derived_summary_version').get()?.version;
    const triggers = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'summary_dirty_%'").get().count;
    if (version === VERSION && triggers === 3) return;
    db.exec(`
      DROP TRIGGER IF EXISTS summary_dirty_insert;
      DROP TRIGGER IF EXISTS summary_dirty_update;
      DROP TRIGGER IF EXISTS summary_dirty_delete;
      CREATE TRIGGER summary_dirty_insert AFTER INSERT ON messages BEGIN
        INSERT INTO derived_summary_dirty SELECT NEW.conversation_id WHERE NOT EXISTS (SELECT 1 FROM derived_summary_dirty WHERE conversation_id = NEW.conversation_id);
      END;
      CREATE TRIGGER summary_dirty_update AFTER UPDATE ON messages BEGIN
        INSERT INTO derived_summary_dirty SELECT OLD.conversation_id WHERE NOT EXISTS (SELECT 1 FROM derived_summary_dirty WHERE conversation_id = OLD.conversation_id);
        INSERT INTO derived_summary_dirty SELECT NEW.conversation_id WHERE NOT EXISTS (SELECT 1 FROM derived_summary_dirty WHERE conversation_id = NEW.conversation_id);
      END;
      CREATE TRIGGER summary_dirty_delete AFTER DELETE ON messages BEGIN
        INSERT INTO derived_summary_dirty SELECT OLD.conversation_id WHERE NOT EXISTS (SELECT 1 FROM derived_summary_dirty WHERE conversation_id = OLD.conversation_id);
      END;
      DELETE FROM derived_conversation_summaries;
      INSERT OR IGNORE INTO derived_summary_dirty SELECT DISTINCT conversation_id FROM messages;
      DELETE FROM derived_summary_version;
    `);
    db.prepare('INSERT INTO derived_summary_version VALUES (?)').run(VERSION);
  })();
}

function createSummaryReader(db) {
  installSummaries(db);
  const dirty = db.prepare('SELECT conversation_id FROM derived_summary_dirty');
  const clear = db.prepare('DELETE FROM derived_summary_dirty WHERE conversation_id = ?');
  const refresh = db.prepare(`
    INSERT OR REPLACE INTO derived_conversation_summaries
    WITH eligible AS (
      SELECT id, role, created_at, ${unixTime('created_at')} AS timestamp,
        COALESCE(json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json END, '$.source'), '') AS source,
        COALESCE(json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json END, '$.phase'), '') AS phase
      FROM messages WHERE conversation_id = ? AND role IN ('user', 'assistant')
        AND trim(COALESCE(content, '')) <> ''
        AND COALESCE(json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json END, '$.is_thinking_preamble_message'), 0) != 1
        AND COALESCE(json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json END, '$.is_visually_hidden_from_conversation'), 0) != 1
    ), ordered AS (
      SELECT *, LAG(role) OVER (ORDER BY created_at, id) AS previous_role FROM eligible
    ), runs AS (
      SELECT *, SUM(CASE WHEN role = 'assistant' AND source IN ('codex-local', 'gemini-cli-local')
        AND COALESCE(previous_role, '') != 'assistant' THEN 1 ELSE 0 END)
        OVER (ORDER BY created_at, id ROWS UNBOUNDED PRECEDING) AS assistant_run FROM ordered
    ), responses AS (
      SELECT assistant_run FROM runs WHERE role = 'assistant' AND source IN ('codex-local', 'gemini-cli-local')
      GROUP BY assistant_run HAVING MAX(CASE WHEN phase != 'commentary' THEN 1 ELSE 0 END) = 1
    )
    SELECT ?, (SELECT COUNT(*) FROM messages WHERE conversation_id = ?),
      (SELECT COUNT(*) FROM eligible WHERE NOT (role = 'assistant' AND source IN ('codex-local', 'gemini-cli-local')))
        + (SELECT COUNT(*) FROM responses),
      (SELECT MAX(${unixTime('created_at')}) FROM messages WHERE conversation_id = ?),
      (SELECT MAX(timestamp) FROM eligible),
      (SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND role IN ('user', 'assistant')
        AND trim(COALESCE(content, '')) <> '' AND metadata_json IS NOT NULL AND NOT json_valid(metadata_json))
  `);
  const flush = db.transaction(() => {
    for (const { conversation_id: id } of dirty.all()) {
      refresh.run(id, id, id, id, id);
      clear.run(id);
    }
  });
  return { flush };
}

module.exports = { createSummaryReader, unixTime };
