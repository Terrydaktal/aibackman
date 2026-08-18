function createLegacyBackupParser({ providerId, implementation, kind = 'official-backup' }) {
  const operation = typeof implementation.importBackup === 'function'
    ? 'importBackup'
    : typeof implementation.refreshLocal === 'function'
      ? 'refreshLocal'
      : null;
  if (!operation) throw new Error(`Provider ${providerId} does not expose a backup parser operation.`);

  const parser = {
    id: `${providerId}-backup-parser`,
    providerId,
    kind,
    parse: (...args) => implementation[operation](...args),
  };
  if (operation === 'importBackup') parser.importBackup = parser.parse;
  if (operation === 'refreshLocal') parser.refreshLocal = parser.parse;
  if (typeof implementation.refreshAllLocal === 'function') {
    parser.refreshAllLocal = (...args) => implementation.refreshAllLocal(...args);
  }
  return parser;
}

function composeProviderPlugin({ implementation, backupParser, siteScraper }) {
  return {
    ...implementation,
    backupParser,
    siteScraper,
    pluginVersion: 1,
  };
}

module.exports = {
  composeProviderPlugin,
  createLegacyBackupParser,
};
