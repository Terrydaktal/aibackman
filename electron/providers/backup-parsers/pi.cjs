const implementation = require('../../agents/pi.cjs');

module.exports = {
  id: 'pi-backup-parser', providerId: 'pi', kind: 'local-session-parser',
  parse: implementation.refreshLocal,
  importBackup: implementation.importBackup,
  refreshLocal: implementation.refreshLocal,
};
