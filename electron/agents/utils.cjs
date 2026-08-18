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
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, '$date')) {
      return asUnixSeconds(value.$date, fallback);
    }
    if (Object.prototype.hasOwnProperty.call(value, '$numberLong')) {
      return asUnixSeconds(value.$numberLong, fallback);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'seconds')) {
      const seconds = Number(value.seconds);
      const nanos = Number(value.nanos || value.nanoseconds || 0);
      if (Number.isFinite(seconds)) return seconds + (Number.isFinite(nanos) ? nanos / 1_000_000_000 : 0);
    }
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') {
    return numeric > 10_000_000_000 ? numeric / 1000 : numeric;
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

const MIME_TYPES = new Map([
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain'],
  ['.webp', 'image/webp'],
  ['.css', 'text/css'],
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.json', 'application/json'],
  ['.py', 'text/x-python'],
  ['.sh', 'text/x-shellscript'],
]);

function mimeTypeForPath(filePath) {
  return MIME_TYPES.get(path.extname(String(filePath || '')).toLowerCase()) || 'application/octet-stream';
}

function createAssetStore(db, providerId) {
  const root = path.join(path.dirname(db.dbPath), 'assets', String(providerId || 'archive'));
  fs.mkdirSync(root, { recursive: true });
  const copied = new Map();

  function add(sourcePath, key = sourcePath, displayName = path.basename(String(sourcePath || ''))) {
    if (!sourcePath || !fs.existsSync(sourcePath)) return null;
    let stat;
    try {
      stat = fs.lstatSync(sourcePath);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return null;

    const normalizedName = path.basename(String(displayName || sourcePath)) || 'attachment';
    const extension = path.extname(normalizedName).slice(0, 20).toLowerCase();
    const id = stableId('asset', `${providerId}|${key}|${sourcePath}`);
    const destination = path.join(root, `${id}${extension}`);
    if (!copied.has(id)) {
      try {
        fs.copyFileSync(sourcePath, destination);
      } catch {
        return null;
      }
    }
    copied.set(id, destination);
    return {
      id,
      name: normalizedName,
      sizeBytes: stat.size,
      mimeType: mimeTypeForPath(normalizedName),
      path: destination,
      uri: `archive-asset://local?path=${encodeURIComponent(destination)}`,
    };
  }

  return { root, add };
}

function attachmentMarkdown(attachments) {
  return attachments
    .filter((attachment) => attachment && attachment.uri)
    .map((attachment) => {
      const label = String(attachment.name || 'attachment').replace(/[\[\]]/g, '');
      return String(attachment.mimeType || '').startsWith('image/')
        ? `![${label}](${attachment.uri})`
        : `[${label}](${attachment.uri})`;
    });
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
  attachmentMarkdown,
  compactTitle,
  createAssetStore,
  fileFingerprint,
  findNamedFile,
  findNamedFiles,
  materializeBackupPath,
  mimeTypeForPath,
  parseJsonFile,
  stableId,
};
