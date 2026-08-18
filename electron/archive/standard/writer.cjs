const STANDARD_ROLES = new Set(['user', 'assistant', 'tool', 'system']);
const { STANDARD_CACHE_FORMAT_VERSION } = require('./cacheVersion.cjs');

function metadataJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return STANDARD_ROLES.has(role) ? role : 'assistant';
}

function normalizeCacheFormatVersion(value) {
  if (value == null || value === '') return null;
  const version = Number(value);
  return Number.isFinite(version) ? version : null;
}

function normalizeConversationTimestamp(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) {
      const numeric = Number(text);
      if (Number.isFinite(numeric)) return numeric;
      if (!Number.isNaN(Date.parse(text))) return text;
    }
  }
  return fallback;
}

function messageTimestampFallback(value, fallback) {
  const normalized = normalizeConversationTimestamp(value, null);
  if (typeof normalized === 'number') return normalized;
  if (typeof normalized === 'string') return Date.parse(normalized) / 1000;
  return fallback;
}

function normalizeMessage(message, conversationId, fallbackCreatedAt = Date.now() / 1000, index = 0) {
  const id = String(message?.id || '').trim();
  if (!id) return null;
  return {
    id,
    conversation_id: String(message.conversation_id || conversationId),
    role: normalizeRole(message.role),
    content: String(message.content || ''),
    metadata_json: metadataJson(message.metadata_json ?? message.metadata),
    created_at: Number.isFinite(Number(message.created_at))
      ? Number(message.created_at)
      : fallbackCreatedAt + index * 0.001,
    parent_id: message.parent_id ? String(message.parent_id) : null,
  };
}

function normalizeConversation(conversation, index = 0) {
  const id = String(conversation?.id || '').trim();
  if (!id) return null;
  const rawMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const fallbackCreatedAt = messageTimestampFallback(
    conversation.created_at,
    Date.now() / 1000 + index * 0.001
  );
  const messages = rawMessages
    .map((message, messageIndex) => normalizeMessage(message, id, fallbackCreatedAt, messageIndex))
    .filter(Boolean);
  const currentNodeId = conversation.current_node_id
    ? String(conversation.current_node_id)
    : (messages.at(-1)?.id || null);
  const createdAt = normalizeConversationTimestamp(
    conversation.created_at,
    messages[0]?.created_at || fallbackCreatedAt
  );
  const updatedAt = normalizeConversationTimestamp(
    conversation.updated_at,
    messages.at(-1)?.created_at || createdAt
  );

  return {
    id,
    title: String(conversation.title || 'Untitled chat'),
    created_at: createdAt,
    updated_at: updatedAt,
    last_synced_updated_at: conversation.last_synced_updated_at == null
      ? updatedAt
      : normalizeConversationTimestamp(conversation.last_synced_updated_at, updatedAt),
    current_node_id: currentNodeId,
    cache_format_version: normalizeCacheFormatVersion(conversation.cache_format_version),
    is_deleted_on_web: conversation.is_deleted_on_web ? 1 : 0,
    messages,
  };
}

function writeNormalizedConversation(db, conversation, { replaceMessages = false } = {}) {
  const normalized = normalizeConversation(conversation);
  if (!normalized) return { importedConversations: 0, importedMessages: 0 };
  const safety = db.importConversationSnapshot({
    id: normalized.id,
    title: normalized.title,
    created_at: normalized.created_at,
    updated_at: normalized.updated_at,
    last_synced_updated_at: normalized.last_synced_updated_at,
    current_node_id: normalized.current_node_id,
    cache_format_version: normalized.cache_format_version,
    is_deleted_on_web: normalized.is_deleted_on_web,
  }, normalized.messages, { replaceMessages });
  return {
    importedConversations: 1,
    importedMessages: normalized.messages.length,
    ...safety,
  };
}

function applyConversationIndex(db, conversation) {
  const id = String(conversation?.id || '').trim();
  if (!id) return false;
  db.upsertConversation({
    id,
    title: String(conversation.title || 'Untitled chat'),
    // An index refresh is allowed to have incomplete remote metadata. Keep
    // null here so the database can preserve the existing value (or expose a
    // blue full-resync marker for a genuinely incomplete new row) instead of
    // inventing the current time.
    created_at: conversation.created_at ?? null,
    updated_at: conversation.updated_at ?? null,
    last_synced_updated_at: conversation.last_synced_updated_at ?? null,
    current_node_id: conversation.current_node_id || null,
    cache_format_version: normalizeCacheFormatVersion(conversation.cache_format_version),
    is_deleted_on_web: conversation.is_deleted_on_web ? 1 : 0,
  });
  return true;
}

function writeConversationIndex(db, conversation) {
  const id = String(conversation?.id || '').trim();
  if (!id) return false;
  return db.runArchiveOperation({
    type: 'merge-conversation-index',
    actor: 'standard-archive-writer',
    reason: 'Merge remote index metadata without replacing cached content.',
    entityType: 'conversation',
    entityId: id,
  }, () => applyConversationIndex(db, conversation));
}

function writeMessageMetadata(db, messageId, metadata) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  return db.updateMessageMetadata(id, metadataJson(metadata));
}

function writeConversationIndexes(db, conversations = []) {
  const indexes = Array.isArray(conversations) ? conversations : [];
  db.runArchiveOperation({
    type: 'merge-conversation-index-page',
    actor: 'standard-archive-writer',
    reason: 'Merge a provider conversation-list page without removing absent conversations.',
    details: { incomingConversations: indexes.length },
  }, () => {
    indexes.forEach((conversation) => applyConversationIndex(db, conversation));
  });
  return indexes.length;
}

function writeNormalizedArchive({
  db,
  conversations = [],
  replaceExisting = false,
  sourcePath,
  sourceItems,
  ...extra
}) {
  const normalized = conversations
    .map((conversation, index) => normalizeConversation(conversation, index))
    .filter(Boolean);
  const safety = db.runArchiveOperation({
    type: 'merge-normalized-archive',
    actor: 'official-backup-parser',
    reason: 'Merge an imported archive without deleting records absent from this backup.',
    details: {
      incomingConversations: normalized.length,
      incomingMessages: normalized.reduce((total, conversation) => total + conversation.messages.length, 0),
      replacementRequested: !!replaceExisting,
      sourcePath: sourcePath || null,
    },
  }, () => {
    if (replaceExisting) {
      db.recordSafetyEvent('destructive-archive-replacement-blocked', 'database', db.dbPath, {
        incomingConversations: normalized.length,
        sourcePath: sourcePath || null,
      });
    }
    for (const conversation of normalized) {
      db.upsertConversation({
        id: conversation.id,
        title: conversation.title,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        last_synced_updated_at: conversation.last_synced_updated_at,
        current_node_id: conversation.current_node_id,
        cache_format_version: conversation.cache_format_version,
        is_deleted_on_web: conversation.is_deleted_on_web,
      });
      for (const message of conversation.messages) db.upsertMessage(message);
    }
    return {
      replacementPrevented: !!replaceExisting,
      mergePolicy: 'preserve-existing',
    };
  });

  return {
    ...extra,
    ...(sourcePath ? { sourcePath } : {}),
    sourceItems: sourceItems == null ? normalized.length : sourceItems,
    importedConversations: normalized.length,
    importedMessages: normalized.reduce((total, conversation) => total + conversation.messages.length, 0),
    ...safety,
  };
}

module.exports = {
  STANDARD_ROLES,
  STANDARD_CACHE_FORMAT_VERSION,
  normalizeConversation,
  normalizeMessage,
  writeConversationIndex,
  writeConversationIndexes,
  writeMessageMetadata,
  writeNormalizedArchive,
  writeNormalizedConversation,
};
