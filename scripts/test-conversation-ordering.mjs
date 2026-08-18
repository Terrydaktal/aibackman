import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const { orderConversations } = await server.ssrLoadModule('/src/features/chat/conversationOrdering.ts');
  const oldChatWithTouchedMetadata = {
    id: 'old-touched-chat',
    title: 'Old chat touched by provider metadata',
    created_at: 100,
    updated_at: 500,
    last_synced_updated_at: 500,
    last_message_at: 100,
  };
  const chatWithNewerMessage = {
    id: 'newer-message-chat',
    title: 'Chat with newer real message',
    created_at: 200,
    updated_at: 200,
    last_synced_updated_at: 200,
    last_message_at: 200,
  };
  const rows = [oldChatWithTouchedMetadata, chatWithNewerMessage];
  const remotePositions = new Map([
    ['old-touched-chat', 0],
    ['newer-message-chat', 1],
  ]);

  assert.deepEqual(
    orderConversations(rows, remotePositions, new Set()).map((conversation) => conversation.id),
    ['newer-message-chat', 'old-touched-chat'],
    'provider metadata alone must not outrank the newest stored message'
  );
  assert.deepEqual(
    orderConversations(rows, remotePositions, new Set(['old-touched-chat'])).map((conversation) => conversation.id),
    ['old-touched-chat', 'newer-message-chat'],
    'a conversation with unsynced messages must temporarily follow live ChatGPT order'
  );
  assert.deepEqual(
    orderConversations(rows, remotePositions, new Set()).map((conversation) => conversation.id),
    ['newer-message-chat', 'old-touched-chat'],
    'clearing the new-message state must restore last-message ordering'
  );

  console.log('Conversation ordering regression checks passed.');
} finally {
  await server.close();
}
