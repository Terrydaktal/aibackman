const chatgpt = require('./chatgpt.cjs');
const googleAiMode = require('./google-ai-mode.cjs');
const gemini = require('./gemini.cjs');
const geminiCli = require('./gemini-cli.cjs');
const codex = require('./codex.cjs');
const antigravity = require('./antigravity.cjs');

const plugins = [chatgpt, googleAiMode, gemini, geminiCli, codex, antigravity];
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
