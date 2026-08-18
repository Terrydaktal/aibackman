const { createUnsupportedSiteScraper } = require('../shared/site-scraper.cjs');

module.exports = createUnsupportedSiteScraper({
  providerId: 'gemini-cli',
  providerName: 'Gemini CLI',
  reason: 'Gemini CLI is currently read from its local session store, not scraped from the web UI.',
});
