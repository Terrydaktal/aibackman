const implementation = require('../../agents/codex.cjs');
const { createLegacyBackupParser } = require('../shared/provider-composition.cjs');

module.exports = createLegacyBackupParser({ providerId: 'codex', implementation, kind: 'local-session-parser' });
