const fs = require('fs');
const path = require('path');
const {
  asUnixSeconds,
  attachmentMarkdown,
  compactTitle,
  createAssetStore,
  findNamedFile,
  findNamedFiles,
  materializeBackupPath,
  parseJsonFile,
  stableId,
} = require('./utils.cjs');
const { writeNormalizedArchive } = require('../archive/standard/index.cjs');

function safeParseJson(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function assetExtension(filePath) {
  let handle = null;
  try {
    handle = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);
    if (header.subarray(0, 4).toString() === '%PDF') return '.pdf';
    if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return '.jpg';
    if (header.subarray(0, 4).toString() === 'GIF8') return '.gif';
    if (header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP') return '.webp';
    return '.txt';
  } catch {
    return '';
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

function responseSender(response) {
  const sender = String(response?.sender || '').toLowerCase();
  if (sender === 'human' || sender === 'user') return 'user';
  if (sender === 'assistant') return 'assistant';
  return null;
}

function responseModel(response) {
  return [response?.model, response?.model_slug, response?.model_name, response?.engine]
    .map((value) => String(value || '').trim())
    .find(Boolean) || null;
}

function responseEffort(response) {
  return [
    response?.thinking_effort,
    response?.reasoning_effort,
    response?.effort,
    response?.thinking_level,
    response?.reasoning_level,
  ].map((value) => String(value || '').trim()).find(Boolean) || null;
}

function attachmentIds(response, conversation, includeConversationAssets = false) {
  const values = [];
  const fileAttachments = response?.file_attachments;
  if (Array.isArray(fileAttachments)) values.push(...fileAttachments);
  else if (fileAttachments && typeof fileAttachments === 'object') values.push(...Object.values(fileAttachments));
  const cardAttachments = safeParseJson(response?.card_attachments_json);
  if (Array.isArray(cardAttachments)) values.push(...cardAttachments);
  if (cardAttachments && typeof cardAttachments === 'object') {
    const visit = (value, depth = 0) => {
      if (!value || depth > 4) return;
      if (typeof value === 'string') {
        if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) values.push(value);
        return;
      }
      if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1));
      if (typeof value === 'object') Object.values(value).forEach((item) => visit(item, depth + 1));
    };
    visit(cardAttachments);
  }
  if (includeConversationAssets && Array.isArray(conversation?.asset_ids)) values.push(...conversation.asset_ids);
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function importBackup({ db, inputPath, replaceExisting = false }) {
  const materialized = materializeBackupPath(inputPath);
  try {
    const sourceFile = findNamedFile(materialized.path, ['prod-grok-backend.json']);
    const parsed = parseJsonFile(sourceFile);
    if (!parsed || !Array.isArray(parsed.conversations)) {
      throw new Error('Grok backup must contain a conversations array.');
    }
    const assetDirectory = path.join(path.dirname(sourceFile), 'prod-mc-asset-server');
    const assetFiles = fs.existsSync(assetDirectory)
      ? findNamedFiles(assetDirectory, ['content'], 8)
      : [];
    const assetSourceById = new Map(assetFiles.map((file) => [path.basename(path.dirname(file)), file]));
    const assetStore = createAssetStore(db, 'grok');
    const normalizedConversations = [];

    for (const item of parsed.conversations) {
        const conversation = item?.conversation;
        const conversationId = String(conversation?.id || '').trim();
        if (!conversationId) continue;
        const conversationCreatedAt = asUnixSeconds(conversation?.create_time);
        const rawResponses = Array.isArray(item?.responses) ? item.responses : [];
        const records = [];

        rawResponses.forEach((wrapper, index) => {
          const response = wrapper?.response;
          const role = responseSender(response);
          if (!role) return;
          const responseId = String(response?._id || '').trim() || stableId('grok-response', `${conversationId}|${index}`);
          const createdAt = asUnixSeconds(response?.create_time, conversationCreatedAt) + index * 0.0001;
          const attachments = [];
          for (const assetId of attachmentIds(response, conversation, index === 0)) {
            const source = assetSourceById.get(assetId);
            if (!source) continue;
            const extension = assetExtension(source);
            const copied = assetStore.add(source, assetId, `${assetId}${extension}`);
            if (copied) attachments.push({ ...copied, name: assetId + extension });
          }
          const links = attachmentMarkdown(attachments);
          const baseContent = String(response?.message || '').trim();
          const thinking = role === 'assistant' ? String(response?.thinking_trace || '').trim() : '';
          const model = responseModel(response);
          const effort = responseEffort(response);
          let parentId = null;
          if (thinking) {
            const thinkingId = `${responseId}-thinking`;
            records.push({
              id: thinkingId,
              conversation_id: conversationId,
              role: 'assistant',
              content: thinking,
              metadata_json: JSON.stringify({
                source: 'grok-export',
                ...(model ? { model } : {}),
                ...(effort ? { thinking_effort: effort } : {}),
                phase: 'thinking',
                is_thinking_preamble_message: true,
              }),
              created_at: createdAt - 0.00001,
              parent_id: null,
              responseId,
              parentResponseId: response?.parent_response_id ? String(response.parent_response_id) : null,
            });
            parentId = thinkingId;
          }
          const content = [baseContent, ...links].filter(Boolean).join('\n\n').trim();
          if (!content && !parentId) return;
          if (content) {
            records.push({
              id: responseId,
              conversation_id: conversationId,
              role,
              content,
              metadata_json: JSON.stringify({
                source: 'grok-export',
                ...(model ? { model } : {}),
                ...(effort ? { thinking_effort: effort } : {}),
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(response?.web_search_results ? { web_search_results: response.web_search_results } : {}),
              }),
              created_at: createdAt,
              parent_id: parentId,
              responseId,
              parentResponseId: response?.parent_response_id ? String(response.parent_response_id) : null,
            });
          }
        });

        const lastMessageByResponse = new Map();
        for (const message of records) lastMessageByResponse.set(message.responseId, message.id);
        for (const message of records) {
          if (!message.parent_id && message.parentResponseId) {
            message.parent_id = lastMessageByResponse.get(message.parentResponseId) || null;
          }
          delete message.responseId;
          delete message.parentResponseId;
        }
        const createdAt = conversationCreatedAt;
        const updatedAt = asUnixSeconds(conversation?.modify_time, createdAt);
        normalizedConversations.push({
          id: conversationId,
          title: compactTitle(conversation?.title || conversation?.summary, 'Grok chat'),
          created_at: createdAt,
          updated_at: updatedAt,
          last_synced_updated_at: updatedAt,
          current_node_id: records.at(-1)?.id || null,
          is_deleted_on_web: 0,
          messages: records,
        });
    }

    return writeNormalizedArchive({
      db,
      conversations: normalizedConversations,
      replaceExisting,
      sourcePath: inputPath,
      sourceItems: parsed.conversations.length,
    });
  } finally {
    materialized.cleanup();
  }
}

module.exports = {
  id: 'grok',
  name: 'Grok',
  description: 'Grok conversation exports',
  accent: '#111827',
  capabilities: { importBackup: true },
  importBackup,
};
