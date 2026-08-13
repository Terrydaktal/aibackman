const { asUnixSeconds, compactTitle, findNamedFile, materializeBackupPath, parseJsonFile } = require('./utils.cjs');

function contentPartToMarkdown(part, conversationId) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;

  const pointer = part.asset_pointer || part.file_id || part.id;
  if (pointer) {
    const rawId = String(pointer).replace(/^file-service:\/\//, '');
    return `![Chat Image](chatgpt-image://${rawId}?conversation_id=${encodeURIComponent(conversationId)})`;
  }
  return '';
}

function messageContent(message, conversationId) {
  const content = message?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content.parts)) {
    return content.parts
      .map((part) => contentPartToMarkdown(part, conversationId))
      .filter(Boolean)
      .join('\n\n');
  }
  if (typeof content.text === 'string') return content.text;
  return '';
}

function normalizeExportRoot(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.conversations)) return parsed.conversations;
  throw new Error('ChatGPT conversations.json must contain an array of conversations.');
}

function importBackup({ db, inputPath, replaceExisting = false }) {
  const materialized = materializeBackupPath(inputPath);
  try {
    const sourceFile = findNamedFile(materialized.path, ['conversations.json']);
    const conversations = normalizeExportRoot(parseJsonFile(sourceFile));
    let importedConversations = 0;
    let importedMessages = 0;

    if (replaceExisting) db.clearAll();
    db.db.transaction(() => {
      for (const rawConversation of conversations) {
        const conversationId = String(rawConversation?.id || rawConversation?.conversation_id || '').trim();
        if (!conversationId) continue;
        const mapping = rawConversation.mapping && typeof rawConversation.mapping === 'object'
          ? rawConversation.mapping
          : {};
        const messageIdByNodeId = new Map(Object.entries(mapping).map(([nodeId, node]) => (
          [nodeId, String(node?.message?.id || nodeId)]
        )));
        const messages = [];
        const parentNodeByMessageId = new Map();
        for (const [nodeId, node] of Object.entries(mapping)) {
          const message = node?.message;
          if (!message) continue;
          const role = String(message.author?.role || '').toLowerCase();
          if (!['user', 'assistant', 'system', 'tool'].includes(role)) continue;
          const content = messageContent(message, conversationId);
          if (!content.trim() && role !== 'assistant') continue;
          const createdAt = asUnixSeconds(message.create_time, asUnixSeconds(rawConversation.create_time));
          const messageId = messageIdByNodeId.get(nodeId);
          messages.push({
            id: messageId,
            conversation_id: conversationId,
            role,
            content,
            metadata_json: message.metadata ? JSON.stringify(message.metadata) : null,
            created_at: createdAt,
            parent_id: null,
          });
          parentNodeByMessageId.set(messageId, node?.parent ? String(node.parent) : null);
        }

        const storedMessageIds = new Set(messages.map((message) => message.id));
        const resolveStoredAncestor = (nodeId) => {
          let cursor = nodeId ? String(nodeId) : null;
          const visited = new Set();
          while (cursor && !visited.has(cursor)) {
            visited.add(cursor);
            const candidate = messageIdByNodeId.get(cursor);
            if (candidate && storedMessageIds.has(candidate)) return candidate;
            cursor = mapping[cursor]?.parent ? String(mapping[cursor].parent) : null;
          }
          return null;
        };
        for (const message of messages) {
          message.parent_id = resolveStoredAncestor(parentNodeByMessageId.get(message.id));
        }

        const createdAt = asUnixSeconds(rawConversation.create_time);
        const updatedAt = asUnixSeconds(rawConversation.update_time, createdAt);
        const currentNodeId = rawConversation.current_node && mapping[rawConversation.current_node]
          ? resolveStoredAncestor(String(rawConversation.current_node))
          : ([...messages].sort((a, b) => a.created_at - b.created_at).at(-1)?.id || null);
        db.upsertConversation({
          id: conversationId,
          title: compactTitle(rawConversation.title, 'ChatGPT chat'),
          created_at: createdAt,
          updated_at: updatedAt,
          last_synced_updated_at: updatedAt,
          current_node_id: currentNodeId,
          is_deleted_on_web: 0,
        });
        for (const message of messages) db.upsertMessage(message);
        importedConversations += 1;
        importedMessages += messages.length;
      }
    })();

    return { sourcePath: inputPath, sourceItems: conversations.length, importedConversations, importedMessages };
  } finally {
    materialized.cleanup();
  }
}

module.exports = {
  id: 'chatgpt',
  name: 'ChatGPT',
  description: 'ChatGPT conversations and official data exports',
  accent: '#10a37f',
  capabilities: { importBackup: true, liveSync: true, send: true, cacheAll: true },
  importBackup,
};
