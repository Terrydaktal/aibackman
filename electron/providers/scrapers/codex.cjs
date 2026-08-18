const { createUnsupportedSiteScraper } = require('../shared/site-scraper.cjs');

module.exports = createUnsupportedSiteScraper({
  providerId: 'codex',
  providerName: 'Codex CLI',
  reason: 'Codex CLI is currently read from local JSONL sessions, not scraped from the web UI.',
});
