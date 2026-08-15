const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ChatDatabase = require('../electron/database.cjs');
const AccountManager = require('../electron/accounts/manager.cjs');
const chatgpt = require('../electron/agents/chatgpt.cjs');
const googleAiMode = require('../electron/agents/google-ai-mode.cjs');
const gemini = require('../electron/agents/gemini.cjs');
const geminiCli = require('../electron/agents/gemini-cli.cjs');
const codex = require('../electron/agents/codex.cjs');
const antigravity = require('../electron/agents/antigravity.cjs');
const { fileFingerprint } = require('../electron/agents/utils.cjs');
const {
  getLinearMessages,
  shouldPreserveCachedSnapshot,
} = require('../electron/conversations/chatgpt-tree.cjs');

function createDatabase(root, name) {
  return new ChatDatabase(path.join(root, `${name}.db`));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-tests-'));
  const databases = [];
  let accountManager = null;
  let identityManager = null;
  try {
    const chatgptDb = createDatabase(root, 'chatgpt');
    databases.push(chatgptDb);
    const chatgptExport = path.join(root, 'conversations.json');
    fs.writeFileSync(chatgptExport, JSON.stringify([{
      id: 'conversation-1',
      title: 'Imported ChatGPT conversation',
      create_time: 100,
      update_time: 103,
      current_node: 'node-assistant',
      mapping: {
        root: { parent: null, message: null },
        'node-user': { parent: 'root', message: { id: 'user-1', author: { role: 'user' }, create_time: 101, content: { parts: ['alpha request'] } } },
        'node-assistant': { parent: 'node-user', message: { id: 'assistant-1', author: { role: 'assistant' }, create_time: 102, content: { parts: ['beta response'] } } },
      },
    }]));
    const chatgptResult = chatgpt.importBackup({ db: chatgptDb, inputPath: chatgptExport, replaceExisting: true });
    assert.equal(chatgptResult.importedConversations, 1);
    assert.equal(chatgptDb.getStats().messageCount, 2);
    assert.equal(chatgptDb.getConversation('conversation-1').current_node_id, 'assistant-1');
    assert.equal(chatgptDb.getMessages('conversation-1').find((message) => message.id === 'assistant-1').parent_id, 'user-1');
    assert.deepEqual(getLinearMessages(chatgptDb, 'conversation-1').map((message) => message.id), ['user-1', 'assistant-1']);
    assert.equal(shouldPreserveCachedSnapshot(
      Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `cached ${index}` })),
      [{ role: 'user', content: 'partial' }, { role: 'assistant', content: 'snapshot' }]
    ), true);
    const search = await chatgptDb.searchMessages('beta');
    assert.equal(search.total, 1);

    const activityPath = path.join(root, 'MyActivity.json');
    fs.writeFileSync(activityPath, JSON.stringify([{
      header: 'AI Mode',
      title: 'Searched for archive test',
      time: '2026-01-01T00:00:00Z',
      safeHtmlItem: [{ html: 'Your prompt: alpha<br>Search\'s response: beta' }],
    }]));
    const aiModeDb = createDatabase(root, 'aimode');
    databases.push(aiModeDb);
    assert.equal(googleAiMode.importBackup({ db: aiModeDb, inputPath: activityPath, replaceExisting: true }).importedMessages, 2);

    fs.writeFileSync(activityPath, JSON.stringify([{
      header: 'Gemini Apps',
      title: 'Prompted archive test',
      time: '2026-01-02T00:00:00Z',
      safeHtmlItem: [{ html: 'Your prompt: gamma<br>Gemini\'s response: delta' }],
    }]));
    const geminiDb = createDatabase(root, 'gemini');
    databases.push(geminiDb);
    assert.equal(gemini.importBackup({ db: geminiDb, inputPath: activityPath, replaceExisting: true }).importedMessages, 2);

    const geminiRoot = path.join(root, 'gemini-home');
    const geminiSessionsRoot = path.join(geminiRoot, 'tmp');
    const geminiChatsRoot = path.join(geminiSessionsRoot, 'archive-project', 'chats');
    const antigravityDiscoveryRoot = path.join(geminiRoot, 'antigravity-cli');
    fs.mkdirSync(geminiChatsRoot, { recursive: true });
    fs.mkdirSync(antigravityDiscoveryRoot, { recursive: true });
    fs.writeFileSync(path.join(geminiRoot, 'google_accounts.json'), JSON.stringify({
      active: 'second@example.test',
      old: ['first@example.test'],
    }));
    const firstGeminiSession = path.join(geminiChatsRoot, 'session-2026-01-03T00-00-local-one.jsonl');
    fs.writeFileSync(firstGeminiSession, [
      { sessionId: 'gemini-cli-one', startTime: '2026-01-03T00:00:00Z', lastUpdated: '2026-01-03T00:00:00Z' },
      { id: 'gemini-user-one', timestamp: '2026-01-03T00:00:01Z', type: 'user', content: [{ text: 'local Gemini question' }] },
      { id: 'gemini-assistant-one', timestamp: '2026-01-03T00:00:02Z', type: 'gemini', content: '', thoughts: [{ subject: 'Working', description: 'Testing' }] },
      { id: 'gemini-assistant-one', timestamp: '2026-01-03T00:00:03Z', type: 'gemini', content: 'local Gemini answer', model: 'gemini-test' },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    fs.writeFileSync(path.join(geminiChatsRoot, 'session-2026-01-04T00-00-local-one.jsonl'), [
      { sessionId: 'gemini-cli-one', startTime: '2026-01-04T00:00:00Z', lastUpdated: '2026-01-04T00:00:00Z' },
      { $set: { messages: [
        { id: 'gemini-user-one', timestamp: '2026-01-03T00:00:01Z', type: 'user', content: [{ text: 'local Gemini question' }] },
        { id: 'gemini-assistant-one', timestamp: '2026-01-03T00:00:03Z', type: 'gemini', content: 'local Gemini answer', model: 'gemini-test' },
      ] } },
      { id: 'gemini-user-two', timestamp: '2026-01-04T00:00:01Z', type: 'user', content: [{ text: 'follow-up question' }] },
      { id: 'gemini-assistant-two', timestamp: '2026-01-04T00:00:02Z', type: 'gemini', content: 'follow-up answer' },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    fs.writeFileSync(path.join(geminiChatsRoot, 'session-2026-01-05T00-00-local-two.jsonl'), [
      { sessionId: 'gemini-cli-two', startTime: '2026-01-05T00:00:00Z', lastUpdated: '2026-01-05T00:00:00Z' },
      { id: 'gemini-user-three', timestamp: '2026-01-05T00:00:01Z', type: 'user', displayContent: [{ text: 'displayed question' }], content: [{ text: 'internal question' }] },
      { id: 'gemini-assistant-three', timestamp: '2026-01-05T00:00:02Z', type: 'gemini', content: 'displayed answer' },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    fs.writeFileSync(path.join(geminiChatsRoot, 'session-2026-01-05T00-00-local-json.json'), JSON.stringify({
      sessionId: 'gemini-cli-json',
      startTime: '2026-01-05T00:00:00Z',
      lastUpdated: '2026-01-05T00:00:03Z',
      messages: [
        { id: 'gemini-user-json', timestamp: '2026-01-05T00:00:01Z', type: 'user', content: 'JSON format question' },
        { id: 'gemini-assistant-json-progress', timestamp: '2026-01-05T00:00:02Z', type: 'gemini', content: 'JSON format progress' },
        { id: 'gemini-assistant-json', timestamp: '2026-01-05T00:00:03Z', type: 'gemini', content: 'JSON format answer' },
      ],
    }));

    const discoveredGeminiAccounts = geminiCli.discoverAccounts({ geminiRoot, sessionsRoot: geminiSessionsRoot });
    assert.deepEqual(discoveredGeminiAccounts.map((account) => account.label), [
      'second@example.test',
      'first@example.test',
    ]);
    assert.equal(antigravity.discoverAccounts({
      geminiRoot,
      root: antigravityDiscoveryRoot,
    })[0].label, 'second@example.test');
    const localGeminiDatabases = new Map(discoveredGeminiAccounts.map((account) => {
      const database = createDatabase(root, account.id);
      databases.push(database);
      return [account.id, database];
    }));
    const firstLocalGeminiRefresh = await geminiCli.refreshAllLocal({
      accounts: discoveredGeminiAccounts,
      getDatabase: (account) => localGeminiDatabases.get(account.id),
    });
    const initiallyActiveGemini = discoveredGeminiAccounts.find((account) => account.sourceConfig.active);
    const initiallyInactiveGemini = discoveredGeminiAccounts.find((account) => !account.sourceConfig.active);
    assert.equal(localGeminiDatabases.get(initiallyActiveGemini.id).getStats().conversationCount, 3);
    assert.equal(localGeminiDatabases.get(initiallyActiveGemini.id).getStats().messageCount, 8);
    assert.equal(localGeminiDatabases.get(initiallyInactiveGemini.id).getStats().conversationCount, 0);
    assert.equal(firstLocalGeminiRefresh.results.find((result) => result.account.id === initiallyActiveGemini.id).importedConversations, 3);
    assert.equal(localGeminiDatabases.get(initiallyActiveGemini.id).getMessages('gemini-cli-two')[0].content, 'displayed question');

    fs.writeFileSync(path.join(geminiChatsRoot, 'session-2026-01-06T00-00-local-three.jsonl'), [
      { sessionId: 'gemini-cli-three', startTime: '2026-01-06T00:00:00Z', lastUpdated: '2026-01-06T00:00:00Z' },
      { id: 'gemini-user-four', timestamp: '2026-01-06T00:00:01Z', type: 'user', content: [{ text: 'new account question' }] },
      { id: 'gemini-assistant-four', timestamp: '2026-01-06T00:00:02Z', type: 'gemini', content: 'new account answer' },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const switchedGeminiAccounts = discoveredGeminiAccounts.map((account) => ({
      ...account,
      sourceConfig: {
        ...account.sourceConfig,
        active: account.id === initiallyInactiveGemini.id,
      },
    }));
    await geminiCli.refreshAllLocal({
      accounts: switchedGeminiAccounts,
      getDatabase: (account) => localGeminiDatabases.get(account.id),
    });
    assert.equal(localGeminiDatabases.get(initiallyActiveGemini.id).getStats().conversationCount, 3);
    assert.equal(localGeminiDatabases.get(initiallyInactiveGemini.id).getStats().conversationCount, 1);
    assert.equal(localGeminiDatabases.get(initiallyInactiveGemini.id).getMessages('gemini-cli-three').length, 2);

    const sessionsRoot = path.join(root, 'codex-sessions');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const codexSessionPath = path.join(sessionsRoot, 'rollout-test.jsonl');
    fs.writeFileSync(codexSessionPath, [
      { timestamp: '2026-02-01T00:00:00Z', type: 'session_meta', payload: { id: 'codex-session', cwd: '/tmp/project' } },
      { timestamp: '2026-02-01T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'codex question' } },
      { timestamp: '2026-02-01T00:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: 'codex internal progress', phase: 'commentary' } },
      { timestamp: '2026-02-01T00:00:03Z', type: 'event_msg', account_id: 'account-one', payload: { type: 'token_count' } },
      { timestamp: '2026-02-01T00:00:04Z', type: 'event_msg', payload: { type: 'agent_message', message: 'codex answer', phase: 'final' } },
      { timestamp: '2026-02-01T00:00:05Z', type: 'event_msg', account_id: 'account-two', payload: { type: 'token_count' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    fs.writeFileSync(path.join(sessionsRoot, 'rollout-unattributed.jsonl'), [
      { timestamp: '2026-02-02T00:00:00Z', type: 'session_meta', payload: { id: 'codex-unattributed-session', cwd: '/tmp/other-project' } },
      { timestamp: '2026-02-02T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'unattributed question' } },
      { timestamp: '2026-02-02T00:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: 'unattributed answer', phase: 'final' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const codexDb = createDatabase(root, 'codex');
    databases.push(codexDb);
    const codexResult = await codex.refreshLocal({
      db: codexDb,
      sourceConfig: { sessionsRoot, remoteAccountId: 'account-one' },
    });
    assert.equal(codexResult.importedConversations, 1);
    assert.equal(codexDb.getStats().messageCount, 2);
    const staleCodexDb = createDatabase(root, 'codex-stale');
    databases.push(staleCodexDb);
    const staleSourcePath = codexSessionPath;
    staleCodexDb.upsertSourceItem({
      sourceKey: `codex:${staleSourcePath}`,
      sourcePath: staleSourcePath,
      fingerprint: fileFingerprint(staleSourcePath),
      metadata: { accountId: null, imported: false },
    });
    const correctedStaleResult = await codex.refreshLocal({
      db: staleCodexDb,
      sourceConfig: { sessionsRoot, remoteAccountId: 'account-one' },
    });
    assert.equal(correctedStaleResult.importedConversations, 1);
    assert.equal(staleCodexDb.getStats().messageCount, 2);
    const repeatedCodexResult = await codex.refreshLocal({
      db: codexDb,
      sourceConfig: { sessionsRoot, remoteAccountId: 'account-one' },
    });
    assert.equal(repeatedCodexResult.skippedFiles, 2);

    const antigravityRoot = path.join(root, 'antigravity');
    const conversationId = 'antigravity-conversation';
    const transcriptDirectory = path.join(antigravityRoot, 'brain', conversationId, '.system_generated', 'logs');
    fs.mkdirSync(transcriptDirectory, { recursive: true });
    fs.mkdirSync(path.join(antigravityRoot, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(antigravityRoot, 'cache', 'conversation_metadata.json'), JSON.stringify({
      conversations: { [conversationId]: { summary: { Title: 'Antigravity test', UpdatedAt: '2026-03-01T00:00:03Z' } } },
    }));
    fs.writeFileSync(path.join(transcriptDirectory, 'transcript.jsonl'), [
      { type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 0, created_at: '2026-03-01T00:00:01Z', content: '<USER_REQUEST>antigravity question</USER_REQUEST><ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>' },
      { type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 1, created_at: '2026-03-01T00:00:02Z', content: 'antigravity answer' },
      { type: 'RUN_COMMAND', source: 'MODEL', step_index: 2, created_at: '2026-03-01T00:00:03Z', content: 'ignored tool output' },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const antigravityDb = createDatabase(root, 'antigravity');
    databases.push(antigravityDb);
    const antigravityResult = await antigravity.refreshLocal({ db: antigravityDb, sourceConfig: { root: antigravityRoot } });
    assert.equal(antigravityResult.importedConversations, 1);
    assert.equal(antigravityDb.getStats().messageCount, 2);
    assert.equal(antigravityDb.getMessages(conversationId)[0].content, 'antigravity question');

    accountManager = new AccountManager({
      userDataPath: path.join(root, 'managed-archive'),
      legacyDatabases: {},
    });
    const managedBackup = accountManager.createAccount({
      agentId: 'chatgpt',
      label: 'Managed ChatGPT backup',
      sourceKind: 'backup',
    });
    await accountManager.importBackup(managedBackup.id, chatgptExport);
    const managedCodex = accountManager.createAccount({
      agentId: 'codex',
      label: 'Managed Codex sessions',
      sourceKind: 'local',
      sourceConfig: { sessionsRoot, remoteAccountId: 'account-one' },
    });
    const managedUnattributed = accountManager.createAccount({
      agentId: 'codex',
      label: 'Managed unattributed Codex sessions',
      sourceKind: 'local',
      sourceConfig: { sessionsRoot, remoteAccountId: null },
    });
    const refreshAll = await accountManager.refreshAllLocal('codex');
    assert.equal(refreshAll.accountCount, 2);
    assert.equal(accountManager.getDatabase(managedCodex).getStats().conversationCount, 1);
    assert.equal(accountManager.getDatabase(managedUnattributed).getStats().conversationCount, 1);
    const repeatedRefreshAll = await accountManager.refreshAllLocal('codex');
    assert.equal(repeatedRefreshAll.results.reduce((sum, result) => sum + result.importedConversations, 0), 0);
    const globalSearch = await accountManager.globalSearch('beta');
    assert.equal(globalSearch.total, 1);
    assert.equal(globalSearch.results[0].account_id, managedBackup.id);

    identityManager = new AccountManager({
      userDataPath: path.join(root, 'identity-archive'),
      legacyDatabases: { chatgpt: chatgptDb, aimode: aiModeDb },
      legacyIdentities: {
        chatgpt: { email: 'chatgpt@example.test' },
        'google-ai-mode': { email: 'google@example.test' },
      },
    });
    identityManager.seedLegacyAccount({
      id: 'chatgpt-default',
      agentId: 'chatgpt',
      label: 'ChatGPT',
      legacyMode: 'chatgpt',
      db: chatgptDb,
      identity: { email: 'chatgpt@example.test' },
    });
    identityManager.seedLegacyAccount({
      id: 'google-ai-mode-default',
      agentId: 'google-ai-mode',
      label: 'Google AI Mode',
      legacyMode: 'aimode',
      db: aiModeDb,
      identity: { email: 'google@example.test' },
    });
    assert.equal(identityManager.getAccount('chatgpt-default').label, 'chatgpt@example.test');
    assert.equal(identityManager.getAccount('google-ai-mode-default').label, 'google@example.test');
    identityManager.renameAccount('chatgpt-default', 'My ChatGPT account');
    identityManager.seedLegacyAccount({
      id: 'chatgpt-default',
      agentId: 'chatgpt',
      label: 'ChatGPT',
      legacyMode: 'chatgpt',
      db: chatgptDb,
      identity: { email: 'different@example.test' },
    });
    assert.equal(identityManager.getAccount('chatgpt-default').label, 'My ChatGPT account');
    assert.equal(identityManager.updateAccountIdentity('chatgpt-default', { email: 'ignored@example.test' }).label, 'My ChatGPT account');

    console.log('Archive import regression checks passed.');
  } finally {
    accountManager?.close();
    identityManager?.close();
    for (const database of databases) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
