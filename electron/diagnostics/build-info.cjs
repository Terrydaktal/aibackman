const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BUILD_INFO_SCHEMA = 'aibackman-build-info-v1';

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function gitValue(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function listFiles(root, relative = '') {
  const directory = path.join(root, relative);
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

function sourceDigest(root) {
  const hash = crypto.createHash('sha256');
  const files = listFiles(root)
    .filter((file) => (
      file.startsWith('electron/')
      || file.startsWith('src/')
      || file.startsWith('scripts/')
      || /^(package\.json|package-lock\.json|vite\.config\.[cm]?[jt]s|tsconfig.*\.json)$/.test(file)
    ))
    .sort();
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(readText(path.join(root, file)));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), files };
}

function artifactDigest(root) {
  const directory = path.join(root, 'dist');
  if (!fs.existsSync(directory)) return { digest: null, files: [] };
  const files = [];
  const visit = (relative = '') => {
    const current = path.join(directory, relative);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name !== 'build-info.json') files.push(child);
    }
  };
  visit();
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(directory, file)));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), files };
}

function createBuildInfo({ root = path.resolve(__dirname, '../..'), mode = 'release-minimal' } = {}) {
  const pkg = JSON.parse(readText(path.join(root, 'package.json')) || '{}');
  const source = sourceDigest(root);
  const revision = gitValue(root, ['rev-parse', 'HEAD']) || 'unavailable';
  const diffDigest = gitValue(root, ['diff', '--binary', 'HEAD'])
    ? crypto.createHash('sha256').update(gitValue(root, ['diff', '--binary', 'HEAD'])).digest('hex')
    : '';
  const dirty = Boolean(gitValue(root, ['status', '--porcelain']));
  const canonical = JSON.stringify({
    package_version: pkg.version || '0.0.0',
    mode,
    revision,
    dirty,
    diff_digest: diffDigest,
    source_digest: source.digest,
  });
  return {
    schema: BUILD_INFO_SCHEMA,
    build_id: crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32),
    package_name: pkg.name || 'aibackman',
    package_version: pkg.version || '0.0.0',
    build_mode: mode,
    git_revision: revision,
    git_dirty: dirty,
    git_diff_digest: diffDigest || null,
    source_digest: source.digest,
    source_file_count: source.files.length,
    node_version: process.versions.node,
    electron_version: process.versions.electron || null,
    platform: `${process.platform}-${process.arch}`,
    generated_at: new Date().toISOString(),
  };
}

function verifyBuildInfo({ root = path.resolve(__dirname, '../..'), buildInfo } = {}) {
  if (!buildInfo?.source_digest) return { valid: false, reason: 'missing-source-digest' };
  const source = sourceDigest(root);
  const artifacts = buildInfo.artifact_digest ? artifactDigest(root) : null;
  const sourceValid = source.digest === buildInfo.source_digest;
  const artifactsValid = !artifacts || artifacts.digest === buildInfo.artifact_digest;
  return {
    valid: sourceValid && artifactsValid,
    reason: !sourceValid ? 'source-digest-mismatch' : (!artifactsValid ? 'artifact-digest-mismatch' : null),
    expected_source_digest: buildInfo.source_digest,
    actual_source_digest: source.digest,
    source_file_count: source.files.length,
    expected_artifact_digest: buildInfo.artifact_digest || null,
    actual_artifact_digest: artifacts?.digest || null,
    artifact_file_count: artifacts?.files.length || null,
  };
}

function readBuildInfo(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (value?.schema !== BUILD_INFO_SCHEMA || !value.build_id) return null;
    return value;
  } catch {
    return null;
  }
}

function writeBuildInfo({ root = path.resolve(__dirname, '../..'), outputPath, mode } = {}) {
  const info = createBuildInfo({ root, mode });
  const artifacts = artifactDigest(root);
  const artifactCanonical = JSON.stringify({
    build_id: info.build_id,
    artifact_digest: artifacts.digest,
  });
  info.artifact_digest = artifacts.digest;
  info.artifact_file_count = artifacts.files.length;
  info.build_id = crypto.createHash('sha256').update(artifactCanonical).digest('hex').slice(0, 32);
  const target = outputPath || path.join(root, 'dist', 'build-info.json');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, target);
  return info;
}

if (require.main === module) {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : process.env.AIBACKMAN_BUILD_MODE || 'release-minimal';
  const info = writeBuildInfo({ mode });
  console.log(JSON.stringify(info, null, 2));
}

module.exports = {
  BUILD_INFO_SCHEMA,
  createBuildInfo,
  verifyBuildInfo,
  readBuildInfo,
  writeBuildInfo,
};
