async function fetchJson(auth, url) {
  if (!auth || typeof auth.fetchWithAuth !== 'function') {
    throw new Error('ChatGPT site scraper requires an authenticated client.');
  }
  const response = await auth.fetchWithAuth(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`ChatGPT request failed (${response.status}).`);
  return response.json();
}

module.exports = {
  id: 'chatgpt-site-scraper',
  providerId: 'chatgpt',
  kind: 'site-scraper',
  capabilities: { liveSync: true, listConversations: true, fetchConversation: true },
  listConversations: ({ auth, offset = 0, limit = 20 }) => (
    fetchJson(auth, `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`)
  ),
  fetchConversation: ({ auth, conversationId }) => {
    if (!conversationId) throw new Error('ChatGPT site scraper requires a conversation ID.');
    return fetchJson(auth, `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}`);
  },
};
