const { isChatGptInternalProtocolMessage } = require('./chatgpt-protocol.cjs');
const { getLinearMessages } = require('../archive/standard/reader.cjs');

function parseMetadataJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeComparableMessageContent(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isThinkingArtifactMetadata(metadata) {
  return !!metadata && typeof metadata === 'object' && (
    metadata.is_thinking_preamble_message === true
    || metadata.is_visually_hidden_from_conversation === true
  );
}

function isCachedThinkingArtifact(message) {
  return !!message && (
    isThinkingArtifactMetadata(parseMetadataJson(message.metadata_json))
    || isChatGptInternalProtocolMessage(message)
  );
}

function createStoredMessageIdResolver(data) {
  const mapping = data?.mapping && typeof data.mapping === 'object' ? data.mapping : {};
  const messageIdByNodeId = new Map();
  for (const [nodeId, node] of Object.entries(mapping)) {
    if (!node?.message) continue;
    const messageId = String(node.message.id || nodeId).trim();
    if (messageId) messageIdByNodeId.set(String(nodeId), messageId);
  }

  const cache = new Map();
  const hasNode = (nodeId) => Object.prototype.hasOwnProperty.call(mapping, nodeId);

  return (nodeId) => {
    let cursor = nodeId == null ? null : String(nodeId);
    const trail = [];
    const visited = new Set();

    while (cursor && !visited.has(cursor)) {
      if (cache.has(cursor)) {
        const resolved = cache.get(cursor);
        for (const trailNodeId of trail) cache.set(trailNodeId, resolved);
        return resolved;
      }

      visited.add(cursor);
      trail.push(cursor);

      const storedMessageId = messageIdByNodeId.get(cursor);
      if (storedMessageId) {
        for (const trailNodeId of trail) cache.set(trailNodeId, storedMessageId);
        return storedMessageId;
      }

      // Parent pointers in a ChatGPT payload are mapping-node IDs. Unknown
      // pointers are external/root sentinels (for example
      // `client-created-root`), not stored messages.
      if (!hasNode(cursor)) {
        for (const trailNodeId of trail) cache.set(trailNodeId, null);
        return null;
      }

      cursor = mapping[cursor]?.parent ? String(mapping[cursor].parent) : null;
    }

    for (const trailNodeId of trail) cache.set(trailNodeId, null);
    return null;
  };
}

function buildOrderedVisibleTurns(data, conversationId, renderMessageContent) {
  if (!data || typeof data !== 'object' || !data.mapping || typeof data.mapping !== 'object' || !data.current_node) {
    return [];
  }
  const mapping = data.mapping;
  const chain = [];
  const visited = new Set();
  let nodeId = data.current_node;
  let guard = 0;
  while (nodeId && mapping[nodeId] && !visited.has(nodeId) && guard < 12000) {
    visited.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId]?.parent || null;
    guard += 1;
  }
  chain.reverse();
  return chain
    .filter((node) => {
      if (!node?.message) return false;
      const role = node.message.author?.role;
      return (role === 'user' || role === 'assistant')
        && !isThinkingArtifactMetadata(node.message.metadata)
        && !isChatGptInternalProtocolMessage(node.message);
    })
    .map((node) => ({
      role: node.message.author?.role,
      content: String(renderMessageContent(node.message, conversationId) || '').trim(),
    }))
    .filter((turn) => turn.content);
}

function shouldPreserveCachedSnapshot(existingMessages, remoteTurns) {
  const existingVisible = (Array.isArray(existingMessages) ? existingMessages : [])
    .filter((message) => (
      message
      && (message.role === 'user' || message.role === 'assistant')
      && String(message.content || '').trim()
      && !isCachedThinkingArtifact(message)
    ));
  const remoteVisible = (Array.isArray(remoteTurns) ? remoteTurns : [])
    .filter((message) => (
      message
      && (message.role === 'user' || message.role === 'assistant')
      && String(message.content || '').trim()
    ));

  if (remoteVisible.length === 0) return existingVisible.length > 0;

  const existingFingerprints = new Set(
    existingVisible.map((message) => `${message.role}|${normalizeComparableMessageContent(message.content)}`)
      .filter((fingerprint) => fingerprint && !fingerprint.endsWith('|'))
  );
  const remoteFingerprints = new Set(
    remoteVisible.map((message) => `${message.role}|${normalizeComparableMessageContent(message.content)}`)
      .filter((fingerprint) => fingerprint && !fingerprint.endsWith('|'))
  );
  const existingCount = existingFingerprints.size;
  const remoteCount = remoteFingerprints.size;
  const duplicateBloatRatio = existingCount > 0 ? existingVisible.length / existingCount : 1;

  if (
    duplicateBloatRatio < 1.5
    && existingCount >= 6
    && remoteCount > 0
    && remoteCount < Math.max(4, Math.floor(existingCount * 0.55))
  ) {
    return true;
  }
  if (remoteCount <= 2 && existingCount > 2) return true;

  const interruptedMarker = 'connection interrupted. waiting for the complete answer';
  if (
    existingCount >= remoteCount
    && remoteVisible.some((message) => normalizeComparableMessageContent(message.content).includes(interruptedMarker))
  ) {
    return true;
  }

  const recentExistingTail = existingVisible.slice(-Math.min(12, existingVisible.length));
  return remoteVisible.length >= 3
    && recentExistingTail.length >= remoteVisible.length
    && existingCount > remoteCount
    && remoteVisible.every((remoteTurn, index) => {
      const existingTurn = recentExistingTail[index];
      return existingTurn
        && existingTurn.role === remoteTurn.role
        && normalizeComparableMessageContent(existingTurn.content) === normalizeComparableMessageContent(remoteTurn.content);
    });
}

module.exports = {
  buildOrderedVisibleTurns,
  createStoredMessageIdResolver,
  getLinearMessages,
  shouldPreserveCachedSnapshot,
};
