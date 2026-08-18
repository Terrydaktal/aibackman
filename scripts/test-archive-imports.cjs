const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ChatDatabase = require('../electron/database.cjs');
const AccountCatalog = require('../electron/accounts/catalog.cjs');
const AccountManager = require('../electron/accounts/manager.cjs');
const chatgpt = require('../electron/agents/chatgpt.cjs');
const googleAiMode = require('../electron/agents/google-ai-mode.cjs');
const gemini = require('../electron/agents/gemini.cjs');
const geminiCli = require('../electron/agents/gemini-cli.cjs');
const codex = require('../electron/agents/codex.cjs');
const antigravity = require('../electron/agents/antigravity.cjs');
const claude = require('../electron/agents/claude.cjs');
const deepseek = require('../electron/agents/deepseek.cjs');
const grok = require('../electron/agents/grok.cjs');
const chathub = require('../electron/agents/chathub.cjs');
const chatgptRuntime = require('../electron/bridges/chatgpt.cjs');
const { listAgentPlugins } = require('../electron/agents/registry.cjs');
const { fileFingerprint } = require('../electron/agents/utils.cjs');
const { formatChatGptContent } = require('../electron/providers/formatters/chatgpt.cjs');
const {
  getLinearMessages,
  readConversationState,
} = require('../electron/archive/standard/reader.cjs');
const { writeConversationIndex } = require('../electron/archive/standard/writer.cjs');
const { STANDARD_CACHE_FORMAT_VERSION } = require('../electron/archive/standard/cacheVersion.cjs');
const {
  createStoredMessageIdResolver,
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
  let migrationManager = null;
  try {
    const chatgptDb = createDatabase(root, 'chatgpt');
    databases.push(chatgptDb);
    assert.equal(
      formatChatGptContent('answer\ngenui{"suggest_automation":{"label":"hidden"}}:::writing{variant="standard"}\n:::'),
      'answer'
    );
    assert.equal(
      formatChatGptContent('Evidence fileciteturn50file2L172-L219 and fileciteturn50file3.'),
      'Evidence [1 · L172-L219](citation://turn50file2) and [2](citation://turn50file3).'
    );
    const chatgptRuntimeInstance = chatgptRuntime({
      app: { getAppMetrics: () => [] },
      BrowserWindow: class {},
      session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
      auth: {},
      db: chatgptDb,
      getMainWindow: () => null,
      appendDebugEvent: () => {},
      debugMode: false,
      shouldShowWindow: false,
      fastMode: false,
      fastTurns: 1,
      fastCache: 1,
      resourceBlocking: false,
      blockedResourceTypes: new Set(),
    });
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
        'node-assistant': { parent: 'node-user', message: { id: 'assistant-1', author: { role: 'assistant' }, create_time: 102, metadata: { model_slug: 'gpt-5-2-thinking', default_model_slug: 'gpt-5-2-thinking', thinking_effort: 'extended' }, content: { parts: ['genui{"suggest_automation":{"label":"hidden"}}:::writing{variant="standard"}\nbeta response\n:::'] } } },
      },
    }]));
    const chatgptResult = chatgpt.importBackup({ db: chatgptDb, inputPath: chatgptExport, replaceExisting: true });
    assert.equal(chatgptResult.importedConversations, 1);
    assert.equal(chatgptDb.getStats().messageCount, 2);
    assert.equal(chatgptDb.getConversation('conversation-1').current_node_id, 'assistant-1');
    assert.equal(chatgptDb.getMessages('conversation-1').find((message) => message.id === 'assistant-1').parent_id, 'user-1');
    assert.equal(chatgptDb.getMessages('conversation-1').find((message) => message.id === 'assistant-1').content, 'beta response');
    const chatgptMetadata = JSON.parse(chatgptDb.getMessages('conversation-1').find((message) => message.id === 'assistant-1').metadata_json);
    assert.equal(chatgptMetadata.model_slug, 'gpt-5-2-thinking');
    assert.equal(chatgptMetadata.thinking_effort, 'extended');
    const liveMetadata = JSON.parse(chatgptRuntimeInstance.sanitizeMetadata({
      model_slug: 'gpt-5-2-thinking',
      default_model_slug: 'gpt-5-2-thinking',
      requested_model_slug: 'gpt-5-2-thinking',
      thinking_effort: 'extended',
      reasoning_effort: 'extended',
      unrelated_secret: 'must not be stored',
    }));
    assert.equal(liveMetadata.model_slug, 'gpt-5-2-thinking');
    assert.equal(liveMetadata.thinking_effort, 'extended');
    assert.equal(liveMetadata.reasoning_effort, 'extended');
    assert.equal(liveMetadata.unrelated_secret, undefined);
    const protocolToolCall = {
      id: 'protocol-tool-call',
      author: { role: 'assistant' },
      metadata: { message_type: 'next', reasoning_status: 'is_reasoning' },
      content: { parts: [JSON.stringify({ open: [{ ref_id: 'turn0view0' }] })] },
    };
    assert.equal(chatgptRuntimeInstance.isChatGptInternalProtocolMessage(protocolToolCall), true);
    const protocolMetadata = JSON.parse(chatgptRuntimeInstance.sanitizeMetadata(protocolToolCall.metadata, protocolToolCall));
    assert.equal(protocolMetadata.chatgpt_internal_protocol, true);
    assert.equal(protocolMetadata.is_visually_hidden_from_conversation, true);
    assert.equal(chatgptRuntimeInstance.isChatGptInternalProtocolMessage({
      author: { role: 'assistant' },
      content: { parts: ['{"answer":"ordinary JSON answer"}'] },
    }), false);
    const protocolToolResultMetadata = JSON.parse(chatgptRuntimeInstance.sanitizeMetadata(undefined, { author: { role: 'tool' } }));
    assert.equal(protocolToolResultMetadata.chatgpt_internal_protocol, true);
    const resolveStoredMessageId = createStoredMessageIdResolver({
      current_node: 'node-new',
      mapping: {
        root: { parent: null, message: null },
        'node-old': { parent: 'root', message: { id: 'message-old' } },
        'node-new': { parent: 'node-old', message: { id: 'message-new' } },
      },
    });
    assert.equal(resolveStoredMessageId('node-new'), 'message-new');
    assert.equal(resolveStoredMessageId('node-old'), 'message-old');
    assert.equal(resolveStoredMessageId('root'), null);
    assert.equal(resolveStoredMessageId('client-created-root'), null);

    const orderingDb = createDatabase(root, 'ordering');
    databases.push(orderingDb);
    orderingDb.importConversationSnapshot(
      {
        id: 'conversation-ordering',
        title: 'Parent-chain ordering',
        created_at: 100,
        updated_at: 300,
        current_node_id: 'stored-new',
      },
      [
        { id: 'stored-old', conversation_id: 'conversation-ordering', role: 'user', content: 'first', created_at: 300, parent_id: null },
        { id: 'stored-new', conversation_id: 'conversation-ordering', role: 'assistant', content: 'second', created_at: 100, parent_id: 'stored-old' },
      ]
    );
    assert.deepEqual(
      getLinearMessages(orderingDb, 'conversation-ordering').map((message) => message.id),
      ['stored-old', 'stored-new']
    );
    orderingDb.upsertMessage({
      id: 'stored-root-child',
      conversation_id: 'conversation-ordering',
      role: 'assistant',
      content: 'third',
      created_at: 400,
      parent_id: 'client-created-root',
    });
    orderingDb.close();
    const reopenedOrderingDb = createDatabase(root, 'ordering');
    databases[databases.indexOf(orderingDb)] = reopenedOrderingDb;
    assert.equal(reopenedOrderingDb.getMessages('conversation-ordering').find((message) => message.id === 'stored-root-child').parent_id, null);
    assert.deepEqual(getLinearMessages(chatgptDb, 'conversation-1').map((message) => message.id), ['user-1', 'assistant-1']);
    assert.deepEqual(readConversationState(chatgptDb, 'conversation-1').currentMessages.map((message) => message.id), ['user-1', 'assistant-1']);
    assert.equal(shouldPreserveCachedSnapshot(
      Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `cached ${index}` })),
      [{ role: 'user', content: 'partial' }, { role: 'assistant', content: 'snapshot' }]
    ), true);
    const search = await chatgptDb.searchMessages('beta');
    assert.equal(search.total, 1);

    const cacheDiagnosticsDb = createDatabase(root, 'cache-diagnostics');
    databases.push(cacheDiagnosticsDb);
    cacheDiagnosticsDb.importConversationSnapshot(
      {
        id: 'preserved-index',
        title: 'Preserved cache index',
        created_at: 100,
        updated_at: 200,
        last_synced_updated_at: 200,
        current_node_id: 'preserved-message',
        cache_format_version: STANDARD_CACHE_FORMAT_VERSION,
      },
      [{
        id: 'preserved-message',
        conversation_id: 'preserved-index',
        role: 'assistant',
        content: 'cached answer',
        created_at: 200,
        parent_id: null,
      }]
    );
    writeConversationIndex(cacheDiagnosticsDb, {
      id: 'preserved-index',
      title: 'Preserved cache index',
      updated_at: null,
      current_node_id: null,
    });
    assert.equal(cacheDiagnosticsDb.getConversation('preserved-index').updated_at, 200);
    assert.equal(cacheDiagnosticsDb.getConversation('preserved-index').current_node_id, 'preserved-message');
    cacheDiagnosticsDb.upsertConversation({
      id: 'never-cached',
      title: 'Never cached',
      created_at: 100,
      updated_at: 110,
      last_synced_updated_at: null,
      current_node_id: null,
      cache_format_version: STANDARD_CACHE_FORMAT_VERSION,
    });
    cacheDiagnosticsDb.upsertConversation({
      id: 'incomplete-cache',
      title: 'Incomplete cache',
      created_at: null,
      updated_at: null,
      last_synced_updated_at: null,
      current_node_id: null,
      cache_format_version: STANDARD_CACHE_FORMAT_VERSION,
    });
    cacheDiagnosticsDb.upsertConversation({
      id: 'old-cached',
      title: 'Old cached format',
      created_at: 100,
      updated_at: 200,
      last_synced_updated_at: 200,
      current_node_id: 'old-cached-message',
      cache_format_version: null,
    });
    cacheDiagnosticsDb.upsertMessage({
      id: 'old-cached-message',
      conversation_id: 'old-cached',
      role: 'assistant',
      content: 'cached with the previous format',
      created_at: 200,
      parent_id: null,
    });
    cacheDiagnosticsDb.upsertConversation({
      id: 'new-messages',
      title: 'New messages',
      created_at: 100,
      updated_at: 300,
      last_synced_updated_at: 200,
      current_node_id: 'new-message',
      cache_format_version: STANDARD_CACHE_FORMAT_VERSION,
    });
    cacheDiagnosticsDb.upsertMessage({
      id: 'new-message',
      conversation_id: 'new-messages',
      role: 'assistant',
      content: 'new answer',
      created_at: 200,
      parent_id: null,
    });
    cacheDiagnosticsDb.upsertConversation({
      id: 'legacy-sync-marker',
      title: 'Current cache with an untrusted legacy sync marker',
      created_at: 100,
      updated_at: '1970-01-01T00:05:00.000Z',
      last_synced_updated_at: 200,
      current_node_id: 'legacy-sync-marker-message',
      cache_format_version: STANDARD_CACHE_FORMAT_VERSION,
    });
    cacheDiagnosticsDb.upsertMessage({
      id: 'legacy-sync-marker-message',
      conversation_id: 'legacy-sync-marker',
      role: 'assistant',
      content: 'Cached through an older revision-marker representation',
      created_at: 200,
      parent_id: null,
    });
    const cacheDiagnostics = cacheDiagnosticsDb.getCacheDiagnostics(5000);
    assert.equal(cacheDiagnostics.uncachedCount, 1);
    assert.equal(cacheDiagnostics.resyncCount, 3);
    assert.equal(cacheDiagnostics.newMessagesCount, 1);
    assert.deepEqual(cacheDiagnostics.uncachedRows.map((row) => row.id), ['never-cached']);
    assert.deepEqual(
      cacheDiagnostics.resyncRows.map((row) => row.id).sort(),
      ['incomplete-cache', 'legacy-sync-marker', 'old-cached']
    );
    assert.deepEqual(cacheDiagnostics.newMessageRows.map((row) => row.id), ['new-messages']);

    const protocolBackupRoot = path.join(root, 'chatgpt-protocol-backup');
    fs.mkdirSync(protocolBackupRoot);
    fs.writeFileSync(path.join(protocolBackupRoot, 'conversations.json'), JSON.stringify([{
      id: 'conversation-protocol',
      title: 'ChatGPT protocol filtering',
      create_time: 100,
      update_time: 103,
      current_node: 'protocol-final',
      mapping: {
        root: { parent: null, message: null },
        'protocol-user': { parent: 'root', message: { id: 'protocol-user', author: { role: 'user' }, create_time: 101, content: { parts: ['question'] } } },
        'protocol-tool-call': {
          parent: 'protocol-user',
          message: {
            id: 'protocol-tool-call',
            author: { role: 'assistant' },
            create_time: 102,
            metadata: { message_type: 'next', reasoning_status: 'is_reasoning' },
            content: { parts: [JSON.stringify({ search_query: [{ q: 'internal query' }] })] },
          },
        },
        'protocol-final': {
          parent: 'protocol-tool-call',
          message: { id: 'protocol-final', author: { role: 'assistant' }, create_time: 103, content: { parts: ['clean answer'] } },
        },
      },
    }]));
    const protocolDb = createDatabase(root, 'chatgpt-protocol');
    databases.push(protocolDb);
    assert.equal(chatgpt.importBackup({ db: protocolDb, inputPath: protocolBackupRoot, replaceExisting: true }).importedMessages, 3);
    const storedProtocolToolCall = protocolDb.getMessages('conversation-protocol').find((message) => message.id === 'protocol-tool-call');
    assert.equal(storedProtocolToolCall.content, '');
    assert.equal(JSON.parse(storedProtocolToolCall.metadata_json).chatgpt_internal_protocol, true);
    assert.equal(protocolDb.getMessages('conversation-protocol').find((message) => message.id === 'protocol-final').content, 'clean answer');

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
      header: 'AI Mode',
      title: 'Searched for query-only archive test',
      time: '2026-01-01T00:00:00Z',
      safeHtmlItem: [{ html: 'query-only archive test' }],
    }]));
    const queryOnlyAiModeDb = createDatabase(root, 'aimode-query-only');
    databases.push(queryOnlyAiModeDb);
    const queryOnlyAiModeResult = googleAiMode.importBackup({ db: queryOnlyAiModeDb, inputPath: activityPath, replaceExisting: true });
    assert.equal(queryOnlyAiModeResult.importedConversations, 1);
    assert.equal(queryOnlyAiModeResult.importedMessages, 1);
    assert.equal(queryOnlyAiModeDb.getConversations()[0].title, 'query-only archive test');
    assert.equal(queryOnlyAiModeDb.getMessages(queryOnlyAiModeDb.getConversations()[0].id)[0].role, 'user');

    fs.writeFileSync(activityPath, JSON.stringify([{ header: 'AI Mode', title: 'No usable turns' }]));
    assert.throws(
      () => googleAiMode.importBackup({ db: queryOnlyAiModeDb, inputPath: activityPath, replaceExisting: true }),
      /no importable conversations/i
    );

    fs.writeFileSync(activityPath, JSON.stringify([{
      header: 'Gemini Apps',
      title: 'Prompted archive test',
      time: '2026-01-02T00:00:00Z',
      safeHtmlItem: [{ html: 'Your prompt: gamma<br>Gemini\'s response: delta' }],
    }]));
    const geminiDb = createDatabase(root, 'gemini');
    databases.push(geminiDb);
    assert.equal(gemini.importBackup({ db: geminiDb, inputPath: activityPath, replaceExisting: true }).importedMessages, 2);
    assert.equal(JSON.parse(geminiDb.getMessages(geminiDb.getConversations()[0].id)[1].metadata_json).source, 'gemini-web-export');

    const geminiWebRoot = path.join(root, 'gemini-web-export');
    fs.mkdirSync(geminiWebRoot, { recursive: true });
    fs.writeFileSync(path.join(geminiWebRoot, 'gemini-image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.writeFileSync(path.join(geminiWebRoot, 'MyActivity.json'), JSON.stringify([{
      header: 'Gemini Apps',
      title: 'Prompted web export question',
      time: '2026-01-02T00:00:00Z',
      imageFile: 'gemini-image.png',
      safeHtmlItem: [{ html: 'web export response' }],
    }]));
    const geminiWebDb = createDatabase(root, 'gemini-web');
    databases.push(geminiWebDb);
    const geminiWebResult = gemini.importBackup({ db: geminiWebDb, inputPath: geminiWebRoot, replaceExisting: true });
    assert.equal(geminiWebResult.importedConversations, 1);
    assert.equal(geminiWebResult.importedMessages, 2);
    assert.match(geminiWebDb.getMessages(geminiWebDb.getConversations()[0].id).at(-1).content, /archive-asset:\/\//);
    const geminiMarkdown = gemini.formatMessage('<h2>Why</h2><p><strong>Important</strong> use <code>nc</code>.</p><ul><li>one</li><li><a href="https://example.com">link</a></li></ul><pre><code>#!/bin/sh\necho "$1"</code></pre>');
    assert.match(geminiMarkdown, /## Why/);
    assert.match(geminiMarkdown, /\*\*Important\*\* use `nc`/);
    assert.match(geminiMarkdown, /- one/);
    assert.match(geminiMarkdown, /\[link\]\(https:\/\/example\.com\)/);
    assert.match(geminiMarkdown, /```[\s\S]*echo "\$1"[\s\S]*```/);
    const geminiTable = gemini.formatMessage('<table><thead><tr><th>Type</th><th>Meaning</th></tr></thead><tbody><tr><td><strong>Third Conditional</strong></td><td>Past result</td></tr><tr><td>Mixed Conditional</td><td>Present result</td></tr></tbody></table>');
    assert.match(geminiTable, /\| Type \| Meaning \|\n\| --- \| --- \|/);
    assert.match(geminiTable, /\| \*\*Third Conditional\*\* \| Past result \|/);

    const claudeRoot = path.join(root, 'claude-export');
    fs.mkdirSync(claudeRoot, { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, 'claude-note.txt'), 'Claude attachment text');
    fs.writeFileSync(path.join(claudeRoot, 'conversations.json'), JSON.stringify([{
      uuid: 'claude-conversation',
      name: 'Claude export test',
      created_at: '2026-01-03T00:00:00Z',
      updated_at: '2026-01-03T00:00:03Z',
      chat_messages: [
        {
          uuid: 'claude-user',
          sender: 'human',
          created_at: '2026-01-03T00:00:01Z',
          text: 'claude question',
          content: [{ type: 'text', text: 'claude question' }],
          attachments: [{ file_name: 'claude-note.txt', file_size: 21, file_type: 'text/plain', extracted_content: 'Claude attachment text' }],
        },
        {
          uuid: 'claude-assistant',
          sender: 'assistant',
          model: 'claude-sonnet-test',
          thinking_effort: 'standard',
          created_at: '2026-01-03T00:00:02Z',
          text: 'claude answer (flattened legacy copy)',
          content: [
            { type: 'tool_use', name: 'artifacts', input: { id: 'artifact-1', type: 'application/vnd.ant.code', title: 'test.sh', command: 'create', content: 'echo claude' } },
            { type: 'text', text: 'claude answer' },
          ],
        },
      ],
    }]));
    const claudeDb = createDatabase(root, 'claude');
    databases.push(claudeDb);
    const claudeResult = claude.importBackup({ db: claudeDb, inputPath: claudeRoot, replaceExisting: true });
    assert.equal(claudeResult.importedConversations, 1);
    assert.equal(claudeResult.importedMessages, 2);
    assert.match(claudeDb.getMessages('claude-conversation')[0].content, /Claude attachment text/);
    const claudeAssistant = claudeDb.getMessages('claude-conversation')[1];
    assert.equal(claudeAssistant.content, 'claude answer');
    assert.doesNotMatch(claudeAssistant.content, /Tool use:|artifact-1|application\/vnd\.ant\.code/);
    const claudeMetadata = JSON.parse(claudeAssistant.metadata_json);
    assert.equal(claudeMetadata.claude_artifacts[0].title, 'test.sh');
    assert.equal(claudeMetadata.claude_artifacts[0].content, 'echo claude');
    assert.equal(claudeMetadata.model, 'claude-sonnet-test');
    assert.equal(claudeMetadata.thinking_effort, 'standard');

    const deepseekExport = path.join(root, 'deepseek-conversations.json');
    fs.writeFileSync(deepseekExport, JSON.stringify([{
      id: 'deepseek-conversation',
      inserted_at: '2026-01-04T00:00:00Z',
      updated_at: '2026-01-04T00:00:03Z',
      title: 'DeepSeek export test',
      mapping: {
        root: { id: 'root', parent: null, children: ['deepseek-user'], message: null },
        'deepseek-user': {
          id: 'deepseek-user', parent: 'root', children: ['deepseek-assistant'],
          message: { inserted_at: '2026-01-04T00:00:01Z', model: 'deepseek-test', files: [{ id: 'file-1', file_name: 'reference.txt' }], fragments: [{ type: 'REQUEST', content: 'deepseek question' }] },
        },
        'deepseek-assistant': {
          id: 'deepseek-assistant', parent: 'deepseek-user', children: [],
          message: { inserted_at: '2026-01-04T00:00:02Z', model: 'deepseek-test', thinking_effort: 'high', fragments: [{ type: 'THINK', content: 'deepseek thought' }, { type: 'RESPONSE', content: 'deepseek answer' }] },
        },
      },
    }]));
    const deepseekDb = createDatabase(root, 'deepseek');
    databases.push(deepseekDb);
    const deepseekResult = deepseek.importBackup({ db: deepseekDb, inputPath: deepseekExport, replaceExisting: true });
    assert.equal(deepseekResult.importedConversations, 1);
    assert.equal(deepseekResult.importedMessages, 3);
    assert.equal(deepseekDb.getMessages('deepseek-conversation').filter((message) => message.role === 'user').length, 1);
    assert.equal(deepseekDb.getMessages('deepseek-conversation').some((message) => message.metadata_json.includes('is_thinking_preamble_message')), true);
    assert.equal(JSON.parse(deepseekDb.getMessages('deepseek-conversation').at(-1).metadata_json).thinking_effort, 'high');

    const grokRoot = path.join(root, 'grok-export', 'export_data');
    const grokAssetRoot = path.join(grokRoot, 'prod-mc-asset-server', 'grok-asset-1');
    fs.mkdirSync(grokAssetRoot, { recursive: true });
    fs.writeFileSync(path.join(grokAssetRoot, 'content'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.writeFileSync(path.join(grokRoot, 'prod-grok-backend.json'), JSON.stringify({ conversations: [{
      conversation: {
        id: 'grok-conversation',
        create_time: '2026-01-05T00:00:00Z',
        modify_time: '2026-01-05T00:00:03Z',
        title: 'Grok export test',
        summary: 'Grok summary',
        asset_ids: [],
      },
      responses: [
        { response: { _id: 'grok-user', conversation_id: 'grok-conversation', create_time: { $date: { $numberLong: '1767571201000' } }, sender: 'human', message: 'grok question' } },
        { response: { _id: 'grok-assistant', conversation_id: 'grok-conversation', create_time: { $date: { $numberLong: '1767571202000' } }, parent_response_id: 'grok-user', sender: 'assistant', model: 'grok-test', thinking_effort: 'high', thinking_trace: 'grok thought', message: 'grok answer', file_attachments: { 0: 'grok-asset-1' } } },
      ],
    }] }));
    const grokDb = createDatabase(root, 'grok');
    databases.push(grokDb);
    const grokResult = grok.importBackup({ db: grokDb, inputPath: path.join(root, 'grok-export'), replaceExisting: true });
    assert.equal(grokResult.importedConversations, 1);
    assert.equal(grokResult.importedMessages, 3);
    assert.match(grokDb.getMessages('grok-conversation').at(-1).content, /archive-asset:\/\//);
    assert.equal(JSON.parse(grokDb.getMessages('grok-conversation').at(-1).metadata_json).thinking_effort, 'high');
    assert.deepEqual(listAgentPlugins().filter((plugin) => ['claude', 'deepseek', 'grok'].includes(plugin.id)).map((plugin) => plugin.name), ['Claude', 'DeepSeek', 'Grok']);
    const expectedProviderIds = ['chatgpt', 'google-ai-mode', 'gemini', 'gemini-cli', 'codex', 'antigravity', 'claude', 'deepseek', 'grok', 'chathub'];
    for (const providerId of expectedProviderIds) {
      const plugin = listAgentPlugins().find((candidate) => candidate.id === providerId);
      assert.ok(plugin, `missing provider plugin: ${providerId}`);
      assert.equal(plugin.backupParser.providerId, providerId);
      assert.equal(plugin.siteScraper.providerId, providerId);
    }

    const chathubRecords = chathub.normalizeRecords([
      {
        key: 'conversations:cloud-gemini-test',
        value: [{ id: 'chathub-conversation', createdAt: 1767571200000, updatedAt: 1767571203000, userId: 'user-1' }],
      },
      {
        key: 'conversation:cloud-gemini-test:chathub-conversation:messages',
        value: [
          { id: 'chathub-user', author: 'user', text: 'ChatHub question', parts: [{ type: 'text', text: 'ChatHub question' }] },
          { id: 'chathub-assistant', author: 'cloud-gemini-test', text: 'ChatHub answer', parts: [{ type: 'text', text: 'ChatHub answer' }] },
        ],
      },
    ]);
    assert.equal(chathubRecords.length, 1);
    assert.equal(chathubRecords[0].messages.length, 2);
    assert.equal(chathub.modelLabel('cloud-gemini-test'), 'Gemini Test');
    const chathubModelMetadata = { model: chathubRecords[0].model, model_label: chathub.modelLabel(chathubRecords[0].model) };
    assert.equal(chathubModelMetadata.model_label, 'Gemini Test');
    assert.equal(listAgentPlugins().find((plugin) => plugin.id === 'chathub').name, 'ChatHub');

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
      { id: 'gemini-assistant-one', timestamp: '2026-01-03T00:00:03Z', type: 'gemini', content: 'local Gemini answer', model: 'gemini-test', thinking_effort: 'medium' },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    fs.writeFileSync(path.join(geminiChatsRoot, 'session-2026-01-04T00-00-local-one.jsonl'), [
      { sessionId: 'gemini-cli-one', startTime: '2026-01-04T00:00:00Z', lastUpdated: '2026-01-04T00:00:00Z' },
      { $set: { messages: [
        { id: 'gemini-user-one', timestamp: '2026-01-03T00:00:01Z', type: 'user', content: [{ text: 'local Gemini question' }] },
        { id: 'gemini-assistant-one', timestamp: '2026-01-03T00:00:03Z', type: 'gemini', content: 'local Gemini answer', model: 'gemini-test', thinking_effort: 'medium' },
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
    assert.equal(localGeminiDatabases.get(initiallyActiveGemini.id).getMessages('gemini-cli-one').some((message) => message.metadata_json.includes('thinking_effort')), true);

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
      { timestamp: '2026-02-01T00:00:02Z', type: 'turn_context', payload: { model: 'gpt-5.2-codex', effort: 'high' } },
      { timestamp: '2026-02-01T00:00:02.500Z', type: 'event_msg', payload: { type: 'agent_message', message: 'codex internal progress', phase: 'commentary' } },
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
    assert.equal(JSON.parse(codexDb.getMessages('codex-session')[1].metadata_json).model, 'gpt-5.2-codex');
    assert.equal(JSON.parse(codexDb.getMessages('codex-session')[1].metadata_json).thinking_effort, 'high');
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
      { type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 1, created_at: '2026-03-01T00:00:02Z', model: 'gemini-2.5-pro', thinking_effort: 'high', content: 'antigravity answer' },
      { type: 'RUN_COMMAND', source: 'MODEL', step_index: 2, created_at: '2026-03-01T00:00:03Z', content: 'ignored tool output' },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const antigravityDb = createDatabase(root, 'antigravity');
    databases.push(antigravityDb);
    const antigravityResult = await antigravity.refreshLocal({ db: antigravityDb, sourceConfig: { root: antigravityRoot } });
    assert.equal(antigravityResult.importedConversations, 1);
    assert.equal(antigravityDb.getStats().messageCount, 2);
    assert.equal(antigravityDb.getMessages(conversationId)[0].content, 'antigravity question');
    const antigravityMetadata = JSON.parse(antigravityDb.getMessages(conversationId)[1].metadata_json);
    assert.equal(antigravityMetadata.model, 'gemini-2.5-pro');
    assert.equal(antigravityMetadata.thinking_effort, 'high');

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
    const repeatedManagedImport = await accountManager.importBackup(managedBackup.id, chatgptExport);
    assert.ok(repeatedManagedImport.preImportSnapshotPath);
    assert.equal(fs.existsSync(repeatedManagedImport.preImportSnapshotPath), true);
    const deletedManagedAccount = accountManager.deleteAccount(managedBackup.id);
    assert.equal(accountManager.getAccount(managedBackup.id), null);
    assert.equal(fs.existsSync(deletedManagedAccount.recoveryPath), true);
    assert.equal(fs.existsSync(path.join(deletedManagedAccount.recoveryPath, 'manifest.json')), true);

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

    const migrationRoot = path.join(root, 'aibackman');
    const migrationLegacyRoot = path.join(root, 'chatgpt');
    const migrationAccountId = 'codex-migration-test';
    const migrationDbPath = path.join(migrationRoot, 'accounts', 'account-migration.db');
    fs.mkdirSync(path.dirname(migrationDbPath), { recursive: true });

    const migrationDb = new ChatDatabase(migrationDbPath);
    migrationDb.importConversationSnapshot(
      {
        id: 'migration-conversation',
        title: 'Migrated Codex session',
        created_at: 1,
        updated_at: 2,
      },
      [{
        id: 'migration-message',
        conversation_id: 'migration-conversation',
        role: 'user',
        content: 'preserved',
        created_at: 1,
        parent_id: null,
      }]
    );
    assert.equal(migrationDb.getStats().messageCount, 1);
    migrationDb.close();

    const migrationCatalog = new AccountCatalog(path.join(migrationRoot, 'archive-catalog.db'));
    migrationCatalog.upsertAccount({
      id: migrationAccountId,
      agentId: 'codex',
      label: 'Migrated Codex',
      dbPath: path.join(migrationLegacyRoot, 'accounts', 'account-migration.db'),
      sourceKind: 'local',
      sourceConfig: {},
      legacyMode: null,
      isDefault: false,
    });
    migrationCatalog.close();

    migrationManager = new AccountManager({ userDataPath: migrationRoot, legacyDatabases: {} });
    assert.equal(migrationManager.getAccount(migrationAccountId).dbPath, migrationDbPath);
    assert.equal(migrationManager.getDatabase(migrationAccountId).getStats().messageCount, 1);

    console.log('Archive import regression checks passed.');
  } finally {
    accountManager?.close();
    identityManager?.close();
    migrationManager?.close();
    for (const database of databases) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
