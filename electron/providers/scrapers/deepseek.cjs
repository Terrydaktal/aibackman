const { createUnsupportedSiteScraper } = require('../shared/site-scraper.cjs');

module.exports = createUnsupportedSiteScraper({
  providerId: 'deepseek',
  providerName: 'DeepSeek',
  reason: 'DeepSeek is currently imported from its official export; a live site scraper is not enabled.',
});
