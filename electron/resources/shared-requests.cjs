const cancelled = () => Object.assign(new Error('Search cancelled.'), { name: 'AbortError' });

// Identical work is shared, but each caller owns only its own subscription.
// Abort the underlying task only after its last subscriber leaves.
class SharedRequests {
  constructor() { this.pending = new Map(); }
  run(key, create, signal) {
    if (signal?.aborted) return Promise.reject(cancelled());
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { controller: new AbortController(), subscribers: 0, settled: false };
      this.pending.set(key, entry);
      entry.promise = Promise.resolve().then(() => create(entry.controller.signal));
      const finish = () => {
        entry.settled = true;
        if (this.pending.get(key) === entry) this.pending.delete(key);
      };
      entry.promise.then(finish, finish);
    }
    entry.subscribers += 1;
    return new Promise((resolve, reject) => {
      let done = false;
      const complete = (callback, value) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', abort);
        entry.subscribers -= 1;
        if (!entry.subscribers && !entry.settled) {
          if (this.pending.get(key) === entry) this.pending.delete(key);
          entry.controller.abort();
        }
        callback(value);
      };
      const abort = () => complete(reject, cancelled());
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then((value) => complete(resolve, value), (error) => complete(reject, error));
    });
  }
  clear() {
    for (const entry of this.pending.values()) entry.controller.abort();
    this.pending.clear();
  }
}

module.exports = { SharedRequests };
