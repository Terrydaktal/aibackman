const { isMainThread } = require('worker_threads');
const { runArchiveWorker } = require('./archive-worker.cjs');

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
    parse: (options) => {
      const dbPath = options.db?.dbPath;
      if (!isMainThread || !dbPath || ['codex', 'pi'].includes(providerId)) return implementation[operation](options);
      return runArchiveWorker({ providerId, operation, dbPath, inputPath: options.inputPath,
        sourceConfig: options.sourceConfig, snapshotOperationId: options.snapshotOperationId }, options.onProgress, options.db?.diagnostics);
    },
  };
  if (operation === 'importBackup') parser.importBackup = parser.parse;
  if (operation === 'refreshLocal') parser.refreshLocal = parser.parse;
  if (typeof implementation.refreshAllLocal === 'function') {
    parser.refreshAllLocal = (options) => {
      if (!isMainThread || ['codex', 'pi'].includes(providerId)) return implementation.refreshAllLocal(options);
      return runArchiveWorker({ providerId, operation: 'refreshAllLocal', accounts: options.accounts.map((account) => ({ account, dbPath: account.dbPath || options.getDatabase(account).dbPath })) }, options.onProgress, options.diagnostics);
    };
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
