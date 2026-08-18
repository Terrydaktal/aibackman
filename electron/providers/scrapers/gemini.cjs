const { createUnsupportedSiteScraper } = require('../shared/site-scraper.cjs');

module.exports = createUnsupportedSiteScraper({
  providerId: 'gemini',
  providerName: 'Gemini Web',
  reason: 'Gemini Web is currently imported from Google Takeout; a live site scraper is not enabled.',
});
