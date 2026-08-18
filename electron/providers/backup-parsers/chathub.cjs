const implementation = require('../../agents/chathub.cjs');
const { createLegacyBackupParser } = require('../shared/provider-composition.cjs');

module.exports = createLegacyBackupParser({ providerId: 'chathub', implementation, kind: 'browser-indexeddb-parser' });
