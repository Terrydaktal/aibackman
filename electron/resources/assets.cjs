const fs = require('fs');
const path = require('path');
const { ByteCache } = require('./byte-cache.cjs');

class ArchiveAssets {
  constructor(maxBytes = 32 * 1024 * 1024) {
    this.cache = new ByteCache(maxBytes);
    this.pending = new Map();
  }
  async read(filePath, storageRoot) {
    const root = await fs.promises.realpath(storageRoot);
    const resolved = await fs.promises.realpath(filePath);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Archive asset is outside managed storage.');
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Archive asset is not a regular file.');
    const key = `${resolved}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = (async () => {
      const file = await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Archive asset changed while opening.');
        const bytes = await file.readFile();
        this.cache.set(key, bytes, bytes.length);
        return bytes;
      } finally { await file.close(); }
    })();
    this.pending.set(key, pending);
    try { return await pending; } finally { this.pending.delete(key); }
  }
}

function coalesceResponseRequests(fetchResponse) {
  const pending = new Map();
  return async (key, ...args) => {
    if (!pending.has(key)) pending.set(key, (async () => {
      const response = await fetchResponse(...args);
      return { body: await response.arrayBuffer(), status: response.status, statusText: response.statusText, headers: [...response.headers] };
    })());
    const request = pending.get(key);
    try {
      const result = await request;
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers: result.headers });
    } finally { if (pending.get(key) === request) pending.delete(key); }
  };
}

module.exports = { ArchiveAssets, coalesceResponseRequests };
