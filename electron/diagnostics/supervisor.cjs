const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const MAX_EVENTS = 2000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function run() {
  const socketPath = arg('--socket');
  const tokenPath = arg('--token-file');
  const statePath = arg('--state-file');
  if (!socketPath || !tokenPath || !statePath) process.exit(2);
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(socketPath); } catch {}
  process.on('exit', () => {
    try { fs.unlinkSync(socketPath); } catch {}
    try { fs.unlinkSync(tokenPath); } catch {}
  });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  try { fs.chmodSync(tokenPath, 0o600); } catch {}
  const state = {
    schema: 'aibackman-supervisor-state-v1',
    started_at: new Date().toISOString(),
    last_parent_message_at: null,
    parent_alive: true,
    build: null,
    mode: null,
    session_id: null,
    process_instance_id: null,
    state: null,
    heartbeat: null,
    snapshot: null,
    startup_error: null,
    events: [],
    dropped: 0,
  };

  let persistTimer = null;
  const persist = (immediate = false) => {
    if (!immediate) {
      if (persistTimer) return;
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persist(true);
      }, 100);
      persistTimer.unref?.();
      return;
    }
    try { writeJson(statePath, { ...state, events: state.events.slice(-100) }); } catch {}
  };
  const receive = (message) => {
    state.last_parent_message_at = new Date().toISOString();
    if (message.type === 'build') Object.assign(state, { build: message.build || null, mode: message.mode, session_id: message.session_id, process_instance_id: message.process_instance_id });
    else if (message.type === 'event') {
      if (state.events.length >= MAX_EVENTS) { state.events.shift(); state.dropped += 1; }
      state.events.push(message.event);
    } else if (message.type === 'state') state.state = message.state;
    else if (message.type === 'heartbeat') state.heartbeat = message.heartbeat;
    else if (message.type === 'snapshot') state.snapshot = message.snapshot;
    else if (message.type === 'shutdown') { state.parent_alive = false; persist(true); process.exit(0); }
    persist();
  };

  process.on('message', receive);
  process.on('disconnect', () => {
    state.parent_alive = false;
    state.ended_at = new Date().toISOString();
    persist(true);
    process.exit(0);
  });

  const server = net.createServer((connection) => {
    let buffer = '';
    connection.setTimeout(2000);
    connection.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) return connection.destroy();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      let request;
      try { request = JSON.parse(line); } catch { return connection.end(`${JSON.stringify({ error: 'invalid-json' })}\n`); }
      if (request.token !== token) return connection.end(`${JSON.stringify({ error: 'unauthorized' })}\n`);
      let response;
      if (request.command === 'capabilities') response = { schema: 'aibackman-diagnostic-capabilities-v1', controls: ['capabilities', 'build-info', 'snapshot', 'events'], limits: { max_response_bytes: MAX_RESPONSE_BYTES, max_events: MAX_EVENTS } };
      else if (request.command === 'build-info') response = state.build || { unavailable: true };
      else if (request.command === 'snapshot') response = state.snapshot
        ? { ...state.snapshot, supervisor: { parent_alive: state.parent_alive, heartbeat: state.heartbeat, dropped: state.dropped } }
        : { ...state, events: state.events.slice(-100) };
      else if (request.command === 'events') {
        const count = Math.min(Math.max(Number(request.limit || 100), 1), 500);
        response = { events: state.events.slice(-count), dropped: state.dropped };
      } else response = { error: 'unknown-command' };
      let serialized = JSON.stringify(response);
      if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) serialized = JSON.stringify({ error: 'response-too-large' });
      connection.end(`${serialized}\n`);
    });
  });
  server.on('error', (error) => {
    state.startup_error = {
      code: error?.code || null,
      message: String(error?.message || error),
    };
    state.parent_alive = Boolean(process.connected);
    state.ended_at = new Date().toISOString();
    persist(true);
    process.exit(3);
  });
  server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch {}
    persist(true);
  });
}

if (process.argv.includes('--supervisor')) run();
