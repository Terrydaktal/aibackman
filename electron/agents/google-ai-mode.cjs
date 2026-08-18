const path = require('path');
const { importAiModeTakeout } = require('../aimode-takeout.cjs');
const { findNamedFiles, materializeBackupPath } = require('./utils.cjs');

function resolveTakeoutPath(inputPath) {
  const candidates = findNamedFiles(inputPath, ['MyActivity.json', 'myactivity.json']);
  if (candidates.length === 0) {
    throw new Error('No Google MyActivity.json file was found under the selected path. Select a Takeout folder containing My Activity/AI Mode/MyActivity.json.');
  }
  return candidates.find((candidate) => /(?:^|[\\/])AI Mode(?:[\\/]|$)/i.test(candidate))
    || candidates.find((candidate) => path.basename(path.dirname(candidate)).toLowerCase().includes('ai mode'))
    || candidates[0];
}

function importBackup({ db, inputPath, replaceExisting = false }) {
  const materialized = materializeBackupPath(inputPath);
  try {
    const sourceFile = resolveTakeoutPath(materialized.path);
    return {
      sourcePath: inputPath,
      ...importAiModeTakeout(db, sourceFile, { replaceExisting, inferPromptOnlyFromTitle: true }),
    };
  } finally {
    materialized.cleanup();
  }
}

module.exports = {
  id: 'google-ai-mode',
  name: 'Google AI Mode',
  description: 'Google AI Mode history and Takeout exports',
  accent: '#4285f4',
  capabilities: { importBackup: true, liveSync: true },
  importBackup,
};
