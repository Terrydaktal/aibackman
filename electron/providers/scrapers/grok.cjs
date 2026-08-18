const { createUnsupportedSiteScraper } = require('../shared/site-scraper.cjs');

module.exports = createUnsupportedSiteScraper({
  providerId: 'grok',
  providerName: 'Grok',
  reason: 'Grok is currently imported from its official export; a live site scraper is not enabled.',
});
