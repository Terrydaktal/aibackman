const path = require('path');
const { Worker } = require('worker_threads');

function runArchiveWorker(data, onProgress, diagnostics = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'archive-worker-entry.cjs'), { workerData: {
      ...data, buildInfo: diagnostics?.getBuildInfo?.() || null, observable: !!diagnostics?.active,
    } });
    const resourceId = diagnostics?.resourceOpen(null, { type: 'archive-worker', provider_id: data.providerId, operation: data.operation });
    const taskId = diagnostics?.taskStart(null, { worker: 'archive', provider_id: data.providerId, operation: data.operation });
    let settled = false;
    let snapshotPath = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      diagnostics?.taskEnd(taskId, error ? { error } : { state: 'completed' });
      if (error) { error.preImportSnapshotPath = snapshotPath; reject(error); } else resolve(result);
    };
    worker.on('message', async (message) => {
      if (message.type === 'progress') onProgress?.(message.progress);
      else if (message.type === 'snapshot') snapshotPath = message.path;
      else if (message.type === 'diagnostic') diagnostics?.[message.method]?.(...message.args);
      else if (message.type === 'chromium-read') {
        try {
          const records = await require('../../agents/chathub.cjs').readChromiumIndexedDbRecords(message.path);
          worker.postMessage({ type: 'chromium-result', records });
        } catch (error) { worker.postMessage({ type: 'chromium-result', error: error.message }); }
      } else if (message.type === 'result') finish(message.error ? new Error(message.error) : null, message.result);
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      diagnostics?.resourceClose(resourceId, { type: 'archive-worker', exit_code: code });
      if (!settled) finish(new Error(`Archive worker exited without completing (${code}).`));
    });
  });
}

module.exports = { runArchiveWorker };
