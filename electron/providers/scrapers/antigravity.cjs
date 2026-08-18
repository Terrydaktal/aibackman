const { createUnsupportedSiteScraper } = require('../shared/site-scraper.cjs');

module.exports = createUnsupportedSiteScraper({
  providerId: 'antigravity',
  providerName: 'Antigravity CLI',
  reason: 'Antigravity CLI is currently read from local transcript logs, not scraped from the web UI.',
});
