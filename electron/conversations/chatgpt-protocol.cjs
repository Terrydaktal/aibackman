const CHATGPT_TOOL_CALL_KEYS = new Set([
  'calculator',
  'click',
  'computer',
  'file_search',
  'find',
  'image_query',
  'open',
  'python',
  'search_model_queries',
  'search_query',
  'screenshot',
  'shell',
  'web',
]);

function parseMetadata(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function messageRole(message) {
  return String(message?.author?.role || message?.role || '').toLowerCase();
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (typeof content?.text === 'string') return content.text;
  if (!Array.isArray(content?.parts)) return '';

  return content.parts
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.markdown === 'string') return part.markdown;
      if (typeof part.content === 'string') return part.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isToolCallPayload(value, metadata = null) {
  const text = String(value || '').trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return false;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }

  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const hasToolKey = Object.keys(candidate).some((key) => CHATGPT_TOOL_CALL_KEYS.has(key));
    if (!hasToolKey) return false;

    // ChatGPT's backend marks these protocol messages as `next` while it is
    // reasoning. The key-only fallback also handles older exports without the
    // newer metadata fields.
    return metadata?.message_type === 'next'
      || metadata?.reasoning_status === 'is_reasoning'
      || metadata?.request_id
      || hasToolKey;
  });
}

function isChatGptInternalProtocolMessage(message) {
  const metadata = parseMetadata(message?.metadata ?? message?.metadata_json);
  if (metadata?.chatgpt_internal_protocol === true) return true;

  const role = messageRole(message);
  if (role === 'tool') return true;
  if (role !== 'assistant') return false;

  const content = messageText(message);
  if (isToolCallPayload(content, metadata)) return true;

  // Empty assistant nodes carrying only reasoning/finish state are backend
  // bookkeeping nodes, not conversation turns.
  return !content.trim() && !!metadata && (
    metadata.message_type === 'next'
    || typeof metadata.reasoning_status === 'string'
    || typeof metadata.reasoning_title === 'string'
    || metadata.skip_reasoning_title === 'Skip'
    || !!metadata.finish_details
    || metadata.is_complete === true
  );
}

function markChatGptInternalProtocolMetadata(metadata, message) {
  const output = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  if (isChatGptInternalProtocolMessage({ ...message, metadata: output })) {
    output.chatgpt_internal_protocol = true;
    output.is_visually_hidden_from_conversation = true;
  }
  return Object.keys(output).length > 0 ? output : null;
}

module.exports = {
  isChatGptInternalProtocolMessage,
  markChatGptInternalProtocolMetadata,
  messageText,
};
