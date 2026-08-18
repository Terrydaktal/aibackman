const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { attachmentMarkdown } = require('./agents/utils.cjs');
const { writeNormalizedArchive } = require('./archive/standard/index.cjs');

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

function extractGoogleActivityTurnsFromHtml(htmlText, labels = null, formatHtml = htmlToPlainText) {
  const text = formatHtml(htmlText);
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

function inferGeminiTurnsFromTitle(title, html, formatHtml = htmlToPlainText) {
  const promptMatch = String(title || '').trim().match(/^(?:Prompted|Asked)\s+([\s\S]+)$/i);
  if (!promptMatch) return [];
  const prompt = htmlToPlainText(promptMatch[1]);
  const response = formatHtml(html);
  return [
    ...(prompt ? [{ role: 'user', content: prompt, sequence: 0 }] : []),
    ...(response ? [{ role: 'assistant', content: response, sequence: 1 }] : []),
  ];
}

function inferPromptOnlyTurnsFromTitle(title) {
  const promptMatch = String(title || '').trim().match(/^Searched for\s+([\s\S]+)$/i);
  if (!promptMatch) return [];
  const prompt = htmlToPlainText(promptMatch[1]);
  return prompt ? [{ role: 'user', content: prompt, sequence: 0 }] : [];
}

function collectTakeoutAttachments(entry, options = {}) {
  const names = [
    ...(Array.isArray(entry?.attachedFiles) ? entry.attachedFiles : []),
    ...(typeof entry?.imageFile === 'string' ? [entry.imageFile] : []),
  ].filter((value) => typeof value === 'string' && value.trim());
  const uniqueNames = [...new Set(names.map((value) => path.basename(value.trim())))];
  return uniqueNames.map((name) => {
    const sourcePath = options.attachmentRoot ? path.join(options.attachmentRoot, name) : '';
    const copied = options.assetStore?.add(sourcePath, `${entry?.time || ''}|${name}`, name);
    return copied || {
      name,
      sizeBytes: null,
      mimeType: 'application/octet-stream',
      uri: null,
    };
  });
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
  const formatHtml = typeof options.formatHtml === 'function' ? options.formatHtml : htmlToPlainText;
  let turns = extractGoogleActivityTurnsFromHtml(html, options.labels, formatHtml);
  if (turns.length === 0) {
    if (options.inferPromptOnlyFromTitle === true) {
      turns = inferPromptOnlyTurnsFromTitle(titleRaw);
    } else if (options.inferPromptFromTitle === true) {
      turns = inferGeminiTurnsFromTitle(titleRaw, html, formatHtml);
    }
  }
  if (turns.length === 0) return null;

  const attachments = collectTakeoutAttachments(entry, options);
  const attachmentLines = attachmentMarkdown(attachments);
  if (attachmentLines.length > 0) {
    const lastTurnIndex = turns.length - 1;
    turns = turns.map((turn, idx) => idx === lastTurnIndex
      ? { ...turn, content: [turn.content, ...attachmentLines].filter(Boolean).join('\n\n') }
      : turn);
  }

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
      metadata_json: JSON.stringify({
        ...(options.messageMetadata && typeof options.messageMetadata === 'object' ? options.messageMetadata : {}),
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.effort ? { thinking_effort: turn.effort } : {}),
      }),
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
    attachments,
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
  if (parsed.conversations.length === 0) {
    throw new Error('Google Takeout contained no importable conversations for this provider.');
  }
  return writeNormalizedArchive({
    db: dbInstance,
    conversations: parsed.conversations,
    replaceExisting: options.replaceExisting !== false,
    sourcePath: inputPath,
    sourceItems: parsed.sourceItems,
  });
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
