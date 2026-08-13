const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function stableId(prefix, value) {
  const digest = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
  return `${prefix}-${digest}`;
}

function fileFingerprint(filePath) {
  const stat = fs.statSync(filePath);
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

function findNamedFile(inputPath, names, maxDepth = 6) {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return resolved;

  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const queue = [{ directory: resolved, depth: 0 }];
  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && wanted.has(entry.name.toLowerCase())) return entryPath;
      if (entry.isDirectory() && depth < maxDepth && !entry.name.startsWith('.')) {
        queue.push({ directory: entryPath, depth: depth + 1 });
      }
    }
  }
  throw new Error(`Could not find ${names.join(' or ')} under ${resolved}`);
}

function findNamedFiles(inputPath, names, maxDepth = 6) {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return [resolved];

  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const matches = [];
  const queue = [{ directory: resolved, depth: 0 }];
  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && wanted.has(entry.name.toLowerCase())) matches.push(entryPath);
      if (entry.isDirectory() && depth < maxDepth && !entry.name.startsWith('.')) {
        queue.push({ directory: entryPath, depth: depth + 1 });
      }
    }
  }
  return matches;
}

function asUnixSeconds(value, fallback = Date.now() / 1000) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value / 1000 : value;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed / 1000 : fallback;
}

function compactTitle(value, fallback = 'Untitled chat') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function parseJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function archiveEntryIsUnsafe(entry) {
  const normalized = entry.replace(/\\/g, '/');
  return path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split('/').includes('..');
}

function assertExtractedTreeIsSafe(rootPath) {
  const pending = [rootPath];
  while (pending.length > 0) {
    const currentPath = pending.pop();
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Backup ZIP contains a symbolic link: ${path.relative(rootPath, currentPath)}`);
    }
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(currentPath)) {
      pending.push(path.join(currentPath, entry));
    }
  }
}

function materializeBackupPath(inputPath) {
  const resolved = path.resolve(inputPath);
  if (path.extname(resolved).toLowerCase() !== '.zip') {
    return { path: resolved, cleanup: () => {} };
  }

  const listing = spawnSync('unzip', ['-Z1', resolved], { encoding: 'utf8' });
  if (listing.status !== 0) {
    throw new Error((listing.stderr || listing.stdout || 'Could not inspect backup ZIP file.').trim());
  }
  const entries = String(listing.stdout || '').split(/\r?\n/).filter(Boolean);
  const unsafeEntry = entries.find(archiveEntryIsUnsafe);
  if (unsafeEntry) throw new Error(`Backup ZIP contains an unsafe path: ${unsafeEntry}`);

  const temporaryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-archive-backup-'));
  try {
    const extraction = spawnSync('unzip', ['-q', resolved, '-d', temporaryPath], { encoding: 'utf8' });
    if (extraction.status !== 0) {
      throw new Error((extraction.stderr || extraction.stdout || 'Could not extract backup ZIP file.').trim());
    }
    assertExtractedTreeIsSafe(temporaryPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
    throw error;
  }
  return {
    path: temporaryPath,
    cleanup: () => fs.rmSync(temporaryPath, { recursive: true, force: true }),
  };
}

module.exports = {
  asUnixSeconds,
  compactTitle,
  fileFingerprint,
  findNamedFile,
  findNamedFiles,
  materializeBackupPath,
  parseJsonFile,
  stableId,
};
