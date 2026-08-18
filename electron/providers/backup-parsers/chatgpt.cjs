const implementation = require('../../agents/chatgpt.cjs');
const { createLegacyBackupParser } = require('../shared/provider-composition.cjs');

module.exports = createLegacyBackupParser({
  providerId: 'chatgpt',
  implementation,
});
