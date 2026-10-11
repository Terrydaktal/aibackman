const { parentPort, workerData } = require('worker_threads');
const ChatDatabase = require('../../database.cjs');
const crypto = require('crypto');

async function run() {
  const databases = new Map();
  const noop = () => null;
  const diagnostics = { getBuildInfo: () => workerData.buildInfo, record: noop, taskStart: noop, taskEnd: noop, resourceOpen: noop, resourceClose: noop };
  if (workerData.observable) {
    for (const method of ['record', 'taskStart', 'taskEnd', 'resourceOpen', 'resourceClose']) diagnostics[method] = (...args) => {
      if ((method === 'taskStart' || method === 'resourceOpen') && !args[0]) args[0] = `archive-worker-${crypto.randomUUID()}`;
      parentPort.postMessage({ type: 'diagnostic', method, args });
      return args[0];
    };
  }
  const open = (dbPath) => {
    if (!databases.has(dbPath)) databases.set(dbPath, new ChatDatabase(dbPath, { diagnostics }));
    return databases.get(dbPath);
  };
  let lastProgressAt = 0;
  const onProgress = (progress) => {
    const now = Date.now();
    if (now - lastProgressAt < 100 && progress?.current !== progress?.total) return;
    lastProgressAt = now;
    parentPort.postMessage({ type: 'progress', progress });
  };
  try {
    if (workerData.operation === 'overview') {
      const result = [];
      for (const account of workerData.accounts) {
        const db = open(account.dbPath);
        result.push({ ...account, stats: { ...db.getStats(), lastBackupAt: account.lastBackupAt || db.getLatestBackupAt() } });
        db.close();
        databases.delete(account.dbPath);
      }
      parentPort.postMessage({ type: 'result', result });
      return;
    }
    const implementation = require(`../../agents/${workerData.providerId}.cjs`);
    let result;
    if (workerData.operation === 'refreshAllLocal') {
      const entries = workerData.accounts;
      result = await implementation.refreshAllLocal({
        accounts: entries.map((entry) => entry.account),
        getDatabase: (account) => open(entries.find((entry) => entry.account.id === account.id).dbPath), onProgress,
      });
    } else {
      const db = open(workerData.dbPath);
      const snapshot = workerData.snapshotOperationId
        ? db.createRecoverySnapshot('before-official-backup-import', { operationId: workerData.snapshotOperationId }) : null;
      if (snapshot) parentPort.postMessage({ type: 'snapshot', path: snapshot.snapshot_database });
      result = await implementation[workerData.operation]({ db, inputPath: workerData.inputPath,
        replaceExisting: false, sourceConfig: workerData.sourceConfig || {}, onProgress });
      if (workerData.snapshotOperationId) result.preImportSnapshotPath = snapshot?.snapshot_database || null;
    }
    // Materialize changed summaries here, not during the next main-thread read.
    for (const db of databases.values()) db.getStats();
    parentPort.postMessage({ type: 'result', result });
  } finally { for (const db of databases.values()) db.close(); }
}

run().catch((error) => parentPort.postMessage({ type: 'result', error: String(error?.stack || error) }));
