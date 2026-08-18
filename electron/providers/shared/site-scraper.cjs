function createUnsupportedSiteScraper({ providerId, providerName, reason }) {
  const message = reason || `${providerName} does not currently expose a supported live site scraper.`;
  return {
    id: `${providerId}-site-scraper`,
    providerId,
    kind: 'site-scraper',
    capabilities: { liveSync: false },
    status: 'unsupported',
    reason: message,
    async scrape() {
      throw new Error(message);
    },
  };
}

module.exports = { createUnsupportedSiteScraper };
