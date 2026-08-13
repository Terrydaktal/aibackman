const path = require('path');
const { importAiModeTakeout } = require('../aimode-takeout.cjs');
const { compactTitle, findNamedFiles, materializeBackupPath } = require('./utils.cjs');

const GEMINI_LABELS = [
  ['Your prompt:', 'user'],
  ['Your message:', 'user'],
  ['Prompt:', 'user'],
  ["Gemini's response:", 'assistant'],
  ['Gemini response:', 'assistant'],
  ['Response:', 'assistant'],
];

function resolveTakeoutPath(inputPath) {
  const candidates = findNamedFiles(inputPath, ['MyActivity.json', 'myactivity.json']);
  if (candidates.length === 0) throw new Error('No Google MyActivity.json file was found.');
  return candidates.find((candidate) => /(?:^|[\\/])Gemini Apps?(?:[\\/]|$)/i.test(candidate))
    || candidates.find((candidate) => path.basename(path.dirname(candidate)).toLowerCase().includes('gemini'))
    || candidates[0];
}

function normalizeTitle(value) {
  return compactTitle(String(value || '').replace(/^(?:Prompted|Asked)\s+/i, ''), 'Gemini chat');
}

function importBackup({ db, inputPath, replaceExisting = false }) {
  const materialized = materializeBackupPath(inputPath);
  try {
    const sourceFile = resolveTakeoutPath(materialized.path);
    return {
      sourcePath: inputPath,
      ...importAiModeTakeout(db, sourceFile, {
        replaceExisting,
        acceptedHeaders: ['Gemini Apps', 'Gemini'],
        labels: GEMINI_LABELS,
        normalizeTitle,
        conversationPrefix: 'gemini',
        messagePrefix: 'gemsg',
      }),
    };
  } finally {
    materialized.cleanup();
  }
}

module.exports = {
  id: 'gemini',
  name: 'Gemini',
  description: 'Gemini web conversations from official Google exports',
  accent: '#8e75b2',
  capabilities: { importBackup: true },
  importBackup,
};
