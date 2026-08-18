const implementation = require('../../agents/google-ai-mode.cjs');
const { createLegacyBackupParser } = require('../shared/provider-composition.cjs');

module.exports = createLegacyBackupParser({
  providerId: 'google-ai-mode',
  implementation,
});
