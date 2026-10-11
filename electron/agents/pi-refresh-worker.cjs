const { parentPort, workerData } = require('worker_threads');
const ChatDatabase = require('../database.cjs');
const { refreshLocalDirect } = require('./pi.cjs');

let lastProgressAt = 0;
let snapshotPath = null;
async function run() {
  const db = new ChatDatabase(workerData.dbPath);
  try {
    const snapshot = workerData.snapshotOperationId
      ? db.createRecoverySnapshot('before-official-backup-import', { operationId: workerData.snapshotOperationId }) : null;
    snapshotPath = snapshot?.snapshot_database || null;
    const result = await refreshLocalDirect({
      db, sourceConfig: workerData.sourceConfig, inputPath: workerData.inputPath,
      onProgress: (progress) => {
        const now = Date.now();
        const finished = Number.isFinite(progress.total) && progress.current === progress.total;
        if (now - lastProgressAt < 100 && !finished) return;
        lastProgressAt = now;
        parentPort.postMessage({ type: 'progress', progress });
      },
    });
    db.getStats();
    if (workerData.snapshotOperationId) result.preImportSnapshotPath = snapshot?.snapshot_database || null;
    return result;
  } finally {
    db.close();
  }
}

run().then(
  (result) => parentPort.postMessage({ type: 'result', result }),
  // Error messages from JSON parsers may include private source text.
  (error) => parentPort.postMessage({ type: 'result', error: `Pi import failed (${error.code || 'invalid or incomplete source'}).`, preImportSnapshotPath: snapshotPath }),
);
