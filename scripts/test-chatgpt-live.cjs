#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ChatGPTAuth = require('../electron/auth.cjs');
const ChatDatabase = require('../electron/database.cjs');
const {
  normalizeConversation,
  writeNormalizedConversation,
} = require('../electron/archive/standard/writer.cjs');
const { STANDARD_CACHE_FORMAT_VERSION } = require('../electron/archive/standard/cacheVersion.cjs');

async function testExpiredTokenRefresh() {
  const freshTokenPayload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'fresh-account' },
  })).toString('base64url');
  const freshToken = `header.${freshTokenPayload}.signature`;
  let sessionRequests = 0;
  let backendRequests = 0;
  const authorizations = [];
  const accountIds = [];
  const sessionApi = {
    getUserAgent: () => 'Mozilla/5.0 Electron/40.0.0',
    cookies: { get: async () => [] },
    fetch: async (url, options = {}) => {
      if (url === 'https://chatgpt.com/api/auth/session') {
        sessionRequests += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ accessToken: freshToken }),
        };
      }
      backendRequests += 1;
      authorizations.push(options.headers?.Authorization);
      accountIds.push(options.headers?.['chatgpt-account-id']);
      return backendRequests === 1
        ? { ok: false, status: 401 }
        : { ok: true, status: 200 };
    },
  };
  const auth = new ChatGPTAuth(null, { sessionApi, BrowserWindowClass: class {} });
  auth.accessToken = 'expired-token';
  auth.accountId = 'expired-account';

  const response = await auth.fetchWithAuth('https://chatgpt.com/backend-api/conversations');
  assert.equal(response.status, 200);
  assert.equal(sessionRequests, 1);
  assert.equal(backendRequests, 2);
  assert.deepEqual(authorizations, ['Bearer expired-token', `Bearer ${freshToken}`]);
  assert.deepEqual(accountIds, ['expired-account', 'fresh-account']);
  assert.equal(auth.accessToken, freshToken);
  assert.equal(auth.accountId, 'fresh-account');
}

function testIsoTimestampCacheStatus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-chatgpt-live-'));
  const database = new ChatDatabase(path.join(root, 'chatgpt.db'), { initializeSearchIndex: false });
  const updatedAt = '2026-05-08T18:30:09.146339Z';
  try {
    const normalized = normalizeConversation({
      id: 'iso-timestamp-chat',
      title: 'ISO timestamp chat',
      created_at: updatedAt,
      updated_at: updatedAt,
      last_synced_updated_at: updatedAt,
      cache_format_version: STANDARD_CACHE_FORMAT_VERSION,
      messages: [
        {
          id: 'iso-message',
          role: 'user',
          content: 'cached content',
          created_at: 1,
          parent_id: null,
        },
      ],
    });
    assert.equal(normalized.updated_at, updatedAt);
    assert.equal(normalized.last_synced_updated_at, updatedAt);
    writeNormalizedConversation(database, normalized);

    const stored = database.getConversation('iso-timestamp-chat');
    assert.equal(stored.updated_at, updatedAt);
    assert.equal(stored.last_synced_updated_at, updatedAt);
    const diagnostics = database.getCacheDiagnostics();
    assert.equal(diagnostics.uncachedCount, 0);
    assert.equal(diagnostics.newMessagesCount, 0);
    assert.equal(diagnostics.resyncCount, 0);
  } finally {
    database.close();
  }
}

function testMixedTimestampConversationOrdering() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-chatgpt-ordering-'));
  const database = new ChatDatabase(path.join(root, 'chatgpt.db'), { initializeSearchIndex: false });
  try {
    database.upsertConversation({
      id: 'older-iso',
      title: 'Older ISO timestamp',
      created_at: '2026-08-17T20:00:00.000Z',
      updated_at: '2026-08-17T20:00:00.000Z',
    });
    database.upsertConversation({
      id: 'newer-numeric',
      title: 'Newer numeric timestamp',
      created_at: 1787014800,
      updated_at: 1787014800,
    });
    database.upsertConversation({
      id: 'newest-iso',
      title: 'Newest ISO timestamp',
      created_at: '2026-08-18T01:01:00.000Z',
      updated_at: '2026-08-18T01:01:00.000Z',
    });

    assert.deepEqual(
      database.getConversations().map((conversation) => conversation.id),
      ['newest-iso', 'newer-numeric', 'older-iso']
    );
    assert.ok(Math.abs(database.getStats().latestUpdatedAt - 1787014860) < 0.001);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testConversationOrderingUsesLastMessage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-chatgpt-message-ordering-'));
  const database = new ChatDatabase(path.join(root, 'chatgpt.db'), { initializeSearchIndex: false });
  try {
    database.upsertConversation({
      id: 'metadata-touched-old-chat',
      title: 'Old chat with misleading provider update time',
      created_at: 100,
      updated_at: 500,
      last_synced_updated_at: 500,
    });
    database.upsertMessage({
      id: 'old-chat-last-message',
      conversation_id: 'metadata-touched-old-chat',
      role: 'assistant',
      content: 'Old content',
      created_at: 100,
      parent_id: null,
    });
    database.upsertConversation({
      id: 'actually-newer-chat',
      title: 'Chat with the newer message',
      created_at: 200,
      updated_at: 200,
      last_synced_updated_at: 200,
    });
    database.upsertMessage({
      id: 'newer-chat-last-message',
      conversation_id: 'actually-newer-chat',
      role: 'assistant',
      content: 'Newer content',
      created_at: 200,
      parent_id: null,
    });

    const conversations = database.getConversations();
    assert.deepEqual(
      conversations.map((conversation) => conversation.id),
      ['actually-newer-chat', 'metadata-touched-old-chat']
    );
    assert.equal(conversations[0].last_message_at, 200);
    assert.equal(conversations[0].message_count, 1);
    assert.equal(conversations[1].last_message_at, 100);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  await testExpiredTokenRefresh();
  testIsoTimestampCacheStatus();
  testMixedTimestampConversationOrdering();
  testConversationOrderingUsesLastMessage();
  console.log('ChatGPT live-sync regression checks passed.');
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
