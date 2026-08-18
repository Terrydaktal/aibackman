const {
  asUnixSeconds,
  compactTitle,
  findNamedFile,
  materializeBackupPath,
  parseJsonFile,
  stableId,
} = require('./utils.cjs');
const { writeNormalizedArchive } = require('../archive/standard/index.cjs');

function stringifyValue(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function fragmentContent(fragment) {
  const type = String(fragment?.type || 'event').toUpperCase();
  if (typeof fragment?.content === 'string' && fragment.content.trim()) return fragment.content.trim();
  if (Array.isArray(fragment?.results) && fragment.results.length > 0) {
    return fragment.results.map((result) => stringifyValue(result)).filter(Boolean).join('\n\n');
  }
  return `[${type}]`;
}

function fragmentRole(type) {
  if (type === 'REQUEST') return 'user';
  if (type === 'RESPONSE' || type === 'THINK') return 'assistant';
  return 'tool';
}

function messageModel(message) {
  return [message?.model, message?.model_slug, message?.model_name, message?.engine]
    .map((value) => String(value || '').trim())
    .find(Boolean) || null;
}

function messageEffort(message) {
  return [
    message?.thinking_effort,
    message?.reasoning_effort,
    message?.effort,
    message?.thinking_level,
    message?.reasoning_level,
  ].map((value) => String(value || '').trim()).find(Boolean) || null;
}

function importBackup({ db, inputPath, replaceExisting = false }) {
  const materialized = materializeBackupPath(inputPath);
  try {
    const sourceFile = findNamedFile(materialized.path, ['conversations.json']);
    const parsed = parseJsonFile(sourceFile);
    if (!Array.isArray(parsed)) throw new Error('DeepSeek conversations.json must contain an array of conversations.');
    const normalizedConversations = [];

  for (const rawConversation of parsed) {
      const conversationId = String(rawConversation?.id || '').trim();
      if (!conversationId) continue;
      const mapping = rawConversation?.mapping && typeof rawConversation.mapping === 'object'
        ? rawConversation.mapping
        : {};
      const nodes = Object.entries(mapping)
        .map(([nodeKey, node], index) => ({ nodeKey, node, index }))
        .filter(({ node }) => node?.message && typeof node.message === 'object')
        .sort((a, b) => (
          asUnixSeconds(a.node.message.inserted_at, 0) - asUnixSeconds(b.node.message.inserted_at, 0)
          || a.index - b.index
        ));
      const nodeRecords = [];
      const lastMessageIdByNode = new Map();

      for (const { nodeKey, node } of nodes) {
        const message = node.message;
        const fragments = Array.isArray(message.fragments) ? message.fragments : [];
        const fileNames = Array.isArray(message.files)
          ? message.files.map((file) => typeof file === 'string' ? file : file?.file_name).filter(Boolean)
          : [];
        const fragmentRecords = [];
        const model = messageModel(message);
        const effort = messageEffort(message);
        let previousWithinNode = null;
        fragments.forEach((fragment, fragmentIndex) => {
          const type = String(fragment?.type || 'EVENT').toUpperCase();
          const content = fragmentContent(fragment);
          const attachments = fileNames.length > 0
            ? `\n\nAttachments:\n${[...new Set(fileNames)].map((name) => `- ${name}`).join('\n')}`
            : '';
          const messageContent = `${content}${attachments}`.trim();
          if (!messageContent) return;
          const id = stableId('deepseek-msg', `${conversationId}|${nodeKey}|${fragmentIndex}|${type}|${messageContent}`);
          const metadata = {
            source: 'deepseek-export',
            fragment_type: type,
            ...(type === 'THINK' ? { is_thinking_preamble_message: true, phase: 'thinking' } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { thinking_effort: effort } : {}),
            ...(fileNames.length > 0 ? { attachments: [...new Set(fileNames)] } : {}),
          };
          fragmentRecords.push({
            id,
            conversation_id: conversationId,
            role: fragmentRole(type),
            content: messageContent,
            metadata_json: JSON.stringify(metadata),
            created_at: asUnixSeconds(message.inserted_at, asUnixSeconds(rawConversation.inserted_at)),
            parent_id: previousWithinNode,
            nodeKey,
            parentNodeKey: node.parent ? String(node.parent) : null,
          });
          previousWithinNode = id;
        });
        if (fragmentRecords.length > 0) {
          lastMessageIdByNode.set(nodeKey, fragmentRecords.at(-1).id);
          nodeRecords.push(...fragmentRecords);
        }
      }

      for (const message of nodeRecords) {
        if (!message.parent_id && message.parentNodeKey) {
          message.parent_id = lastMessageIdByNode.get(message.parentNodeKey) || null;
        }
        delete message.nodeKey;
        delete message.parentNodeKey;
      }

      const createdAt = asUnixSeconds(rawConversation.inserted_at);
      const updatedAt = asUnixSeconds(rawConversation.updated_at, createdAt);
      normalizedConversations.push({
        id: conversationId,
        title: compactTitle(rawConversation.title, 'DeepSeek chat'),
        created_at: createdAt,
        updated_at: updatedAt,
        last_synced_updated_at: updatedAt,
        current_node_id: nodeRecords.at(-1)?.id || null,
        is_deleted_on_web: 0,
        messages: nodeRecords,
      });
  }

    return writeNormalizedArchive({
      db,
      conversations: normalizedConversations,
      replaceExisting,
      sourcePath: inputPath,
      sourceItems: parsed.length,
    });
  } finally {
    materialized.cleanup();
  }
}

module.exports = {
  id: 'deepseek',
  name: 'DeepSeek',
  description: 'DeepSeek conversation exports',
  accent: '#536dfe',
  capabilities: { importBackup: true },
  importBackup,
};
