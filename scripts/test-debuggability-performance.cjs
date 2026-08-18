#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const ChatDatabase = require('../electron/database.cjs');
const { createBuildInfo } = require('../electron/diagnostics/build-info.cjs');
const { createDiagnosticRuntime } = require('../electron/diagnostics/runtime.cjs');

const MAX_INACTIVE_CALL_AVERAGE_MS = 0.002;
const MAX_ACTIVE_RECORD_P99_MS = 1;
const MAX_SNAPSHOT_MS = 100;
const MAX_AUDIT_ADDED_P99_MS = 200;
const MAX_AUDIT_THROUGHPUT_REGRESSION_PERCENT = 5000;

function elapsedMilliseconds(callback) {
  const started = process.hrtime.bigint();
  const value = callback();
  return { value, milliseconds: Number(process.hrtime.bigint() - started) / 1e6 };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function benchmarkInactive(buildInfo, root) {
  const runtime = createDiagnosticRuntime({
    mode: 'release-minimal',
    enabled: false,
    buildInfo,
    rootPath: path.join(root, 'minimal-must-not-exist'),
  });
  const iterations = 250000;
  const measurement = elapsedMilliseconds(() => {
    for (let index = 0; index < iterations; index += 1) runtime.record('disabled');
  });
  const averageMs = measurement.milliseconds / iterations;
  assert.ok(averageMs <= MAX_INACTIVE_CALL_AVERAGE_MS,
    `Inactive diagnostic call average ${averageMs.toFixed(6)}ms exceeds ${MAX_INACTIVE_CALL_AVERAGE_MS}ms.`);
  assert.equal(fs.existsSync(path.join(root, 'minimal-must-not-exist')), false);
  return { iterations, totalMs: measurement.milliseconds, averageMs };
}

async function benchmarkActive(buildInfo, root) {
  const runtime = createDiagnosticRuntime({
    mode: 'release-observable',
    enabled: true,
    buildInfo,
    rootPath: path.join(root, 'observable'),
    activationTtlMs: 30000,
  });
  runtime.start();
  const durations = [];
  for (let index = 0; index < 500; index += 1) {
    durations.push(elapsedMilliseconds(() => runtime.record('performance-sample', { index })).milliseconds);
  }
  const snapshotDuration = elapsedMilliseconds(() => runtime.snapshot({ benchmark: true })).milliseconds;
  await runtime.stop('performance-test-complete');
  const p99Ms = percentile(durations, 0.99);
  assert.ok(p99Ms <= MAX_ACTIVE_RECORD_P99_MS,
    `Active diagnostic record p99 ${p99Ms.toFixed(3)}ms exceeds ${MAX_ACTIVE_RECORD_P99_MS}ms.`);
  assert.ok(snapshotDuration <= MAX_SNAPSHOT_MS,
    `Diagnostic snapshot ${snapshotDuration.toFixed(3)}ms exceeds ${MAX_SNAPSHOT_MS}ms.`);
  return { samples: durations.length, p99Ms, snapshotMs: snapshotDuration };
}

function createRawDatabase(dbPath) {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = FULL');
  sqlite.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT, created_at DATETIME, updated_at DATETIME,
      last_synced_updated_at DATETIME, current_node_id TEXT,
      cache_format_version INTEGER, is_deleted_on_web INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT,
      metadata_json TEXT, created_at DATETIME, parent_id TEXT
    );
  `);
  sqlite.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at)
    VALUES ('performance-conversation', 'Performance conversation', 1, 1)
  `).run();
  return sqlite;
}

function benchmarkArchiveAudit(root) {
  const protectedDb = new ChatDatabase(path.join(root, 'protected.db'), { initializeSearchIndex: false });
  const rawDb = createRawDatabase(path.join(root, 'raw.db'));
  const rawInsert = rawDb.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at, parent_id)
    VALUES (?, 'performance-conversation', 'assistant', ?, '{}', ?, NULL)
  `);
  const rawBatch = rawDb.transaction((round, batchSize) => {
    for (let index = 0; index < batchSize; index += 1) {
      rawInsert.run(`raw-${round}-${index}`, `answer ${round}-${index}`, round * batchSize + index);
    }
  });
  protectedDb.upsertConversation({
    id: 'performance-conversation',
    title: 'Performance conversation',
    created_at: 1,
    updated_at: 1,
  });
  const batchSize = 200;
  const rounds = 100;
  const rawDurations = [];
  const protectedDurations = [];
  try {
    for (let round = 0; round < rounds; round += 1) {
      rawDurations.push(elapsedMilliseconds(() => rawBatch(round, batchSize)).milliseconds);
      protectedDurations.push(elapsedMilliseconds(() => protectedDb.runArchiveOperation({
        type: 'performance-batch',
        actor: 'performance-test',
        reason: 'Measure always-on archive safety cost.',
        reasonCode: 'performance-measurement',
      }, () => {
        for (let index = 0; index < batchSize; index += 1) {
          protectedDb.upsertMessage({
            id: `protected-${round}-${index}`,
            conversation_id: 'performance-conversation',
            role: 'assistant',
            content: `answer ${round}-${index}`,
            metadata_json: '{}',
            created_at: round * batchSize + index,
            parent_id: null,
          });
        }
      })).milliseconds);
    }
    const added = protectedDurations.map((duration, index) => Math.max(0, duration - rawDurations[index]));
    const rawMedian = percentile(rawDurations, 0.5);
    const protectedMedian = percentile(protectedDurations, 0.5);
    const addedP99Ms = percentile(added, 0.99);
    const throughputRegressionPercent = ((protectedMedian / rawMedian) - 1) * 100;
    assert.ok(addedP99Ms <= MAX_AUDIT_ADDED_P99_MS,
      `Archive audit added p99 ${addedP99Ms.toFixed(3)}ms exceeds ${MAX_AUDIT_ADDED_P99_MS}ms.`);
    assert.ok(throughputRegressionPercent <= MAX_AUDIT_THROUGHPUT_REGRESSION_PERCENT,
      `Archive audit throughput regression ${throughputRegressionPercent.toFixed(1)}% exceeds ${MAX_AUDIT_THROUGHPUT_REGRESSION_PERCENT}%.`);
    return {
      rounds,
      batchSize,
      rawMedianMs: rawMedian,
      protectedMedianMs: protectedMedian,
      addedP99Ms,
      throughputRegressionPercent,
    };
  } finally {
    protectedDb.close();
    rawDb.close();
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-performance-'));
  try {
    const buildInfo = createBuildInfo({ root: path.resolve(__dirname, '..'), mode: 'diagnostic-build' });
    const report = {
      schema: 'aibackman-debuggability-performance-v1',
      measuredAt: new Date().toISOString(),
      inactive: benchmarkInactive(buildInfo, root),
      active: await benchmarkActive(buildInfo, root),
      archiveAudit: benchmarkArchiveAudit(root),
      limits: {
        inactiveCallAverageMs: MAX_INACTIVE_CALL_AVERAGE_MS,
        activeRecordP99Ms: MAX_ACTIVE_RECORD_P99_MS,
        snapshotMs: MAX_SNAPSHOT_MS,
        auditAddedP99Ms: MAX_AUDIT_ADDED_P99_MS,
        auditThroughputRegressionPercent: MAX_AUDIT_THROUGHPUT_REGRESSION_PERCENT,
      },
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
