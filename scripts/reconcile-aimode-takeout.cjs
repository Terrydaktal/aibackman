#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const Database = require('better-sqlite3');
const {
  buildDeterministicId,
  normalizeAiModeTitle,
  parseAiModeTakeout,
} = require('../electron/aimode-takeout.cjs');

function parseArgs(argv) {
  const out = {
    dbPath: '',
    takeoutPath: '',
    yes: false,
    apply: false,
    prefer: '',
    importTakeoutOnly: '',
    keepDbOnly: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--db') {
      out.dbPath = argv[i + 1] || '';
      i += 1;
    } else if (arg.startsWith('--db=')) {
      out.dbPath = arg.slice('--db='.length);
    } else if (arg === '--takeout') {
      out.takeoutPath = argv[i + 1] || '';
      i += 1;
    } else if (arg.startsWith('--takeout=')) {
      out.takeoutPath = arg.slice('--takeout='.length);
    } else if (arg === '--yes' || arg === '-y') {
      out.yes = true;
    } else if (arg === '--apply') {
      out.apply = true;
    } else if (arg === '--prefer') {
      out.prefer = String(argv[i + 1] || '').toLowerCase();
      i += 1;
    } else if (arg.startsWith('--prefer=')) {
      out.prefer = arg.slice('--prefer='.length).toLowerCase();
    } else if (arg === '--import-takeout-only') {
      out.importTakeoutOnly = String(argv[i + 1] || '').toLowerCase();
      i += 1;
    } else if (arg.startsWith('--import-takeout-only=')) {
      out.importTakeoutOnly = arg.slice('--import-takeout-only='.length).toLowerCase();
    } else if (arg === '--keep-db-only') {
      out.keepDbOnly = String(argv[i + 1] || '').toLowerCase();
      i += 1;
    } else if (arg.startsWith('--keep-db-only=')) {
      out.keepDbOnly = arg.slice('--keep-db-only='.length).toLowerCase();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/reconcile-aimode-takeout.cjs --db /path/to/aimode.db --takeout /path/to/MyActivity.json [options]

Options:
  --apply                     Actually update the database after diagnostics.
  --yes, -y                   Non-interactive mode. Requires all write choices to be supplied.
  --prefer takeout|database   For chats found in both but with different messages.
  --import-takeout-only yes|no
                              Whether to import chats only found in takeout.
  --keep-db-only yes|no       Whether to keep chats only found in the database.
  --help, -h                  Show this help text.
`);
}

function normalizeContent(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function messageFingerprint(messages) {
  const data = messages
    .map((msg) => `${msg.role}\n${normalizeContent(msg.content)}`)
    .join('\n\n---\n\n');
  return buildDeterministicId(data);
}

function timestampLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown';
  return new Date(seconds * 1000).toISOString();
}

function loadDatabaseChats(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const conversations = db.prepare(`
      SELECT id, title, created_at, updated_at, current_node_id, is_deleted_on_web
      FROM conversations
      ORDER BY COALESCE(updated_at, created_at, 0) ASC, title ASC, id ASC
    `).all();
    const getMessages = db.prepare(`
      SELECT id, conversation_id, role, content, metadata_json, created_at, parent_id
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `);

    return conversations.map((conv) => {
      const messages = getMessages.all(conv.id)
        .filter((msg) => (msg.role === 'user' || msg.role === 'assistant'))
        .map((msg) => ({
          ...msg,
          content: normalizeContent(msg.content),
        }))
        .filter((msg) => msg.content);
      const createdAt = Number(conv.created_at || conv.updated_at || 0);
      const updatedAt = Number(conv.updated_at || conv.created_at || createdAt || 0);
      const firstUser = messages.find((msg) => msg.role === 'user')?.content || '';
      const firstAssistant = messages.find((msg) => msg.role === 'assistant')?.content || '';
      return {
        source: 'database',
        id: conv.id,
        title: normalizeAiModeTitle(conv.title || ''),
        titleRaw: String(conv.title || ''),
        created_at: createdAt,
        updated_at: updatedAt,
        current_node_id: conv.current_node_id || null,
        is_deleted_on_web: Number(conv.is_deleted_on_web || 0),
        messages,
        messageCount: messages.length,
        firstUserNorm: normalizeContent(firstUser).toLowerCase(),
        firstAssistantNorm: normalizeContent(firstAssistant).toLowerCase(),
        fingerprint: messageFingerprint(messages),
      };
    });
  } finally {
    db.close();
  }
}

function loadTakeoutChats(takeoutPath) {
  const parsed = parseAiModeTakeout(takeoutPath);
  return {
    sourceItems: parsed.sourceItems,
    conversations: parsed.conversations.map((conv) => {
      const messages = conv.messages.map((msg) => ({
        ...msg,
        content: normalizeContent(msg.content),
      }));
      const firstUser = messages.find((msg) => msg.role === 'user')?.content || '';
      const firstAssistant = messages.find((msg) => msg.role === 'assistant')?.content || '';
      return {
        ...conv,
        source: 'takeout',
        messageCount: messages.length,
        messages,
        firstUserNorm: normalizeContent(firstUser).toLowerCase(),
        firstAssistantNorm: normalizeContent(firstAssistant).toLowerCase(),
        fingerprint: messageFingerprint(messages),
      };
    }),
  };
}

function pairByFingerprint(takeoutChats, dbChats) {
  const takeoutBuckets = new Map();
  const dbBuckets = new Map();
  for (const chat of takeoutChats) {
    if (!takeoutBuckets.has(chat.fingerprint)) takeoutBuckets.set(chat.fingerprint, []);
    takeoutBuckets.get(chat.fingerprint).push(chat);
  }
  for (const chat of dbChats) {
    if (!dbBuckets.has(chat.fingerprint)) dbBuckets.set(chat.fingerprint, []);
    dbBuckets.get(chat.fingerprint).push(chat);
  }

  const matches = [];
  const matchedTakeoutIds = new Set();
  const matchedDbIds = new Set();

  for (const [fingerprint, takeoutList] of takeoutBuckets.entries()) {
    const dbList = dbBuckets.get(fingerprint);
    if (!dbList || dbList.length === 0) continue;
    const sortedTakeout = [...takeoutList].sort((a, b) => a.created_at - b.created_at);
    const sortedDb = [...dbList].sort((a, b) => a.created_at - b.created_at);
    const pairCount = Math.min(sortedTakeout.length, sortedDb.length);
    for (let i = 0; i < pairCount; i += 1) {
      const takeout = sortedTakeout[i];
      const database = sortedDb[i];
      matchedTakeoutIds.add(takeout.id);
      matchedDbIds.add(database.id);
      matches.push({ takeout, database, identical: true });
    }
  }

  return { matches, matchedTakeoutIds, matchedDbIds };
}

function scoreCandidate(takeout, database) {
  let score = 0;
  if (takeout.title.toLowerCase() === database.title.toLowerCase()) score += 45;
  if (takeout.firstUserNorm && takeout.firstUserNorm === database.firstUserNorm) score += 35;
  if (takeout.firstAssistantNorm && takeout.firstAssistantNorm === database.firstAssistantNorm) score += 10;
  if (takeout.messageCount === database.messageCount) score += 5;

  const deltaSeconds = Math.abs((takeout.created_at || 0) - (database.created_at || 0));
  if (deltaSeconds <= 60) score += 25;
  else if (deltaSeconds <= 3600) score += 15;
  else if (deltaSeconds <= 86400) score += 8;
  else if (deltaSeconds <= 7 * 86400) score += 3;

  const hasStrongAnchor = (
    takeout.title.toLowerCase() === database.title.toLowerCase()
    || (takeout.firstUserNorm && takeout.firstUserNorm === database.firstUserNorm)
  );
  if (!hasStrongAnchor) return null;
  if (score < 45) return null;
  return { score, deltaSeconds };
}

function pairLikelyMatches(unmatchedTakeout, unmatchedDb) {
  const candidates = [];
  for (const takeout of unmatchedTakeout) {
    for (const database of unmatchedDb) {
      const score = scoreCandidate(takeout, database);
      if (!score) continue;
      candidates.push({ takeout, database, ...score });
    }
  }

  candidates.sort((a, b) => (
    b.score - a.score
    || a.deltaSeconds - b.deltaSeconds
    || a.takeout.title.localeCompare(b.takeout.title)
  ));

  const matches = [];
  const usedTakeout = new Set();
  const usedDb = new Set();
  for (const candidate of candidates) {
    if (usedTakeout.has(candidate.takeout.id) || usedDb.has(candidate.database.id)) continue;
    usedTakeout.add(candidate.takeout.id);
    usedDb.add(candidate.database.id);
    matches.push({
      takeout: candidate.takeout,
      database: candidate.database,
      identical: false,
      score: candidate.score,
      deltaSeconds: candidate.deltaSeconds,
    });
  }

  return { matches, usedTakeout, usedDb };
}

function firstDifference(messagesA, messagesB) {
  const max = Math.max(messagesA.length, messagesB.length);
  for (let i = 0; i < max; i += 1) {
    const a = messagesA[i];
    const b = messagesB[i];
    if (!a || !b) {
      return {
        index: i,
        reason: !a ? 'takeout missing trailing message(s)' : 'database missing trailing message(s)',
      };
    }
    if (a.role !== b.role) {
      return {
        index: i,
        reason: `role mismatch: takeout=${a.role}, database=${b.role}`,
      };
    }
    if (normalizeContent(a.content) !== normalizeContent(b.content)) {
      return {
        index: i,
        reason: 'content mismatch',
      };
    }
  }
  return null;
}

function summarizeMatches(takeoutChats, dbChats) {
  const exact = pairByFingerprint(takeoutChats, dbChats);
  const unmatchedTakeout = takeoutChats.filter((chat) => !exact.matchedTakeoutIds.has(chat.id));
  const unmatchedDb = dbChats.filter((chat) => !exact.matchedDbIds.has(chat.id));
  const likely = pairLikelyMatches(unmatchedTakeout, unmatchedDb);

  const matchedTakeoutIds = new Set([...exact.matchedTakeoutIds, ...likely.usedTakeout]);
  const matchedDbIds = new Set([...exact.matchedDbIds, ...likely.usedDb]);
  const differentMatches = likely.matches.map((match) => ({
    ...match,
    diff: firstDifference(match.takeout.messages, match.database.messages),
  }));

  return {
    identicalMatches: exact.matches,
    differentMatches,
    onlyTakeout: takeoutChats.filter((chat) => !matchedTakeoutIds.has(chat.id)),
    onlyDatabase: dbChats.filter((chat) => !matchedDbIds.has(chat.id)),
  };
}

function shortText(value, max = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function printDiagnostics(report, sourceItems, takeoutChats, dbChats) {
  const bothCount = report.identicalMatches.length + report.differentMatches.length;
  console.log('AI Mode takeout reconciliation diagnostics');
  console.log(`Takeout source items: ${sourceItems}`);
  console.log(`Takeout chats parsed: ${takeoutChats.length}`);
  console.log(`Database chats: ${dbChats.length}`);
  console.log(`Chats in both: ${bothCount}`);
  console.log(`  Identical: ${report.identicalMatches.length}`);
  console.log(`  Different: ${report.differentMatches.length}`);
  console.log(`Only in takeout: ${report.onlyTakeout.length}`);
  console.log(`Only in database: ${report.onlyDatabase.length}`);
  console.log('');

  console.log('Matched chats');
  const matched = [
    ...report.identicalMatches.map((match) => ({
      status: 'identical',
      title: match.takeout.title,
      takeoutTime: timestampLabel(match.takeout.created_at),
      dbTime: timestampLabel(match.database.created_at),
      takeoutMsgs: match.takeout.messageCount,
      dbMsgs: match.database.messageCount,
      detail: '',
    })),
    ...report.differentMatches.map((match) => ({
      status: 'different',
      title: match.takeout.title || match.database.title,
      takeoutTime: timestampLabel(match.takeout.created_at),
      dbTime: timestampLabel(match.database.created_at),
      takeoutMsgs: match.takeout.messageCount,
      dbMsgs: match.database.messageCount,
      detail: match.diff ? `first diff #${match.diff.index + 1}: ${match.diff.reason}` : `score=${match.score}`,
    })),
  ].sort((a, b) => a.title.localeCompare(b.title) || a.takeoutTime.localeCompare(b.takeoutTime));

  for (const row of matched) {
    console.log(
      `[${row.status}] ${row.title || 'AI Mode Chat'} | takeout ${row.takeoutMsgs} @ ${row.takeoutTime} | database ${row.dbMsgs} @ ${row.dbTime}${row.detail ? ` | ${row.detail}` : ''}`
    );
  }
  if (matched.length === 0) console.log('(none)');
  console.log('');

  console.log('Only in takeout');
  for (const chat of report.onlyTakeout) {
    console.log(`[takeout-only] ${chat.title} | ${chat.messageCount} msgs | ${timestampLabel(chat.created_at)} | ${shortText(chat.firstUserNorm)}`);
  }
  if (report.onlyTakeout.length === 0) console.log('(none)');
  console.log('');

  console.log('Only in database');
  for (const chat of report.onlyDatabase) {
    console.log(`[database-only] ${chat.title} | ${chat.messageCount} msgs | ${timestampLabel(chat.created_at)} | ${shortText(chat.firstUserNorm)}`);
  }
  if (report.onlyDatabase.length === 0) console.log('(none)');
  console.log('');
}

function ensureFileExists(filePath, label) {
  if (!filePath) throw new Error(`Missing ${label} path.`);
  if (!fs.existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
}

async function askChoice(rl, prompt, allowed, fallback = '') {
  while (true) {
    const raw = (await rl.question(prompt)).trim().toLowerCase();
    const answer = raw || fallback;
    if (allowed.includes(answer)) return answer;
    console.log(`Choose one of: ${allowed.join(', ')}`);
  }
}

function buildFinalDataset(report, options) {
  const finalChats = [];

  for (const match of report.identicalMatches) {
    finalChats.push(match.database);
  }
  for (const match of report.differentMatches) {
    finalChats.push(options.prefer === 'takeout' ? match.takeout : match.database);
  }
  if (options.importTakeoutOnly) {
    finalChats.push(...report.onlyTakeout);
  }
  if (options.keepDbOnly) {
    finalChats.push(...report.onlyDatabase);
  }

  return finalChats.sort((a, b) => (
    (Number(a.updated_at || a.created_at || 0) - Number(b.updated_at || b.created_at || 0))
    || a.title.localeCompare(b.title)
    || a.id.localeCompare(b.id)
  ));
}

function backupDatabase(dbPath) {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dir, `${base}.${stamp}.bak`);
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

function writeDatabase(dbPath, chats) {
  const db = new Database(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.transaction(() => {
      db.prepare('DELETE FROM messages').run();
      db.prepare('DELETE FROM conversations').run();
      db.prepare('DELETE FROM cache_failures').run();

      const insertConversation = db.prepare(`
        INSERT INTO conversations (id, title, created_at, updated_at, current_node_id, is_deleted_on_web)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertMessage = db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const chat of chats) {
        insertConversation.run(
          chat.id,
          chat.title,
          chat.created_at,
          chat.updated_at,
          chat.current_node_id || null,
          Number(chat.is_deleted_on_web || 0)
        );
        for (const msg of chat.messages) {
          insertMessage.run(
            msg.id,
            msg.conversation_id,
            msg.role,
            msg.content,
            msg.metadata_json ?? null,
            msg.created_at,
            msg.parent_id ?? null
          );
        }
      }
    })();
  } finally {
    db.close();
  }
}

async function resolveWriteOptions(args, report) {
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !args.yes;
  let prefer = args.prefer;
  let importTakeoutOnly = args.importTakeoutOnly;
  let keepDbOnly = args.keepDbOnly;

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (report.differentMatches.length > 0 && !prefer) {
        prefer = await askChoice(
          rl,
          'For chats present in both but different, keep which version? [takeout/database] (database): ',
          ['takeout', 'database'],
          'database'
        );
      }
      if (!importTakeoutOnly) {
        importTakeoutOnly = await askChoice(
          rl,
          'Import chats only found in takeout? [yes/no] (yes): ',
          ['yes', 'no'],
          'yes'
        );
      }
      if (!keepDbOnly) {
        keepDbOnly = await askChoice(
          rl,
          'Keep chats only found in the database? [yes/no] (yes): ',
          ['yes', 'no'],
          'yes'
        );
      }
      const proceed = await askChoice(
        rl,
        'Proceed with updating the database? A timestamped backup will be created first. [yes/no] (no): ',
        ['yes', 'no'],
        'no'
      );
      return {
        proceed: proceed === 'yes',
        prefer: prefer || 'database',
        importTakeoutOnly: importTakeoutOnly !== 'no',
        keepDbOnly: keepDbOnly !== 'no',
      };
    } finally {
      rl.close();
    }
  }

  if (!args.apply) {
    return {
      proceed: false,
      prefer: prefer || 'database',
      importTakeoutOnly: importTakeoutOnly !== 'no',
      keepDbOnly: keepDbOnly !== 'no',
    };
  }

  if (!prefer && report.differentMatches.length > 0) {
    throw new Error('Non-interactive apply requires --prefer takeout|database when differing chats exist.');
  }
  if (!importTakeoutOnly) {
    throw new Error('Non-interactive apply requires --import-takeout-only yes|no.');
  }
  if (!keepDbOnly) {
    throw new Error('Non-interactive apply requires --keep-db-only yes|no.');
  }

  return {
    proceed: true,
    prefer: prefer || 'database',
    importTakeoutOnly: importTakeoutOnly !== 'no',
    keepDbOnly: keepDbOnly !== 'no',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  ensureFileExists(args.dbPath, 'Database');
  ensureFileExists(args.takeoutPath, 'Takeout');

  const dbChats = loadDatabaseChats(args.dbPath);
  const takeoutBundle = loadTakeoutChats(args.takeoutPath);
  const report = summarizeMatches(takeoutBundle.conversations, dbChats);
  printDiagnostics(report, takeoutBundle.sourceItems, takeoutBundle.conversations, dbChats);

  const options = await resolveWriteOptions(args, report);
  if (!options.proceed) {
    console.log('No database changes applied.');
    return;
  }

  const finalChats = buildFinalDataset(report, options);
  const backupPath = backupDatabase(args.dbPath);
  writeDatabase(args.dbPath, finalChats);

  console.log(`Backup created: ${backupPath}`);
  console.log(`Database updated: ${args.dbPath}`);
  console.log(`Final chat count: ${finalChats.length}`);
  console.log(`Policy for differing matched chats: ${options.prefer}`);
  console.log(`Imported takeout-only chats: ${options.importTakeoutOnly ? 'yes' : 'no'}`);
  console.log(`Kept database-only chats: ${options.keepDbOnly ? 'yes' : 'no'}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
