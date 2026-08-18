const path = require('path');
const {
  asUnixSeconds,
  attachmentMarkdown,
  compactTitle,
  createAssetStore,
  findNamedFile,
  materializeBackupPath,
  parseJsonFile,
  stableId,
} = require('./utils.cjs');
const { writeNormalizedArchive } = require('../archive/standard/index.cjs');

const CLAUDE_PLACEHOLDER_LINES = [
  'This block is not supported on your current device yet.',
  'Viewing artifacts created via the Analysis Tool web feature preview isn’t yet supported on mobile.',
];

function cleanClaudeText(value) {
  let text = String(value || '').replace(/\r\n/g, '\n');
  for (const placeholder of CLAUDE_PLACEHOLDER_LINES) {
    const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text
      .replace(new RegExp('```[^\\n]*\\n\\s*' + escaped + '\\s*\\n```', 'gi'), '')
      .replace(new RegExp('^\\s*' + escaped + '\\s*$', 'gim'), '');
  }
  return text
    .replace(/^\s*```\s*\n\s*```\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function artifactFromBlock(block) {
  if (!block || typeof block !== 'object' || String(block.type || '').toLowerCase() !== 'tool_use') return null;
  if (String(block.name || '').toLowerCase() !== 'artifacts') return null;
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const artifact = {
    id: String(input.id || block.id || '').trim(),
    type: String(input.type || '').trim(),
    title: String(input.title || '').trim(),
    command: String(input.command || '').trim(),
    language: String(input.language || '').trim(),
    content: typeof input.content === 'string' ? input.content : '',
    oldStr: typeof input.old_str === 'string' ? input.old_str : '',
    newStr: typeof input.new_str === 'string' ? input.new_str : '',
    versionUuid: String(input.version_uuid || '').trim(),
  };
  return Object.values(artifact).some((value) => value) ? artifact : null;
}

function compactToolUse(block) {
  if (!block || typeof block !== 'object' || String(block.type || '').toLowerCase() !== 'tool_use') return null;
  const name = String(block.name || '').trim();
  if (!name || name.toLowerCase() === 'artifacts') return null;
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  return {
    id: String(block.id || '').trim(),
    name,
    inputKeys: Object.keys(input).slice(0, 32),
  };
}

function formatClaudeMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const textBlocks = blocks
    .filter((block) => String(block?.type || '').toLowerCase() === 'text')
    .map((block) => cleanClaudeText(block?.text))
    .filter(Boolean);
  const content = cleanClaudeText(textBlocks.length > 0 ? textBlocks.join('\n\n') : message?.text);
  const artifacts = blocks.map(artifactFromBlock).filter(Boolean);
  const toolUses = blocks.map(compactToolUse).filter(Boolean);
  const thinking = blocks
    .filter((block) => String(block?.type || '').toLowerCase() === 'thinking')
    .map((block) => cleanClaudeText(block?.thinking || block?.text))
    .filter(Boolean);
  return {
    content,
    artifacts,
    toolUses,
    thinking,
    blockTypes: blocks.map((block) => block?.type).filter(Boolean),
  };
}

function messageModel(message) {
  const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  return [message?.model, message?.model_slug, message?.model_name, metadata.model, metadata.model_slug, metadata.model_name]
    .map((value) => String(value || '').trim())
    .find(Boolean) || null;
}

function messageEffort(message) {
  const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  return [
    message?.thinking_effort,
    message?.reasoning_effort,
    message?.effort,
    metadata.thinking_effort,
    metadata.reasoning_effort,
    metadata.effort,
  ].map((value) => String(value || '').trim()).find(Boolean) || null;
}

function collectAttachments(message, sourceRoot, assetStore) {
  const records = [];
  const seen = new Set();
  const add = (raw, fallbackName = '') => {
    const record = raw && typeof raw === 'object' ? raw : { file_name: raw };
    const name = path.basename(String(record.file_name || record.name || fallbackName || '').trim());
    if (!name || seen.has(name)) return;
    seen.add(name);
    const copied = assetStore.add(path.join(sourceRoot, name), `${message?.uuid || ''}|${name}`, name);
    records.push({
      name,
      sizeBytes: Number.isFinite(Number(record.file_size)) ? Number(record.file_size) : (copied?.sizeBytes ?? null),
      mimeType: String(record.file_type || copied?.mimeType || 'application/octet-stream'),
      uri: copied?.uri || null,
      extractedContent: String(record.extracted_content || '').trim(),
    });
  };
  for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) add(attachment);
  for (const file of Array.isArray(message?.files) ? message.files : []) add(file);
  return records;
}

function importBackup({ db, inputPath, replaceExisting = false }) {
  const materialized = materializeBackupPath(inputPath);
  try {
    const sourceFile = findNamedFile(materialized.path, ['conversations.json']);
    const parsed = parseJsonFile(sourceFile);
    if (!Array.isArray(parsed)) throw new Error('Claude conversations.json must contain an array of conversations.');
    const sourceRoot = path.dirname(sourceFile);
    const assetStore = createAssetStore(db, 'claude');
    const normalizedConversations = [];

    for (const rawConversation of parsed) {
        const conversationId = String(rawConversation?.uuid || '').trim();
        if (!conversationId) continue;
        const rawMessages = Array.isArray(rawConversation?.chat_messages) ? rawConversation.chat_messages : [];
        const messages = [];
        let previousMessageId = null;

        rawMessages.forEach((rawMessage, index) => {
          const sender = String(rawMessage?.sender || '').toLowerCase();
          const role = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : null;
          if (!role) return;
          const attachments = collectAttachments(rawMessage, sourceRoot, assetStore);
          const links = attachmentMarkdown(attachments);
          const extracted = attachments
            .map((attachment) => attachment.extractedContent ? `Attachment ${attachment.name}:\n${attachment.extractedContent}` : '')
            .filter(Boolean);
          const formatted = formatClaudeMessage(rawMessage);
          const content = [formatted.content, ...links, ...extracted].filter(Boolean).join('\n\n').trim();
          if (!content) return;
          const model = messageModel(rawMessage);
          const effort = messageEffort(rawMessage);
          const messageId = String(rawMessage?.uuid || '').trim() || stableId('claude-msg', `${conversationId}|${index}|${content}`);
          const createdAt = asUnixSeconds(rawMessage?.created_at, asUnixSeconds(rawConversation?.created_at));
          const metadata = {
            source: 'claude-export',
            sender,
            block_types: formatted.blockTypes,
            ...(model ? { model } : {}),
            ...(effort ? { thinking_effort: effort } : {}),
            ...(formatted.artifacts.length > 0 ? { claude_artifacts: formatted.artifacts } : {}),
            ...(formatted.toolUses.length > 0 ? { claude_tool_uses: formatted.toolUses } : {}),
            ...(formatted.thinking.length > 0 ? { claude_thinking: formatted.thinking } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          };
          messages.push({
            id: messageId,
            conversation_id: conversationId,
            role,
            content,
            metadata_json: JSON.stringify(metadata),
            created_at: createdAt,
            parent_id: previousMessageId,
          });
          previousMessageId = messageId;
        });

        const createdAt = asUnixSeconds(rawConversation?.created_at);
        const updatedAt = asUnixSeconds(rawConversation?.updated_at, createdAt);
        normalizedConversations.push({
          id: conversationId,
          title: compactTitle(rawConversation?.name || rawConversation?.summary, 'Claude chat'),
          created_at: createdAt,
          updated_at: updatedAt,
          last_synced_updated_at: updatedAt,
          current_node_id: messages.at(-1)?.id || null,
          is_deleted_on_web: 0,
          messages,
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
  id: 'claude',
  name: 'Claude',
  description: 'Claude conversation exports',
  accent: '#d97757',
  capabilities: { importBackup: true },
  importBackup,
  formatMessage: formatClaudeMessage,
};
