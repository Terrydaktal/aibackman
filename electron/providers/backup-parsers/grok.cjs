const implementation = require('../../agents/grok.cjs');
const { createLegacyBackupParser } = require('../shared/provider-composition.cjs');

module.exports = createLegacyBackupParser({ providerId: 'grok', implementation });
