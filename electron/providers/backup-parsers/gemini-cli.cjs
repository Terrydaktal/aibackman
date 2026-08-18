const implementation = require('../../agents/gemini-cli.cjs');
const { createLegacyBackupParser } = require('../shared/provider-composition.cjs');

module.exports = createLegacyBackupParser({ providerId: 'gemini-cli', implementation, kind: 'local-session-parser' });
