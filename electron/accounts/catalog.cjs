const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

class AccountCatalog {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        label TEXT NOT NULL,
        db_path TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_config_json TEXT,
        legacy_mode TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_accounts_agent_label
        ON accounts(agent_id, label COLLATE NOCASE);
    `);
  }

  listAccounts() {
    return this.db.prepare(`
      SELECT * FROM accounts
      ORDER BY agent_id, is_default DESC, label COLLATE NOCASE, id
    `).all();
  }

  getAccount(id) {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) || null;
  }

  updateLabel(id, label) {
    this.db.prepare(`
      UPDATE accounts
      SET label = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(label, id);
    return this.getAccount(id);
  }

  upsertAccount(account) {
    this.db.prepare(`
      INSERT INTO accounts (
        id, agent_id, label, db_path, source_kind, source_config_json, legacy_mode, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        label = excluded.label,
        db_path = excluded.db_path,
        source_kind = excluded.source_kind,
        source_config_json = excluded.source_config_json,
        legacy_mode = excluded.legacy_mode,
        is_default = excluded.is_default,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      account.id,
      account.agentId,
      account.label,
      account.dbPath,
      account.sourceKind,
      account.sourceConfig == null ? null : JSON.stringify(account.sourceConfig),
      account.legacyMode || null,
      account.isDefault ? 1 : 0
    );
    return this.getAccount(account.id);
  }

  deleteAccount(id) {
    return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  close() {
    this.db.close();
  }
}

module.exports = AccountCatalog;
