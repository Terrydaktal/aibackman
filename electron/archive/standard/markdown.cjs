const MODEL_KEYS = [
  'model_slug',
  'requested_model_slug',
  'default_model_slug',
  'model',
  'model_name',
  'model_version',
  'engine',
];

const EFFORT_KEYS = [
  'thinking_effort',
  'reasoning_effort',
  'effort',
  'thinking_level',
  'reasoning_level',
];

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstText(metadata, keys) {
  return keys
    .map((key) => metadata[key])
    .map((value) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''))
    .find(Boolean) || '';
}

function formatModelLabel(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^gpt-/i.test(trimmed)) {
    let label = trimmed.replace(/^gpt-/i, 'GPT-');
    label = label.replace(/^(GPT-\d+)-(\d+)/i, '$1.$2');
    label = label.replace(/-([a-z])(?=-|$)/gi, (_match, character) => `-${character.toUpperCase()}`);
    label = label.replace(/-(thinking|instant)$/i, (_match, mode) => ` ${mode[0].toUpperCase()}${mode.slice(1).toLowerCase()}`);
    label = label.replace(/-mini$/i, ' Mini');
    return label;
  }
  return trimmed
    .replace(/^cloud-/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatEffortLabel(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return /^(max|maximum)$/i.test(trimmed) ? 'xhigh' : trimmed;
}

function toDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const milliseconds = Math.abs(numeric) > 1e12 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = toDate(value);
  return date ? date.toISOString() : '';
}

function cleanText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function formatEmbeddedResults(metadata) {
  if (!Array.isArray(metadata.embedded_ui)) return [];
  return metadata.embedded_ui.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const title = cleanText(entry.title) || 'Embedded result';
    const content = cleanText(entry.markdown || entry.text);
    return content ? [`### ${title}\n\n${content}`] : [];
  });
}

function formatClaudeArtifacts(metadata) {
  if (!Array.isArray(metadata.claude_artifacts)) return [];
  return metadata.claude_artifacts.flatMap((artifact) => {
    if (!artifact || typeof artifact !== 'object') return [];
    const title = cleanText(artifact.title) || 'Claude artifact';
    const content = cleanText(artifact.content || artifact.newStr || artifact.oldStr);
    if (!content) return [];
    const language = cleanText(artifact.language);
    const fence = language ? '```' + language : '```';
    return [`### ${title}\n\n${fence}\n${content}\n\`\`\``];
  });
}

function formatMessageMetadata(message, metadata) {
  if (message.role !== 'assistant') return '';
  const model = formatModelLabel(firstText(metadata, MODEL_KEYS));
  const effort = formatEffortLabel(firstText(metadata, EFFORT_KEYS));
  if (!model && !effort) return '';
  return `_Model: ${model || 'unavailable'} · Thinking effort: ${effort || 'unavailable'}_`;
}

function formatConversationMarkdown(conversation, messages, { accountLabel = '', agentName = '' } = {}) {
  const title = cleanText(conversation?.title) || 'Untitled chat';
  const header = [
    `# ${title.replace(/\n+/g, ' ')}`,
    '',
    `- Provider: ${cleanText(agentName) || 'Unknown'}`,
    `- Account: ${cleanText(accountLabel) || 'Unknown'}`,
    `- Created: ${formatDate(conversation?.created_at) || 'unknown'}`,
    `- Updated: ${formatDate(conversation?.updated_at) || 'unknown'}`,
    `- Messages: ${Array.isArray(messages) ? messages.length : 0}`,
    '',
    '---',
  ];

  const body = (Array.isArray(messages) ? messages : []).flatMap((message) => {
    const metadata = parseMetadata(message?.metadata_json);
    const roleLabel = message?.role === 'user' ? 'You' : cleanText(agentName) || 'Assistant';
    const date = formatDate(message?.created_at);
    const content = cleanText(message?.content);
    const metadataLine = formatMessageMetadata(message, metadata);
    const richResults = [
      ...formatEmbeddedResults(metadata),
      ...formatClaudeArtifacts(metadata),
    ];
    if (!content && !metadataLine && richResults.length === 0) return [];
    return [
      '',
      `## ${roleLabel}${date ? ` — ${date}` : ''}`,
      '',
      ...(metadataLine ? [metadataLine, ''] : []),
      ...(content ? [content] : []),
      ...(richResults.length > 0 ? ['', ...richResults] : []),
    ];
  });

  return `${[...header, ...body].join('\n').replace(/\n{4,}/g, '\n\n\n').trim()}\n`;
}

function safeMarkdownFilename(value) {
  const base = cleanText(value)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 160);
  return `${base || 'chat'}.md`;
}

module.exports = {
  formatConversationMarkdown,
  safeMarkdownFilename,
};
