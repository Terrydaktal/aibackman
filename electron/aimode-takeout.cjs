const fs = require('fs');
const crypto = require('crypto');

function decodeHtmlEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
    })
    .replace(/&#([0-9]+);/g, (_m, dec) => {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _m;
    });
}

function htmlToPlainText(html) {
  if (!html) return '';
  return decodeHtmlEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/table>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractGoogleActivityTurnsFromHtml(htmlText, labels = null) {
  const text = htmlToPlainText(htmlText);
  if (!text) return [];
  const labelPairs = labels || [
    ['Your prompt:', 'user'],
    ["Search's response:", 'assistant'],
  ];
  const escapedLabels = labelPairs.map(([label]) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const turns = [];
  const pattern = new RegExp(`(${escapedLabels.join('|')})\\s*([\\s\\S]*?)(?=(?:${escapedLabels.join('|')}|$))`, 'g');
  let match = null;
  let sequence = 0;
  while ((match = pattern.exec(text)) !== null) {
    const label = match[1] || '';
    const content = String(match[2] || '').trim();
    if (!content) continue;
    const role = labelPairs.find(([candidate]) => candidate === label)?.[1] || 'assistant';
    turns.push({ role, content, sequence });
    sequence += 1;
  }
  return turns;
}

function extractAiModeTurnsFromHtml(htmlText) {
  return extractGoogleActivityTurnsFromHtml(htmlText);
}

function buildDeterministicId(seed) {
  return crypto.createHash('sha1').update(seed).digest('hex');
}

function normalizeAiModeTitle(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'AI Mode Chat';
  return raw.replace(/^Searched for\s+/i, '').trim() || raw;
}

function buildTakeoutConversationRecord(entry, fallbackNowMs = Date.now(), options = {}) {
  const header = String(entry?.header || '').trim();
  const acceptedHeaders = options.acceptedHeaders || ['AI Mode'];
  if (header && !acceptedHeaders.includes(header)) return null;

  const timeIso = String(entry?.time || '').trim();
  const timeMs = Number.isNaN(Date.parse(timeIso)) ? fallbackNowMs : Date.parse(timeIso);
  const createdAt = timeMs / 1000;
  const titleRaw = String(entry?.title || '').trim() || 'AI Mode Chat';
  const title = typeof options.normalizeTitle === 'function'
    ? options.normalizeTitle(titleRaw)
    : normalizeAiModeTitle(titleRaw);
  const html = Array.isArray(entry?.safeHtmlItem) ? String(entry.safeHtmlItem[0]?.html || '') : '';
  const turns = extractGoogleActivityTurnsFromHtml(html, options.labels);
  if (turns.length === 0) return null;

  const conversationSeed = `${timeIso}|${titleRaw}|${html.slice(0, 4000)}`;
  const conversationId = `${options.conversationPrefix || 'aimode'}-${buildDeterministicId(conversationSeed)}`;
  let previousMessageId = null;
  let lastMessageId = null;
  const messages = [];

  turns.forEach((turn, idx) => {
    const messageSeed = `${conversationId}|${idx}|${turn.role}|${turn.content}`;
    const messageId = `${options.messagePrefix || 'aimsg'}-${buildDeterministicId(messageSeed)}`;
    const created = createdAt + idx * 0.001;
    messages.push({
      id: messageId,
      conversation_id: conversationId,
      role: turn.role,
      content: turn.content,
      metadata_json: null,
      created_at: created,
      parent_id: previousMessageId,
    });
    previousMessageId = messageId;
    lastMessageId = messageId;
  });

  return {
    id: conversationId,
    title,
    titleRaw,
    timeIso,
    timeMs,
    created_at: createdAt,
    updated_at: createdAt,
    current_node_id: lastMessageId,
    is_deleted_on_web: 0,
    html,
    turns,
    messages,
  };
}

function parseAiModeTakeout(inputPath, options = {}) {
  const raw = fs.readFileSync(inputPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('AI Mode takeout file must be a JSON array.');
  }

  const conversations = [];
  for (const entry of parsed) {
    const record = buildTakeoutConversationRecord(entry, Date.now(), options);
    if (record) conversations.push(record);
  }

  return {
    sourceItems: parsed.length,
    conversations,
  };
}

function importAiModeTakeout(dbInstance, inputPath, options = {}) {
  const parsed = parseAiModeTakeout(inputPath, options);
  let importedConversations = 0;
  let importedMessages = 0;

  if (options.replaceExisting !== false) dbInstance.clearAll();
  dbInstance.db.transaction(() => {
    for (const conversation of parsed.conversations) {
      dbInstance.upsertConversation({
        id: conversation.id,
        title: conversation.title,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        current_node_id: null,
        is_deleted_on_web: conversation.is_deleted_on_web,
      });

      for (const message of conversation.messages) {
        dbInstance.upsertMessage(message);
        importedMessages += 1;
      }

      dbInstance.upsertConversation({
        id: conversation.id,
        title: conversation.title,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        current_node_id: conversation.current_node_id,
        is_deleted_on_web: conversation.is_deleted_on_web,
      });
      importedConversations += 1;
    }
  })();

  return {
    importedConversations,
    importedMessages,
    sourceItems: parsed.sourceItems,
  };
}

module.exports = {
  buildDeterministicId,
  extractAiModeTurnsFromHtml,
  extractGoogleActivityTurnsFromHtml,
  htmlToPlainText,
  importAiModeTakeout,
  normalizeAiModeTitle,
  parseAiModeTakeout,
};
