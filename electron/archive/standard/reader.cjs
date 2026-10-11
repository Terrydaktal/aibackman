const { isChatGptInternalProtocolMessage } = require('../../conversations/chatgpt-protocol.cjs');

function parseMetadataJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isHiddenArchiveMessage(message) {
  const metadata = parseMetadataJson(message?.metadata_json);
  return message?.role === 'tool'
    || metadata?.is_thinking_preamble_message === true
    || metadata?.is_visually_hidden_from_conversation === true
    || isChatGptInternalProtocolMessage(message);
}

function isVisibleArchiveMessage(message) {
  return !!message
    && (message.role === 'user' || message.role === 'assistant')
    && typeof message.content === 'string'
    && message.content.trim()
    && !isHiddenArchiveMessage(message);
}

function currentMessagesFromRows(conversation, allMessages) {
  if (!conversation?.current_node_id) return allMessages;
  const byId = new Map(allMessages.map((message) => [message.id, message]));
  const path = [];
  const seen = new Set();
  let message = byId.get(conversation.current_node_id);
  while (message && !seen.has(message.id)) {
    seen.add(message.id);
    path.push(message);
    message = byId.get(message.parent_id);
  }
  return path.length ? path.reverse() : allMessages;
}

function getLinearMessages(db, conversationId) {
  const conversation = db.getConversation(conversationId);
  const allMessages = db.getMessages(conversationId);
  return currentMessagesFromRows(conversation, allMessages);
}

function readConversations(db) {
  return db.getConversations();
}

function readConversation(db, conversationId) {
  return db.getConversation(conversationId) || null;
}

function readMessages(db, conversationId, { currentPath = true } = {}) {
  return currentPath ? getLinearMessages(db, conversationId) : db.getMessages(conversationId);
}

function readConversationState(db, conversationId, { compact = false } = {}) {
  const conversation = readConversation(db, conversationId);
  const allMessages = readMessages(db, conversationId, { currentPath: false });
  const currentMessages = currentMessagesFromRows(conversation, allMessages);
  return {
    conversation,
    currentNodeId: conversation?.current_node_id || null,
    allMessages,
    ...(compact ? { currentMessageIds: currentMessages.map((message) => message.id) } : { currentMessages }),
  };
}

module.exports = {
  getLinearMessages,
  isHiddenArchiveMessage,
  isVisibleArchiveMessage,
  readConversation,
  readConversationState,
  readConversations,
  readMessages,
};
