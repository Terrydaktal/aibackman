const implementation = require('../../agents/deepseek.cjs');
const { createLegacyBackupParser } = require('../shared/provider-composition.cjs');

module.exports = createLegacyBackupParser({ providerId: 'deepseek', implementation });
