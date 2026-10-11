const { createUnsupportedSiteScraper } = require('../shared/site-scraper.cjs');

module.exports = createUnsupportedSiteScraper({
  providerId: 'pi', providerName: 'Pi CLI',
  reason: 'Pi CLI sessions are read from local .pi folders.',
});
