const { composeProviderPlugin } = require('./shared/provider-composition.cjs');

const providerDefinitions = [
  ['chatgpt', require('../agents/chatgpt.cjs'), require('./backup-parsers/chatgpt.cjs'), require('./scrapers/chatgpt.cjs')],
  ['google-ai-mode', require('../agents/google-ai-mode.cjs'), require('./backup-parsers/google-ai-mode.cjs'), require('./scrapers/google-ai-mode.cjs')],
  ['gemini', require('../agents/gemini.cjs'), require('./backup-parsers/gemini.cjs'), require('./scrapers/gemini.cjs')],
  ['gemini-cli', require('../agents/gemini-cli.cjs'), require('./backup-parsers/gemini-cli.cjs'), require('./scrapers/gemini-cli.cjs')],
  ['codex', require('../agents/codex.cjs'), require('./backup-parsers/codex.cjs'), require('./scrapers/codex.cjs')],
  ['antigravity', require('../agents/antigravity.cjs'), require('./backup-parsers/antigravity.cjs'), require('./scrapers/antigravity.cjs')],
  ['claude', require('../agents/claude.cjs'), require('./backup-parsers/claude.cjs'), require('./scrapers/claude.cjs')],
  ['deepseek', require('../agents/deepseek.cjs'), require('./backup-parsers/deepseek.cjs'), require('./scrapers/deepseek.cjs')],
  ['grok', require('../agents/grok.cjs'), require('./backup-parsers/grok.cjs'), require('./scrapers/grok.cjs')],
  ['chathub', require('../agents/chathub.cjs'), require('./backup-parsers/chathub.cjs'), require('./scrapers/chathub.cjs')],
];

const plugins = providerDefinitions.map(([, implementation, backupParser, siteScraper]) => (
  composeProviderPlugin({ implementation, backupParser, siteScraper })
));

const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));

function getAgentPlugin(agentId) {
  return byId.get(String(agentId || '')) || null;
}

function listAgentPlugins() {
  return [...plugins];
}

module.exports = {
  getAgentPlugin,
  listAgentPlugins,
};
