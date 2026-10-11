const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Sqlite = require('better-sqlite3');
const ChatDatabase = require('../electron/database.cjs');
const { DbSearchWorker } = ChatDatabase;
const { DurableAuditJournal } = require('../electron/archive/safety/journal.cjs');
const { readConversationState, writeNormalizedArchive } = require('../electron/archive/standard/index.cjs');
const { jsonArray } = require('../electron/agents/json-collection.cjs');
const { ArchiveAssets, coalesceResponseRequests } = require('../electron/resources/assets.cjs');
const { ByteCache } = require('../electron/resources/byte-cache.cjs');
const { runArchiveWorker } = require('../electron/providers/shared/archive-worker.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-optimization-tests-'));
const dbPath = path.join(root, 'synthetic.db');
const sql = fs.readFileSync(path.join(__dirname, 'fixtures/legacy-stats.sql'), 'utf8');

function checkStats(db) {
  const reference = new Sqlite(dbPath, { readonly: true });
  try {
    const old = reference.prepare(sql).get();
    assert.deepEqual(db.getStats(), { conversationCount: old.conversation_count,
      messageCount: old.message_count, cachedCount: old.cached_count,
      latestMessageAt: old.latest_message_at, latestUpdatedAt: old.latest_updated_at });
  } finally { reference.close(); }
}

function message(id, conversationId, role, content, createdAt, metadata = {}) {
  return { id, conversation_id: conversationId, role, content, created_at: createdAt,
    metadata_json: JSON.stringify(metadata), parent_id: null };
}

async function summaries() {
  let db = new ChatDatabase(dbPath);
  try {
    db.runArchiveOperation({ type: 'fixture', reason: 'Synthetic performance fixtures.' }, () => {
      for (let index = 0; index < 80; index += 1) {
        const id = `conversation-${index}`;
        db.upsertConversation({ id, title: id, created_at: 1, updated_at: index + 1, is_deleted_on_web: index % 4 === 0 ? 1 : 0 });
        for (let item = 0; item < 45; item += 1) db.upsertMessage(message(`${id}-${item}`, id,
          ['user', 'assistant', 'assistant', 'tool', 'system'][item % 5], item % 9 === 0 ? '  ' : `fixture ${item}`, item,
          { source: ['codex-local', 'gemini-cli-local', 'chatgpt-export'][index % 3], phase: item % 4 ? 'final' : 'commentary',
            is_visually_hidden_from_conversation: item % 11 === 0, is_thinking_preamble_message: item % 13 === 0 }));
      }
    });
    checkStats(db);
    const cached = db.getStats();
    const before = db.getConversations();
    assert.equal(before.length, 80);
    assert.ok(before.every((conversation) => conversation.message_count === 45 && conversation.last_message_at === 44));
    assert.throws(() => db.runArchiveOperation({ type: 'rollback', reason: 'Synthetic rollback.' }, () => {
      db.upsertMessage(message('rolled-back', 'conversation-1', 'assistant', 'not committed', 999));
      throw new Error('rollback fixture');
    }), /rollback fixture/);
    assert.deepEqual(db.getStats(), cached);
    assert.equal(db.getMessage('rolled-back'), null);
    db.close();
    db = new ChatDatabase(dbPath);
    checkStats(db);
    assert.deepEqual(db.getStats(), cached);
    const other = new ChatDatabase(dbPath);
    try {
      other.upsertMessage(message('external', 'conversation-1', 'assistant', 'fixture new message', '2026-10-09T12:00:00Z'));
      checkStats(db);
      assert.equal(db.getConversations()[0].id, 'conversation-1');
      other.upsertConversation({ id: 'conversation-1', title: 'changed', created_at: 1, updated_at: 2, is_deleted_on_web: 1 });
      checkStats(db);
    } finally { other.close(); }
    db.upsertConversation({ id: 'malformed', title: 'Synthetic corrupt metadata', created_at: 1, updated_at: 1 });
    db.upsertMessage({ ...message('malformed-message', 'malformed', 'user', 'fixture', 1), metadata_json: 'invalid' });
    assert.ok(db.getConversations().some((conversation) => conversation.id === 'malformed'));
    assert.throws(() => db.getStats(), /malformed JSON/);
    db.upsertConversation({ id: 'malformed', is_deleted_on_web: 1 });
    assert.throws(() => db.getStats(), /malformed JSON/);
    db.upsertMessage({ ...message('malformed-message', 'malformed', 'user', 'fixture', 1), metadata_json: '{}' });
    checkStats(db);
    const rows = [message('parent', 'tree', 'user', 'parent', 1), message('alternate', 'tree', 'assistant', 'alternate', 2),
      { ...message('child', 'tree', 'assistant', 'child', 3), parent_id: 'parent' }];
    let reads = 0;
    const fake = { getConversation: () => ({ current_node_id: 'child' }), getMessages: () => { reads += 1; return rows; } };
    const state = readConversationState(fake, 'tree', { compact: true });
    assert.equal(reads, 1);
    assert.deepEqual(state.currentMessageIds, ['parent', 'child']);
    assert.equal(state.allMessages.length, 3);
    const start = db.getArchiveCounts();
    function* invalid() {
      yield { id: 'not-imported', messages: [message('not-imported', 'not-imported', 'user', 'fixture', 1)] };
      throw new Error('parse failure');
    }
    assert.throws(() => writeNormalizedArchive({ db, conversations: invalid() }), /parse failure/);
    assert.deepEqual(db.getArchiveCounts(), start);
    assert.equal(db.auditJournal.verifyIntegrity().valid, true);
  } finally { db.close(); }
}

function jsonStreaming() {
  const fixture = path.join(root, 'array.json');
  const values = [{ text: '💡 "quoted" \\ [ ]', nested: [1, { a: 'b' }] }, null, 1, 'é', true];
  fs.writeFileSync(fixture, JSON.stringify(values));
  for (const chunk of [1, 2, 3, 17, 65536]) assert.deepEqual([...jsonArray(fixture, chunk)], values);
  for (const invalid of ['[1,]', '[,1]', '[1]false', '[{"broken":1}', '[1 2]', '[] []', '\uFEFF[1]', '[1]\u00A0', '[\u00A0]']) {
    fs.writeFileSync(fixture, invalid);
    assert.throws(() => [...jsonArray(fixture, 2)], SyntaxError);
  }
}

function journalReference(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  let previous = null, legacy = 0;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { return { valid: false, records: lines.length, legacyRecords: legacy, first_invalid_sequence: 'invalid-json' }; }
    if (!record.integrity?.hash) { legacy += 1; previous = crypto.createHash('sha256').update(line).digest('hex'); continue; }
    const { integrity, ...payload } = record;
    const expected = crypto.createHash('sha256').update(`${previous || ''}\0${JSON.stringify(payload)}`).digest('hex');
    if (integrity.previous_hash !== previous || integrity.hash !== expected) return { valid: false, records: lines.length, legacyRecords: legacy, first_invalid_sequence: record.sequence };
    previous = integrity.hash;
  }
  return { valid: true, records: lines.length, legacyRecords: legacy };
}

function audits() {
  const journal = new DurableAuditJournal(path.join(root, 'journal'));
  journal.append({ action: 'fixture', details: { unicode: '💡'.repeat(14000) } });
  journal.append({ action: 'second', details: { unicode: '💡'.repeat(14000) } });
  const original = fs.readFileSync(journal.filePath, 'utf8');
  const legacy = JSON.stringify({ sequence: 1, action: 'legacy 💡' });
  for (const text of [original, ` \n${original}\n \t`, legacy, `${legacy}\n \n${legacy}`, `${legacy}\n\n${legacy}\n`,
    original.replace('fixture', 'tampered'), original + 'broken\n', '', ' \n ']) {
    fs.writeFileSync(journal.filePath, text);
    assert.deepEqual(journal.verifyIntegrity(), journalReference(text));
  }
}

async function assets() {
  const directory = path.join(root, 'assets');
  fs.mkdirSync(directory);
  const file = path.join(directory, 'fixture.bin');
  fs.writeFileSync(file, 'one');
  const assets = new ArchiveAssets(8);
  const responses = await Promise.all([assets.read(file, directory), assets.read(file, directory)]);
  assert.deepEqual(responses.map(String), ['one', 'one']);
  assert.strictEqual(responses[0], responses[1]);
  fs.writeFileSync(file, 'two');
  assert.equal(String(await assets.read(file, directory)), 'two');
  fs.symlinkSync(file, path.join(directory, 'link'));
  await assert.rejects(assets.read(path.join(directory, 'link'), directory), /regular file/);
  await assert.rejects(assets.read(dbPath, directory), /outside/);
  const cache = new ByteCache(8, 2);
  cache.set('one', 1, 3); cache.set('two', 2, 2);
  assert.equal(cache.get('one'), undefined);
  assert.equal(cache.get('two'), 2);
  cache.set('huge', 9, 100);
  assert.equal(cache.get('huge'), undefined);
  let fetches = 0;
  const fetch = coalesceResponseRequests(async () => { fetches += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return new Response('image fixture', { status: 200, headers: { 'content-type': 'image/png' } }); });
  const [left, right] = await Promise.all([fetch('image'), fetch('image')]);
  assert.equal(fetches, 1);
  assert.equal(await left.text(), 'image fixture');
  assert.equal(await right.text(), 'image fixture');
}

async function cancellation() {
  const helper = path.join(root, 'search-fixture.cjs');
  fs.writeFileSync(helper, `require('readline').createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line); if(p.query==='hang')return; setTimeout(()=>process.stdout.write(JSON.stringify({id:p.id,ok:true,output:{total:1,results:[{id:p.query}]}})+'\\n'),10);});`);
  const worker = new DbSearchWorker(dbPath, { binaryResolver: () => process.execPath, spawnImpl: (_binary, _args, options) => spawn(process.execPath, [helper], options), requestTimeoutMs: 2000 });
  try {
    const active = new AbortController();
    const hanging = worker.search('hang', 100, 'relevance', 'all', { signal: active.signal });
    const rejected = assert.rejects(hanging, { name: 'AbortError' });
    const queued = new AbortController();
    const skipped = worker.search('never-sent', 100, 'relevance', 'all', { signal: queued.signal });
    const rejectedQueued = assert.rejects(skipped, { name: 'AbortError' });
    const unrelated = worker.search('survives');
    queued.abort(); active.abort();
    await Promise.all([rejected, rejectedQueued]);
    assert.equal((await unrelated).results[0].id, 'survives');
    assert.equal(worker.pending.size, 0);
    assert.equal((await worker.search('next')).results[0].id, 'next');
  } finally { worker.stop(); }
}

async function importWorker() {
  const backup = path.join(root, 'backup');
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, 'conversations.json'), JSON.stringify(Array.from({ length: 300 }, (_, index) => ({
    id: `worker-${index}`, title: `Worker fixture ${index}`, create_time: 1, update_time: 2, current_node: 'node',
    mapping: { node: { message: { id: `worker-message-${index}`, author: { role: 'user' }, content: { parts: ['fixture'] }, create_time: 2 } } },
  }))));
  const target = path.join(root, 'worker-import.db');
  const diagnosticEvents = [];
  const diagnostics = { active: true, getBuildInfo: () => ({ build_id: 'synthetic-build' }),
    record: (...args) => diagnosticEvents.push(args), taskStart: (id) => id || 'synthetic-task', taskEnd: () => {},
    resourceOpen: (id) => id || 'synthetic-resource', resourceClose: () => {} };
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const result = await runArchiveWorker({ providerId: 'chatgpt', operation: 'importBackup', dbPath: target, inputPath: backup, snapshotOperationId: 'fixture-import' }, null, diagnostics);
    assert.equal(result.importedConversations, 300);
    assert.equal(result.importedMessages, 300);
    assert.equal(result.sourceItems, 300);
    assert.ok(ticks > 2, 'Foreground event loop must progress during worker import.');
    assert.ok(diagnosticEvents.some(([event]) => event === 'database-opened'));
    const db = new ChatDatabase(target);
    try { assert.equal(db.getStats().messageCount, 300); assert.equal(db.auditJournal.verifyIntegrity().valid, true); } finally { db.close(); }
    const overview = await runArchiveWorker({ operation: 'overview', accounts: [{ id: 'fixture', dbPath: target }] });
    assert.equal(overview[0].stats.conversationCount, 300);
    fs.writeFileSync(path.join(backup, 'conversations.json'), '[{"id":"never-committed"},]');
    await assert.rejects(runArchiveWorker({ providerId: 'chatgpt', operation: 'importBackup', dbPath: target,
      inputPath: backup, snapshotOperationId: 'fixture-failed-import' }), (error) =>
      !!error.preImportSnapshotPath && fs.existsSync(error.preImportSnapshotPath));
    const unchanged = new ChatDatabase(target);
    try { assert.equal(unchanged.getStats().conversationCount, 300); } finally { unchanged.close(); }
  } finally { clearInterval(timer); }
}

async function searchReuse() {
  const db = new ChatDatabase(dbPath);
  let calls = 0, aborted = 0;
  db.searchWorker.stop();
  db.searchWorker = { stop() {}, async search(_query, _limit, sort, role, { signal }) {
    calls += 1;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 20);
      signal.addEventListener('abort', () => { aborted += 1; clearTimeout(timer); reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); }, { once: true });
    });
    return { total: 1, results: [{ id: 'fixture', sort, role }] };
  } };
  try {
    const controller = new AbortController();
    const first = db.searchMessages('coalesced', 'date_desc', 42, 'user', { signal: controller.signal });
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const second = db.searchMessages('coalesced', 'date_desc', 42, 'user');
    controller.abort();
    await rejected;
    const result = await second;
    assert.equal(calls, 1);
    assert.equal(aborted, 0, 'One caller must not cancel shared work needed by another.');
    result.results[0].id = 'caller mutation';
    assert.equal((await db.searchMessages('coalesced', 'date_desc', 42, 'user')).results[0].id, 'fixture');
    assert.equal(calls, 1);
    db.upsertMessage(message('search-invalidates', 'conversation-2', 'user', 'fixture', 100));
    await db.searchMessages('coalesced', 'date_desc', 42, 'user');
    assert.equal(calls, 2, 'Local writes invalidate results.');
    const other = new ChatDatabase(dbPath);
    try { other.upsertMessage(message('search-external', 'conversation-2', 'user', 'fixture', 101)); }
    finally { other.close(); }
    await db.searchMessages('coalesced', 'date_desc', 42, 'user');
    assert.equal(calls, 3, 'External writes invalidate results.');
    const all = new AbortController();
    const removed = db.searchMessages('all-cancelled', 'relevance', 10, 'all', { signal: all.signal });
    const removedCheck = assert.rejects(removed, { name: 'AbortError' });
    await new Promise((resolve) => setImmediate(resolve));
    all.abort();
    await removedCheck;
    assert.equal(aborted, 1);
  } finally { db.close(); }
}

(async () => {
  try {
    await summaries(); jsonStreaming(); audits(); await assets(); await cancellation(); await searchReuse(); await importWorker();
    console.log('Performance contracts passed: summaries/restart/external writes/rollback, compact reader, streaming/staged import, audit equivalence, asset bounds, search cancellation, worker responsiveness. Synthetic data only.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
