class ByteCache {
  constructor(maxBytes, maxEntries = 128) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.bytes = 0;
    this.entries = new Map();
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value, bytes) {
    this.delete(key);
    bytes += Buffer.byteLength(String(key));
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) this.delete(this.entries.keys().next().value);
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}

module.exports = { ByteCache };
