const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function stageConversations(conversations, normalize) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-import-stage-'));
  let staging;
  try {
    staging = new Database(path.join(root, 'normalized.db'));
    staging.exec('CREATE TABLE entries (position INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const insert = staging.prepare('INSERT INTO entries VALUES (?, ?)');
    let count = 0, messages = 0, index = 0;
    staging.transaction(() => {
      for (const entry of conversations) {
        const normalized = normalize(entry, index++);
        if (!normalized) continue;
        insert.run(count++, JSON.stringify(normalized));
        messages += normalized.messages.length;
      }
    })();
    const rows = staging.prepare('SELECT value FROM entries ORDER BY position');
    return { count, messages,
      *[Symbol.iterator]() { for (const row of rows.iterate()) yield JSON.parse(row.value); },
      close() { staging.close(); fs.rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    staging?.close();
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { stageConversations };
