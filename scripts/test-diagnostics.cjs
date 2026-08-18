const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync, spawn } = require('child_process');
const { createBuildInfo, verifyBuildInfo, writeBuildInfo } = require('../electron/diagnostics/build-info.cjs');
const {
  MAX_SNAPSHOT_BYTES,
  MAX_FILE_BYTES,
  createDiagnosticRuntime,
  redact,
  safeJson,
} = require('../electron/diagnostics/runtime.cjs');
const { DbSearchWorker } = require('../electron/database.cjs');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSocket(socketPath) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (fs.existsSync(socketPath)) return;
    await wait(25);
  }
  throw new Error(`Timed out waiting for ${socketPath}`);
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await wait(25);
  }
  throw new Error(message);
}

function rawSupervisorRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = '';
    socket.setTimeout(2000);
    socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => { output += chunk.toString('utf8'); });
    socket.on('error', reject);
    socket.on('timeout', () => reject(new Error('Supervisor probe timed out.')));
    socket.on('close', () => {
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
}

function runAbruptExitFixture(root, readyPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, 'test-diagnostic-parent-exit.cjs'),
      root,
      readyPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-diagnostics-tests-'));
  const buildInfo = createBuildInfo({ root: path.resolve(__dirname, '..'), mode: 'diagnostic-build' });
  const buildRoot = path.join(root, 'build-identity');
  fs.mkdirSync(path.join(buildRoot, 'electron'), { recursive: true });
  fs.writeFileSync(path.join(buildRoot, 'package.json'), '{"name":"identity-test","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(buildRoot, 'electron', 'main.cjs'), 'module.exports = 1;\n');
  const isolatedBuildInfo = createBuildInfo({ root: buildRoot, mode: 'release-minimal' });
  assert.equal(verifyBuildInfo({ root: buildRoot, buildInfo: isolatedBuildInfo }).valid, true);
  fs.writeFileSync(path.join(buildRoot, 'electron', 'main.cjs'), 'module.exports = 2;\n');
  assert.equal(verifyBuildInfo({ root: buildRoot, buildInfo: isolatedBuildInfo }).valid, false);
  fs.mkdirSync(path.join(buildRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(buildRoot, 'dist', 'application.js'), 'console.log("built");\n');
  const persistedBuildInfo = writeBuildInfo({ root: buildRoot, mode: 'release-minimal' });
  assert.equal(verifyBuildInfo({ root: buildRoot, buildInfo: persistedBuildInfo }).valid, true);
  fs.writeFileSync(path.join(buildRoot, 'dist', 'application.js'), 'console.log("tampered");\n');
  const tamperedArtifacts = verifyBuildInfo({ root: buildRoot, buildInfo: persistedBuildInfo });
  assert.equal(tamperedArtifacts.valid, false);
  assert.equal(tamperedArtifacts.reason, 'artifact-digest-mismatch');

  const abruptRoot = path.join(root, 'abrupt-exit');
  const abruptReady = path.join(root, 'abrupt-ready.json');
  const abruptResult = await runAbruptExitFixture(abruptRoot, abruptReady);
  assert.equal(abruptResult.code, 17, abruptResult.stderr);
  const abruptPaths = JSON.parse(fs.readFileSync(abruptReady, 'utf8'));
  await waitFor(
    () => {
      try {
        return JSON.parse(fs.readFileSync(abruptPaths.supervisorState, 'utf8')).parent_alive === false;
      } catch {
        return false;
      }
    },
    'Independent supervisor did not preserve abrupt parent-exit evidence.'
  );
  const abruptState = JSON.parse(fs.readFileSync(abruptPaths.supervisorState, 'utf8'));
  assert.equal(abruptState.build.build_id, 'abrupt-exit-fixture');
  assert.ok(abruptState.events.some((entry) => entry.event === 'fixture-before-exit'));
  const inactiveRoot = path.join(root, 'inactive');
  const inactive = createDiagnosticRuntime({
    mode: 'release-minimal',
    enabled: false,
    buildInfo,
    rootPath: inactiveRoot,
  });
  assert.equal(inactive.active, false);
  assert.equal(inactive.sessionId, null);
  assert.equal(inactive.start(), null);
  assert.equal(fs.existsSync(inactiveRoot), false);
  assert.ok(Buffer.byteLength(safeJson({ text: '😀'.repeat(5000) }, 1024)) <= 1024);

  const workerEvents = [];
  const workerDiagnostics = {
    record: (event, payload) => workerEvents.push({ event, payload }),
    taskStart: (id) => id,
    taskEnd: (id, payload) => workerEvents.push({ event: 'task-ended', id, payload }),
    resourceOpen: (id) => id || 'worker-resource',
    resourceClose: (id, payload) => workerEvents.push({ event: 'resource-closed', id, payload }),
  };
  const hangingWorkerPath = path.join(root, 'hanging-worker.sh');
  fs.writeFileSync(hangingWorkerPath, '#!/bin/sh\nwhile IFS= read -r line; do :; done\n', { mode: 0o700 });
  const hangingWorker = new DbSearchWorker(path.join(root, 'worker.db'), {
    diagnostics: workerDiagnostics,
    databaseInstanceId: 'worker-test-db',
    requestTimeoutMs: 50,
    binaryResolver: () => hangingWorkerPath,
  });
  await assert.rejects(() => hangingWorker.search('timeout'), /timed out/i);
  hangingWorker.stop();
  assert.ok(workerEvents.some((entry) => entry.event === 'task-ended' && /timed out/i.test(entry.payload?.error || '')));
  assert.ok(workerEvents.some((entry) => entry.event === 'resource-closed'));

  const exitingWorkerPath = path.join(root, 'exiting-worker.sh');
  fs.writeFileSync(exitingWorkerPath, '#!/bin/sh\nexit 7\n', { mode: 0o700 });
  const exitingWorker = new DbSearchWorker(path.join(root, 'worker.db'), {
    diagnostics: workerDiagnostics,
    databaseInstanceId: 'worker-test-db',
    requestTimeoutMs: 500,
    binaryResolver: () => exitingWorkerPath,
  });
  await assert.rejects(() => exitingWorker.search('exit'), /exited|EPIPE|closed/i);
  await waitFor(
    () => workerEvents.some((entry) => entry.event === 'worker-exited'),
    'Worker exit evidence was not recorded.'
  );
  exitingWorker.stop();
  assert.ok(workerEvents.some((entry) => entry.event === 'worker-exited'));

  const expiredArtifact = path.join(root, 'events-expired.jsonl');
  fs.writeFileSync(expiredArtifact, '{}\n', { mode: 0o644 });
  const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(expiredArtifact, oldTime, oldTime);
  const runtime = createDiagnosticRuntime({
    mode: 'diagnostic-build',
    enabled: true,
    buildInfo,
    rootPath: root,
  });
  try {
    assert.equal(redact({ password: 'do-not-write', nested: { authorization: 'Bearer secret-value' } }).password, '[REDACTED]');
    assert.equal(redact({ nested: { authorization: 'Bearer secret-value' } }).nested.authorization, '[REDACTED]');
    const paths = runtime.start();
    await waitForSocket(paths.supervisorSocket);
    const concurrentRuntime = createDiagnosticRuntime({
      mode: 'release-observable',
      enabled: true,
      buildInfo,
      rootPath: root,
    });
    const concurrentPaths = concurrentRuntime.start();
    await waitForSocket(concurrentPaths.supervisorSocket);
    assert.notEqual(concurrentPaths.supervisorSocket, paths.supervisorSocket);
    assert.notEqual(concurrentPaths.supervisorToken, paths.supervisorToken);
    assert.equal(fs.existsSync(paths.supervisorSocket), true);
    assert.equal(fs.existsSync(concurrentPaths.supervisorSocket), true);
    await concurrentRuntime.stop('concurrency-test-complete');
    assert.equal(fs.existsSync(paths.supervisorSocket), true);
    assert.equal(fs.existsSync(expiredArtifact), false);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.events).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.capabilities).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.buildInfo).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.supervisorState).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.supervisorToken).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.supervisorSocket).mode & 0o777, 0o600);
    const unauthorized = await rawSupervisorRequest(paths.supervisorSocket, {
      token: 'wrong-token',
      command: 'snapshot',
    });
    assert.equal(unauthorized.error, 'unauthorized');
    runtime.setState('running', { reason: 'diagnostic-test' });
    const taskId = runtime.taskStart('diagnostic-task', { operationId: 'operation-1', token: 'sk-do-not-write' });
    runtime.taskUpdate(taskId, { progress: 1 });
    runtime.taskEnd(taskId, { state: 'completed' });
    const remoteProbe = runtime.snapshot({ test: 'control-plane' });
    await wait(50);
    const capabilities = JSON.parse(execFileSync(process.execPath, [
      path.join(__dirname, 'aibackman-diagnose.cjs'), '--debug-dir', root, 'capabilities',
    ], { encoding: 'utf8' }));
    assert.ok(capabilities.controls.includes('snapshot'));
    const remoteSnapshot = JSON.parse(execFileSync(process.execPath, [
      path.join(__dirname, 'aibackman-diagnose.cjs'), '--debug-dir', root, 'snapshot',
    ], { encoding: 'utf8' }));
    assert.equal(remoteSnapshot.schema, 'aibackman-diagnostic-snapshot-v1');
    assert.equal(remoteSnapshot.test, 'control-plane');
    const largePayload = { text: 'x'.repeat(4000) };
    for (let index = 0; index < 200; index += 1) runtime.taskStart(`bounded-task-${index}`, largePayload);
    for (let index = 0; index < 200; index += 1) runtime.resourceOpen(`bounded-resource-${index}`, largePayload);
    const boundedSnapshot = runtime.snapshot({ test: 'bounded-snapshot' });
    assert.ok(Buffer.byteLength(JSON.stringify(boundedSnapshot)) <= MAX_SNAPSHOT_BYTES);
    await wait(100);
    const boundedRemoteSnapshot = JSON.parse(execFileSync(process.execPath, [
      path.join(__dirname, 'aibackman-diagnose.cjs'), '--debug-dir', root, 'snapshot',
    ], { encoding: 'utf8' }));
    assert.equal(boundedRemoteSnapshot.schema, 'aibackman-diagnostic-snapshot-v1');
    assert.equal(boundedRemoteSnapshot.error, undefined);
    for (let index = 0; index < 1200; index += 1) runtime.record('synthetic-event', { index, secret: 'never-persist' });
    const snapshot = runtime.snapshot({ test: true });
    assert.equal(snapshot.schema, 'aibackman-diagnostic-snapshot-v1');
    assert.ok(snapshot.event_ring.retained <= 1000);
    assert.ok(snapshot.event_ring.dropped > 0);
    assert.equal(snapshot.build.build_id, buildInfo.build_id);
    assert.equal(remoteProbe.test, 'control-plane');

    await wait(50);
    const lines = fs.readFileSync(paths.events, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 100);
    assert.ok(fs.statSync(paths.events).size <= MAX_FILE_BYTES);
    assert.ok(lines.every((line) => JSON.parse(line).schema === 'aibackman-diagnostic-event-v1'));
    assert.ok(!fs.readFileSync(paths.events, 'utf8').includes('never-persist'));
  } finally {
    await runtime.stop();
    const ttlRoot = path.join(root, 'ttl');
    const ttlRuntime = createDiagnosticRuntime({
      mode: 'runtime-activated',
      enabled: true,
      buildInfo,
      rootPath: ttlRoot,
      activationTtlMs: 50,
    });
    const ttlPaths = ttlRuntime.start();
    await waitForSocket(ttlPaths.supervisorSocket);
    await waitFor(() => !ttlRuntime.active, 'Diagnostic activation TTL did not stop the runtime.');
    assert.equal(fs.existsSync(ttlPaths.snapshot), true);
    assert.equal(fs.existsSync(ttlPaths.supervisorToken), false);
    await wait(50);
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Diagnostic contract regression checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
