const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readConversations } = require('../archive/standard/index.cjs');

let comparatorProcess = null;

function comparatorLaunchSpec(app) {
  const projectRoot = path.resolve(__dirname, '../..');
  const candidates = [
    process.env.AIBACKDIFF_BIN,
    path.join(projectRoot, 'tools', 'aibackdiff', 'target', 'release', 'aibackdiff'),
    path.join(projectRoot, 'tools', 'aibackdiff', 'target', 'debug', 'aibackdiff'),
    path.join(app.getAppPath(), 'tools', 'aibackdiff', 'target', 'release', 'aibackdiff'),
  ].filter(Boolean);
  const binary = candidates.find((candidate) => fs.existsSync(candidate));
  if (binary) return { command: binary, args: [], cwd: projectRoot };

  const manifest = path.join(projectRoot, 'tools', 'aibackdiff', 'Cargo.toml');
  if (fs.existsSync(manifest)) {
    return { command: 'cargo', args: ['run', '--manifest-path', manifest, '--release'], cwd: projectRoot };
  }
  throw new Error('aibackdiff is not available. Build tools/aibackdiff or set AIBACKDIFF_BIN.');
}

function registerArchiveIpc({
  ipcMain,
  dialog,
  app,
  getMainWindow,
  accountManager,
  getDatabase,
  notifyArchiveChanged = () => {},
}) {
  ipcMain.handle('archive:getOverview', async () => accountManager.getArchiveOverview());

  ipcMain.handle('archive:globalSearch', async (_event, payload) => (
    accountManager.globalSearch(payload?.query, Number(payload?.limit || 200))
  ));

  ipcMain.handle('archive:createAccount', async (_event, payload) => (
    accountManager.createAccount(payload || {})
  ));

  ipcMain.handle('archive:deleteAccount', async (_event, payload) => {
    const accountId = String(payload?.accountId || '').trim();
    if (!accountId) throw new Error('Missing archive account id.');
    const result = accountManager.deleteAccount(accountId);
    notifyArchiveChanged();
    return result;
  });

  ipcMain.handle('archive:renameAccount', async (_event, payload) => {
    const accountId = String(payload?.accountId || '').trim();
    if (!accountId) throw new Error('Missing archive account id.');
    const account = accountManager.renameAccount(accountId, payload?.label);
    notifyArchiveChanged();
    return account;
  });

  ipcMain.handle('archive:openComparator', async () => {
    if (comparatorProcess && !comparatorProcess.killed && comparatorProcess.exitCode == null) {
      return { launched: true, alreadyRunning: true };
    }
    const spec = comparatorLaunchSpec(app);
    comparatorProcess = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, RUST_BACKTRACE: process.env.RUST_BACKTRACE || '1' },
    });
    comparatorProcess.once('error', (error) => {
      console.error('Failed to launch aibackdiff:', error);
      comparatorProcess = null;
    });
    comparatorProcess.once('exit', () => {
      comparatorProcess = null;
    });
    comparatorProcess.unref();
    return { launched: true, alreadyRunning: false };
  });

  ipcMain.handle('archive:chooseBackupPath', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Select an official AI backup',
      defaultPath: path.join(app.getPath('home'), 'Desktop', 'backups'),
      properties: ['openFile', 'openDirectory'],
      filters: [
        { name: 'AI backup files', extensions: ['json', 'zip'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle('archive:importBackup', async (_event, payload) => {
    const accountId = String(payload?.accountId || '').trim();
    const inputPath = String(payload?.path || '').trim();
    if (!accountId) throw new Error('Missing archive account id.');
    if (!inputPath) throw new Error('Missing backup path.');
    if (!fs.existsSync(inputPath)) throw new Error(`Backup path not found: ${inputPath}`);
    return accountManager.importBackup(accountId, inputPath);
  });

  const sendRefreshProgress = (event, accountId, progress) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('archive:refreshProgress', { accountId, ...progress });
    }
  };

  ipcMain.handle('archive:refreshLocal', async (event, payload) => {
    const accountId = String(payload?.accountId || '').trim();
    if (!accountId) throw new Error('Missing archive account id.');
    return accountManager.refreshLocal(accountId, (progress) => (
      sendRefreshProgress(event, accountId, progress)
    ));
  });

  ipcMain.handle('archive:refreshAllLocal', async (event, payload) => {
    const agentId = String(payload?.agentId || '').trim() || null;
    return accountManager.refreshAllLocal(agentId, ({ accountId, ...progress }) => (
      sendRefreshProgress(event, accountId, progress)
    ));
  });

  ipcMain.handle('db:getConversations', async (_event, payload) => (
    readConversations(getDatabase(payload))
  ));

  ipcMain.handle('db:deleteConversation', async (_event, arg1, arg2) => {
    const id = typeof arg1 === 'object' ? arg1?.id : arg1;
    const account = typeof arg1 === 'object' ? arg1 : arg2;
    if (!id) throw new Error('Missing conversation id');
    return getDatabase(account).deleteConversation(id, {
      confirmation: typeof arg1 === 'object' ? arg1?.confirmation : null,
      reason: typeof arg1 === 'object' ? arg1?.reason : null,
      actor: 'archive-viewer-user',
    });
  });

  ipcMain.handle('db:restoreConversation', async (_event, payload) => {
    const id = String(payload?.id || '').trim();
    if (!id) throw new Error('Missing conversation id');
    return getDatabase(payload).restoreDeletedConversation(id);
  });

  ipcMain.handle('db:getAuditTrail', async (_event, payload) => (
    getDatabase(payload).getAuditTrail(payload?.limit)
  ));

  ipcMain.handle('db:getStats', async (_event, payload) => {
    const stats = getDatabase(payload).getStats();
    return { ...stats, localCount: stats.conversationCount, cachedCount: stats.cachedCount };
  });

  ipcMain.handle('db:getCacheDiagnostics', async (_event, payload) => (
    getDatabase(payload).getCacheDiagnostics(5000)
  ));
}

module.exports = registerArchiveIpc;
