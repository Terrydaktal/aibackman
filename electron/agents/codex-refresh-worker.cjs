const { parentPort, workerData } = require('worker_threads');
const ChatDatabase = require('../database.cjs');
const { refreshAllLocalDirect, refreshLocalDirect } = require('./codex.cjs');

if (!parentPort) throw new Error('Codex refresh worker requires a parent port.');

let lastProgress = null;
let lastProgressAt = 0;

function reportProgress(progress) {
  lastProgress = progress;
  const now = Date.now();
  if (now - lastProgressAt < 100 && progress?.current !== progress?.total) return;
  lastProgressAt = now;
  parentPort.postMessage({ type: 'progress', progress });
}

function flushProgress() {
  if (!lastProgress || Date.now() - lastProgressAt < 1) return;
  parentPort.postMessage({ type: 'progress', progress: lastProgress });
}

async function run() {
  const databases = [];
  try {
    let result;
    if (workerData?.mode === 'single') {
      const db = new ChatDatabase(workerData.dbPath);
      databases.push(db);
      result = await refreshLocalDirect({
        db,
        sourceConfig: workerData.sourceConfig || {},
        onProgress: reportProgress,
      });
    } else if (workerData?.mode === 'all') {
      const entries = Array.isArray(workerData.accounts) ? workerData.accounts : [];
      const databaseByAccountId = new Map(entries.map(({ account, dbPath }) => {
        const db = new ChatDatabase(dbPath, { accountId: account.id });
        databases.push(db);
        return [account.id, db];
      }));
      result = await refreshAllLocalDirect({
        accounts: entries.map((entry) => entry.account),
        getDatabase: (account) => databaseByAccountId.get(account.id),
        onProgress: reportProgress,
      });
    } else {
      throw new Error(`Unknown Codex refresh worker mode: ${workerData?.mode || 'missing'}.`);
    }
    flushProgress();
    parentPort.postMessage({ type: 'result', result });
  } finally {
    for (const db of databases) db.close();
  }
}

run().catch((error) => {
  parentPort.postMessage({
    type: 'result',
    error: String(error?.stack || error),
  });
});
