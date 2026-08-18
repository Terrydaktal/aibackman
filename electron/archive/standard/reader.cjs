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

function getLinearMessages(db, conversationId) {
  const conversation = db.getConversation(conversationId);
  const allMessages = db.getMessages(conversationId);
  if (!conversation?.current_node_id) return allMessages;

  const currentPath = db.getLinearPath(conversation.current_node_id);
  // A conversation can legitimately contain alternate branches and hidden
  // tool nodes. The parent chain is the authoritative site order; falling
  // back to every stored row makes those branches look randomly interleaved.
  return currentPath.length > 0 ? currentPath : allMessages;
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

function readConversationState(db, conversationId) {
  const conversation = readConversation(db, conversationId);
  const allMessages = readMessages(db, conversationId, { currentPath: false });
  return {
    conversation,
    currentNodeId: conversation?.current_node_id || null,
    allMessages,
    currentMessages: getLinearMessages(db, conversationId),
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
