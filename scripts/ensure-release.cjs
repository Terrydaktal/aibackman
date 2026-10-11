const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { readBuildInfo, verifyBuildInfo } = require('../electron/diagnostics/build-info.cjs');

function dependencyIdentity(root) {
  const hash = crypto.createHash('sha256');
  hash.update(`${process.versions.node}:${process.platform}:${process.arch}`);
  for (const file of ['node_modules/.package-lock.json', 'node_modules/electron/package.json', 'node_modules/typescript/package.json', 'node_modules/vite/package.json']) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(root, file)));
    const stat = fs.statSync(path.join(root, file));
    hash.update(`${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`);
  }
  return hash.digest('hex');
}

function ensureRelease(root = path.resolve(__dirname, '..')) {
  if (root === path.resolve(__dirname, '..')) require('./build-search.cjs');
  const info = readBuildInfo(path.join(root, 'dist/build-info.json'));
  const receiptPath = path.join(root, 'dist/launch-cache.json');
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch {}
  const dependencies = dependencyIdentity(root);
  if (info?.build_mode === 'release-minimal' && receipt?.dependencies === dependencies
    && receipt?.build_id === info.build_id && verifyBuildInfo({ root, buildInfo: info }).valid) return;
  const result = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Release build failed (${result.status ?? result.signal}).`);
  const built = readBuildInfo(path.join(root, 'dist/build-info.json'));
  if (!built || !verifyBuildInfo({ root, buildInfo: built }).valid) throw new Error('Release build verification failed.');
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ build_id: built.build_id, dependencies }));
  fs.renameSync(temporary, receiptPath);
}

if (require.main === module) {
  try { ensureRelease(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { ensureRelease, dependencyIdentity };
