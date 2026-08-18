#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createDiagnosticRuntime } = require('../electron/diagnostics/runtime.cjs');

const rootPath = process.argv[2];
const readyPath = process.argv[3];
if (!rootPath || !readyPath) process.exit(2);

const runtime = createDiagnosticRuntime({
  mode: 'diagnostic-build',
  enabled: true,
  rootPath,
  activationTtlMs: 30000,
  buildInfo: {
    schema: 'aibackman-build-info-v1',
    build_id: 'abrupt-exit-fixture',
    build_mode: 'diagnostic-build',
  },
});
const paths = runtime.start();
runtime.setState('fixture-running', { fixture: 'abrupt-parent-exit' });
runtime.record('fixture-before-exit', { expected_exit_code: 17 });
runtime.snapshot({ fixture: 'abrupt-parent-exit' });

async function waitForSupervisorEvidence() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const state = JSON.parse(fs.readFileSync(paths.supervisorState, 'utf8'));
      if (
        state.build?.build_id === 'abrupt-exit-fixture'
        && state.events?.some((entry) => entry.event === 'fixture-before-exit')
      ) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Supervisor did not become ready before the abrupt-exit fixture timeout.');
}

waitForSupervisorEvidence()
  .then(() => {
    fs.writeFileSync(readyPath, `${JSON.stringify(paths)}\n`, { mode: 0o600 });
    process.exit(17);
  })
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(3);
  });
