const { createUnsupportedSiteScraper } = require('../shared/site-scraper.cjs');

module.exports = createUnsupportedSiteScraper({
  providerId: 'claude',
  providerName: 'Claude',
  reason: 'Claude is currently imported from its official export; a live site scraper is not enabled.',
});
