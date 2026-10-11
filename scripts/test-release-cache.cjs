const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureRelease } = require('./ensure-release.cjs');
const { writeBuildInfo } = require('../electron/diagnostics/build-info.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-launch-test-'));
const bin = path.join(root, 'bin');
const priorPath = process.env.PATH;
try {
  for (const directory of ['src', 'electron', 'public', 'dist', 'scripts', 'node_modules/electron', 'node_modules/vite', 'node_modules/typescript', 'bin']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'synthetic', version: '1' }));
  for (const file of ['node_modules/.package-lock.json', 'node_modules/electron/package.json', 'node_modules/vite/package.json', 'node_modules/typescript/package.json']) fs.writeFileSync(path.join(root, file), '{}');
  fs.writeFileSync(path.join(root, 'dist/index.html'), 'synthetic artifact');
  const npm = `#!/usr/bin/env node\nconst fs=require('fs'); const root=process.cwd(); fs.appendFileSync(root+'/builds', 'build\\n'); require(${JSON.stringify(path.resolve(__dirname, '../electron/diagnostics/build-info.cjs'))}).writeBuildInfo({root,mode:'release-minimal'});`;
  fs.writeFileSync(path.join(bin, 'npm'), npm, { mode: 0o700 });
  process.env.PATH = `${bin}${path.delimiter}${priorPath}`;
  const count = () => fs.readFileSync(path.join(root, 'builds'), 'utf8').trim().split('\n').length;
  ensureRelease(root); assert.equal(count(), 1);
  ensureRelease(root); assert.equal(count(), 1);
  for (const file of ['src/example.ts', 'electron/example.cjs', 'public/fixture.svg', 'index.html', 'package-lock.json', 'tsconfig.app.json', 'vite.config.ts', 'scripts/example.cjs']) {
    fs.writeFileSync(path.join(root, file), 'changed');
    const previous = count(); ensureRelease(root); assert.equal(count(), previous + 1, file);
    ensureRelease(root); assert.equal(count(), previous + 1);
  }
  fs.unlinkSync(path.join(root, 'src/example.ts'));
  let previous = count(); ensureRelease(root); assert.equal(count(), previous + 1);
  fs.writeFileSync(path.join(root, 'node_modules/vite/package.json'), '{"version":"new"}');
  previous = count(); ensureRelease(root); assert.equal(count(), previous + 1);
  fs.writeFileSync(path.join(root, 'dist/index.html'), 'tampered artifact');
  previous = count(); ensureRelease(root); assert.equal(count(), previous + 1);
  writeBuildInfo({ root, mode: 'diagnostic-build' });
  previous = count(); ensureRelease(root); assert.equal(count(), previous + 1);
  ensureRelease(root); assert.equal(count(), previous + 1);

  // Installed symlink, unrelated cwd, explicit environment overrides and argv.
  const launcherRoot = path.join(root, 'launcher project');
  for (const directory of ['scripts', 'node_modules/.bin']) fs.mkdirSync(path.join(launcherRoot, directory), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'aibackman'), path.join(launcherRoot, 'scripts/aibackman'));
  fs.chmodSync(path.join(launcherRoot, 'scripts/aibackman'), 0o700);
  fs.writeFileSync(path.join(launcherRoot, 'scripts/ensure-release.cjs'), '');
  fs.writeFileSync(path.join(launcherRoot, 'node_modules/.bin/electron'), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),platform:process.env.ELECTRON_OZONE_PLATFORM_HINT,visible:process.env.AIBACKMAN_BRIDGE_VISIBLE,mode:process.env.NODE_ENV}));`, { mode: 0o700 });
  const link = path.join(bin, 'aibackman');
  fs.symlinkSync(path.join(launcherRoot, 'scripts/aibackman'), link);
  const result = spawnSync(link, ['--fixture', 'space argument', '--'], { cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: 'x11', AIBACKMAN_BRIDGE_VISIBLE: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cwd: launcherRoot, args: ['.', '--fixture', 'space argument', '--'], platform: 'x11', visible: '1', mode: 'production' });
  const defaults = { ...process.env };
  delete defaults.ELECTRON_OZONE_PLATFORM_HINT; delete defaults.AIBACKMAN_BRIDGE_VISIBLE;
  const defaultResult = spawnSync(link, [], { cwd: os.tmpdir(), encoding: 'utf8', env: defaults });
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(JSON.parse(defaultResult.stdout).platform, 'wayland');
  assert.equal(JSON.parse(defaultResult.stdout).visible, '0');
  fs.writeFileSync(path.join(root, 'src/failed.ts'), 'changed');
  fs.writeFileSync(path.join(bin, 'npm'), '#!/usr/bin/env node\nprocess.exit(7);', { mode: 0o700 });
  assert.throws(() => ensureRelease(root), /build failed \(7\)/i);
  console.log('Release reuse/invalidation/artifact integrity/mode and symlink launcher contracts passed.');
} finally { process.env.PATH = priorPath; fs.rmSync(root, { recursive: true, force: true }); }
