const implementation = require('../../agents/antigravity.cjs');
const { createLegacyBackupParser } = require('../shared/provider-composition.cjs');

module.exports = createLegacyBackupParser({ providerId: 'antigravity', implementation, kind: 'local-transcript-parser' });
