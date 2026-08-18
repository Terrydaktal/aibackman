import type { Conversation } from '../../types';

const conversationTimestamp = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) {
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
};

const compareConversationsByRecency = (left: Conversation, right: Conversation) => (
  conversationTimestamp(right.last_message_at ?? right.updated_at)
    - conversationTimestamp(left.last_message_at ?? left.updated_at)
  || conversationTimestamp(right.created_at) - conversationTimestamp(left.created_at)
  || left.id.localeCompare(right.id)
);

export const orderConversations = (
  conversations: Conversation[],
  remotePositions: Map<string, number>,
  newMessageConversationIds: Set<string>
) => {
  const locallyOrdered = [...conversations].sort(compareConversationsByRecency);
  const remotelyOrderedNewMessages = [...remotePositions.entries()]
    .filter(([id]) => newMessageConversationIds.has(id))
    .sort((left, right) => left[1] - right[1]);
  if (remotelyOrderedNewMessages.length === 0) return locallyOrdered;

  const conversationById = new Map(locallyOrdered.map((conversation) => [conversation.id, conversation]));
  const remotelyOrderedIds = new Set(remotelyOrderedNewMessages.map(([id]) => id));
  const ordered = locallyOrdered.filter((conversation) => !remotelyOrderedIds.has(conversation.id));
  for (const [id, remotePosition] of remotelyOrderedNewMessages) {
    const conversation = conversationById.get(id);
    if (!conversation) continue;
    ordered.splice(Math.max(0, Math.min(remotePosition, ordered.length)), 0, conversation);
  }
  return ordered;
};
