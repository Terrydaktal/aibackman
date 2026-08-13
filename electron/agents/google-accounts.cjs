const fs = require('fs');
const os = require('os');
const path = require('path');
const { stableId } = require('./utils.cjs');

const DEFAULT_GEMINI_ROOT = path.join(os.homedir(), '.gemini');

function accountEmail(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return String(value.email || value.account || value.value || '').trim();
}

function readGoogleAccounts(geminiRoot = DEFAULT_GEMINI_ROOT) {
  const registryPath = path.join(geminiRoot, 'google_accounts.json');
  if (!fs.existsSync(registryPath)) {
    return { active: '', accounts: [], registryPath };
  }

  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const active = accountEmail(registry?.active);
    const old = Array.isArray(registry?.old) ? registry.old.map(accountEmail) : [];
    const accounts = [...new Set([active, ...old].filter(Boolean))];
    return { active, accounts, registryPath };
  } catch {
    return { active: '', accounts: [], registryPath };
  }
}

function localGoogleAccountId(prefix, email) {
  return stableId(prefix, String(email || 'unattributed').trim().toLowerCase());
}

module.exports = {
  DEFAULT_GEMINI_ROOT,
  localGoogleAccountId,
  readGoogleAccounts,
};
