const SESSION_AGENT_IDS = new Set(['gemini-cli', 'codex', 'antigravity']);

export function archiveItemLabel(agentId: string, plural = false) {
  const isSessionAgent = SESSION_AGENT_IDS.has(String(agentId || ''));
  if (plural) return isSessionAgent ? 'sessions' : 'chats';
  return isSessionAgent ? 'session' : 'chat';
}
