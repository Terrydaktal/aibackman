const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const pi = require('../electron/agents/pi.cjs');
const { parsePiSession } = require('../electron/agents/pi-session-parser.cjs');
const ChatDatabase = require('../electron/database.cjs');
const AccountManager = require('../electron/accounts/manager.cjs');
const { getAgentPlugin } = require('../electron/providers/registry.cjs');
const { readConversationState, formatConversationMarkdown } = require('../electron/archive/standard/index.cjs');

// All transcripts are invented fixtures beneath this temporary directory. No
// tests discover, parse, or import the user's actual home-directory sessions.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-pi-tests-'));
const homeDir = path.join(root, 'home');
const sourceConfig = { searchRoots: [homeDir] };
const time = (second) => `2026-09-01T00:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`;
const record = (type, id, parentId, second, data = {}) => ({ type, id, parentId, timestamp: time(second), ...data });
const message = (id, parentId, second, role, content, extra = {}) => record('message', id, parentId, second, {
  message: { role, content, timestamp: Date.parse(time(second)), ...extra },
});
const encode = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
function writeSession(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, encode(entries));
}
const hashFile = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const metadata = (row) => JSON.parse(row.metadata_json);
const visible = (rows) => rows.filter((row) => ['user', 'assistant'].includes(row.role));

async function main() {
  let db;
  let manager;
  try {
    const projectFile = path.join(homeDir, 'tasks', 'example', '.pi', 'sessions', 'main.jsonl');
    const globalFile = path.join(homeDir, '.pi', 'agent', 'sessions', '--example--', 'global.jsonl');
    const homeFile = path.join(homeDir, '.pi', 'sessions', 'home.jsonl');
    const devFile = path.join(homeDir, 'Dev', 'nested', 'project', '.pi', 'sessions', 'dev.jsonl');
    const code = '#!/bin/bash\n  printf "%s\\n" "$PATH"\n\n\n';
    const entries = [
      { type: 'session', version: 3, id: 'main', cwd: '/synthetic/project', timestamp: time(0) },
      record('model_change', 'model', null, 1, { provider: 'provider-a', modelId: 'model-a' }),
      record('thinking_level_change', 'effort', 'model', 2, { thinkingLevel: 'high' }),
      message('u', 'effort', 3, 'user', code),
      message('a', 'u', 4, 'assistant', [
        { type: 'thinking', thinking: 'Synthetic reasoning' },
        { type: 'text', text: 'First response' },
        { type: 'toolCall', name: 'example', id: 'call-1', arguments: { input: 'synthetic' } },
      ], { model: 'model-a', provider: 'provider-a' }),
      message('tool', 'a', 5, 'toolResult', [{ type: 'text', text: 'Example tool output' }], { toolName: 'example', toolCallId: 'call-1' }),
      message('old', 'tool', 6, 'assistant', [{ type: 'text', text: 'Original branch' }]),
      record('thinking_level_change', 'off', 'u', 7, { thinkingLevel: 'off' }),
      record('model_change', 'other-model', 'off', 8, { provider: 'provider-b', modelId: 'model-b' }),
      message('alternate', 'other-model', 9, 'assistant', [{ type: 'text', text: 'Selected branch' }]),
      record('compaction', 'compact', 'alternate', 10, { summary: 'Synthetic compaction', firstKeptEntryId: 'alternate', tokensBefore: 100 }),
      message('after', 'compact', 11, 'user', 'After compaction'),
      record('session_info', 'name', 'after', 12, { name: 'Named Pi session' }),
    ];
    writeSession(projectFile, entries);
    for (const [filePath, id] of [[globalFile, 'global'], [homeFile, 'home'], [devFile, 'dev']]) {
      writeSession(filePath, [
        { type: 'session', version: 3, id, timestamp: time(0) },
        message('u', null, 1, 'user', `${id} fixture`),
        message('a', 'u', 2, 'assistant', [{ type: 'text', text: `${id} response` }], { model: 'model-test' }),
      ]);
    }
    const ignoredFile = path.join(homeDir, 'Dev', 'node_modules', 'ignored', '.pi', 'sessions', 'ignored.jsonl');
    writeSession(ignoredFile, entries);
    fs.writeFileSync(path.join(homeDir, '.pi', 'agent', 'auth.json'), 'DO NOT OPEN');
    fs.writeFileSync(path.join(homeDir, 'not-pi.jsonl'), 'DO NOT OPEN');
    fs.symlinkSync(homeDir, path.join(homeDir, 'tasks', 'cycle'), 'dir');

    const originalRead = fs.readFileSync;
    const originalStream = fs.createReadStream;
    fs.readFileSync = fs.createReadStream = () => { throw new Error('Discovery must not read file contents'); };
    let discovered;
    try {
      assert.equal(pi.discoverAccounts({ homeDir })[0].sourceConfig.searchRoots[0], homeDir);
      discovered = await pi.discoverSessionFiles(sourceConfig);
    } finally {
      fs.readFileSync = originalRead;
      fs.createReadStream = originalStream;
    }
    assert.deepEqual(discovered.files, [projectFile, globalFile, homeFile, devFile].sort());
    const originalHash = hashFile(projectFile);
    const originalMtime = fs.statSync(projectFile).mtimeMs;

    const parsed = await parsePiSession(projectFile);
    assert.equal(parsed.parseErrors, 0);
    assert.equal(parsed.conversation.title, 'Named Pi session');
    assert.equal(parsed.conversation.messages.find((row) => row.role === 'user').content, code);
    const alternate = parsed.conversation.messages.find((row) => row.content === 'Selected branch');
    assert.equal(metadata(alternate).model, 'model-b');
    assert.equal(metadata(alternate).thinking_effort, 'off');
    const originalBranch = parsed.conversation.messages.find((row) => row.content === 'Original branch');
    assert.equal(metadata(originalBranch).thinking_effort, 'high');
    assert.ok(parsed.conversation.messages.some((row) => row.role === 'tool' && row.content.includes('Synthetic reasoning')));

    db = new ChatDatabase(path.join(root, 'pi.db'));
    const progress = [];
    const first = await pi.refreshLocal({ db, sourceConfig, onProgress: (event) => progress.push(event) });
    assert.equal(first.importedConversations, 4);
    assert.equal(db.getStats().conversationCount, 4);
    const state = readConversationState(db, parsed.conversation.id);
    assert.deepEqual(visible(state.currentMessages).map((row) => row.content), [code, 'Selected branch', 'After compaction']);
    assert.ok(state.allMessages.some((row) => row.content === 'Original branch'), 'alternate branches must remain archived');
    assert.ok(state.currentMessages.some((row) => row.content === 'Synthetic compaction'));
    assert.doesNotMatch(JSON.stringify(progress), /First response|Synthetic reasoning|Named Pi session|DO NOT OPEN/);
    assert.match(formatConversationMarkdown(state.conversation, visible(state.currentMessages), { agentName: 'Pi CLI' }), /## Pi CLI/);
    assert.equal(hashFile(projectFile), originalHash);
    assert.equal(fs.statSync(projectFile).mtimeMs, originalMtime);

    const repeated = await pi.refreshLocal({ db, sourceConfig });
    assert.equal(repeated.skippedFiles, 4);
    assert.equal(repeated.importedMessages, 0);
    const oldIds = db.getMessages(parsed.conversation.id).map((row) => row.id);
    const appended = message('new', 'name', 20, 'assistant', [{ type: 'text', text: 'New answer' }], { model: 'model-c' });
    fs.appendFileSync(projectFile, encode([appended]));
    const refresh = await pi.refreshLocal({ db, sourceConfig });
    assert.equal(refresh.importedMessages, 1);
    assert.ok(oldIds.every((id) => db.getMessage(id)), 'append must retain all message identities');
    assert.equal(readConversationState(db, parsed.conversation.id).currentMessages.at(-1).content, 'New answer');
    const newestNode = db.getConversation(parsed.conversation.id).current_node_id;

    const olderCopy = path.join(homeDir, 'Dev', 'old-copy', '.pi', 'sessions', 'older.jsonl');
    writeSession(olderCopy, entries);
    await pi.refreshLocal({ db, sourceConfig });
    assert.equal(db.getStats().conversationCount, 4, 'copied sessions must deduplicate by session id');
    assert.equal(db.getConversation(parsed.conversation.id).current_node_id, newestNode, 'older copies must not rewind the chat');

    const goodFingerprint = db.getSourceItem(`pi:${projectFile}`).fingerprint;
    fs.appendFileSync(projectFile, '{"SYNTHETIC_PRIVATE_MARKER":');
    const partial = await pi.refreshLocal({ db, sourceConfig });
    assert.equal(partial.failedFiles, 1);
    assert.equal(partial.parseErrors, 1);
    assert.equal(db.getSourceItem(`pi:${projectFile}`).fingerprint, goodFingerprint);
    assert.equal(db.getConversation(parsed.conversation.id).current_node_id, newestNode);
    writeSession(projectFile, [...entries, appended]);
    const repaired = await pi.refreshLocal({ db, sourceConfig });
    assert.equal(repaired.failedFiles, 0);
    assert.equal(repaired.importedMessages, 0);
    fs.unlinkSync(projectFile);
    await pi.refreshLocal({ db, sourceConfig });
    assert.equal(db.getConversation(parsed.conversation.id).current_node_id, newestNode, 'missing source must not erase archived history');

    const legacyFile = path.join(root, 'legacy.jsonl');
    const legacy = [
      { type: 'session', id: 'legacy', timestamp: time(0) },
      { type: 'message', message: { role: 'user', content: 'Legacy question' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Legacy answer' }] } },
    ];
    writeSession(legacyFile, legacy);
    const legacyParsed = await parsePiSession(legacyFile);
    assert.equal(legacyParsed.parseErrors, 0);
    assert.equal(legacyParsed.conversation.messages[1].parent_id, legacyParsed.conversation.messages[0].id);
    fs.appendFileSync(legacyFile, encode([{ type: 'message', message: { role: 'user', content: 'Legacy follow-up' } }]));
    assert.deepEqual((await parsePiSession(legacyFile)).conversation.messages.slice(0, 2), legacyParsed.conversation.messages);

    const v2File = path.join(root, 'v2.jsonl');
    writeSession(v2File, [
      { type: 'session', version: 2, id: 'v2', timestamp: time(0) },
      record('custom_message', 'extension', null, 1, { display: true, content: 'Extension message' }),
      message('image', 'extension', 2, 'user', [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]),
      message('shell', 'image', 3, 'bashExecution', undefined, { command: 'printf example', output: 'example', exitCode: 0 }),
    ]);
    const v2 = await parsePiSession(v2File);
    assert.equal(v2.parseErrors, 0);
    assert.equal(v2.conversation.messages[0].content, 'Extension message');
    assert.match(v2.conversation.messages[1].content, /data:image\/png;base64,aGVsbG8=/);
    assert.equal(v2.conversation.messages[2].role, 'tool');

    manager = new AccountManager({ userDataPath: path.join(root, 'managed'), legacyDatabases: {} });
    const account = manager.createAccount({ agentId: 'pi', label: 'Synthetic Pi', sourceKind: 'local', sourceConfig });
    const imported = await manager.importBackup(account.id, legacyFile);
    assert.equal(imported.importedConversations, 1);
    const reimported = await manager.importBackup(account.id, legacyFile);
    assert.ok(reimported.preImportSnapshotPath && fs.existsSync(reimported.preImportSnapshotPath), 'Pi reimport must retain a recovery snapshot of existing content.');
    assert.ok(manager.getAccount(account.id).lastBackupAt);
    const all = await manager.refreshAllLocal('pi');
    assert.equal(all.accountCount, 1);
    assert.equal(manager.getDatabase(account.id).getStats().conversationCount, 5);
    const search = await manager.globalSearch('legacy');
    assert.ok(search.results.some((row) => row.agent_id === 'pi'));
    const provider = getAgentPlugin('pi');
    assert.equal(provider.name, 'Pi CLI');
    assert.equal(typeof provider.backupParser.refreshLocal, 'function');
    assert.equal(typeof provider.backupParser.importBackup, 'function');

    const badFile = path.join(root, 'bad.jsonl');
    fs.writeFileSync(badFile, '{"SYNTHETIC_PRIVATE_MARKER":');
    await assert.rejects(pi.importBackup({ db, inputPath: badFile }), (error) => !error.message.includes('SYNTHETIC_PRIVATE_MARKER'));
    await assert.rejects(manager.importBackup(account.id, badFile), (error) =>
      !error.message.includes('SYNTHETIC_PRIVATE_MARKER') && !!error.preImportSnapshotPath && fs.existsSync(error.preImportSnapshotPath));
    assert.ok(db.getAuditTrail(50).length > 0);
    console.log('Pi discovery, parser, refresh worker, merge safety, and account integration checks passed (synthetic data only).');
  } finally {
    manager?.close();
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
