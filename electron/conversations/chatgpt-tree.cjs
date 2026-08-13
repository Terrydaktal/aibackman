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
  return !!message && isThinkingArtifactMetadata(parseMetadataJson(message.metadata_json));
}

function getLinearMessages(db, conversationId) {
  const conversation = db.getConversation(conversationId);
  const allMessages = db.getMessages(conversationId);
  if (!conversation?.current_node_id) return allMessages;

  const currentPath = db.getLinearPath(conversation.current_node_id);
  const isVisibleMessage = (message) => (
    message
    && (message.role === 'user' || message.role === 'assistant')
    && typeof message.content === 'string'
    && message.content.trim()
    && !isCachedThinkingArtifact(message)
  );
  const visibleAllCount = allMessages.filter(isVisibleMessage).length;
  const visiblePathCount = currentPath.filter(isVisibleMessage).length;
  const pathLooksPartial = (
    visibleAllCount >= 8
    && visiblePathCount > 0
    && visiblePathCount < Math.max(4, Math.floor(visibleAllCount * 0.55))
  );
  const largePathLoss = (
    visibleAllCount >= 100
    && visiblePathCount > 0
    && (visibleAllCount - visiblePathCount) >= 20
  );
  return pathLooksPartial || largePathLoss ? allMessages : currentPath;
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
        && !isThinkingArtifactMetadata(node.message.metadata);
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
  getLinearMessages,
  shouldPreserveCachedSnapshot,
};
