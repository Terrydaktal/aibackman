function createSiteScraper(bridge) {
  if (!bridge) throw new Error('Google AI Mode site scraper requires its DOM bridge.');
  return {
    id: 'google-ai-mode-site-scraper',
    providerId: 'google-ai-mode',
    kind: 'site-scraper',
    capabilities: { liveSync: true, listConversations: true, scrapeMessages: true },
    listConversations: (limit = 100) => bridge.fetchConversationIndex(limit),
    openConversation: (ref) => bridge.openConversation(ref),
    scrapeMessages: () => bridge.scrapeMessages(),
  };
}

module.exports = {
  id: 'google-ai-mode-site-scraper',
  providerId: 'google-ai-mode',
  kind: 'site-scraper',
  capabilities: { liveSync: true, listConversations: true, scrapeMessages: true },
  createSiteScraper,
};
