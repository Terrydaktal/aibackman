const { parentPort } = require('worker_threads');
const { parseSession } = require('./codex-session-parser.cjs');

if (!parentPort) throw new Error('Codex session parser worker requires a parent port.');

parentPort.on('message', async ({ requestId, filePath }) => {
  try {
    const session = await parseSession(filePath);
    parentPort.postMessage({ requestId, session });
  } catch (error) {
    parentPort.postMessage({
      requestId,
      error: String(error?.stack || error),
    });
  }
});
