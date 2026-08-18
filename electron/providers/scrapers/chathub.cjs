const { createUnsupportedSiteScraper } = require('../shared/site-scraper.cjs');

module.exports = createUnsupportedSiteScraper({
  providerId: 'chathub',
  providerName: 'ChatHub',
  reason: 'ChatHub is currently read from browser IndexedDB backups; a live site scraper is not enabled.',
});
