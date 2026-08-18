#!/usr/bin/env node
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

function usage() {
  console.log(`Usage: aibackman-diagnose [--debug-dir PATH] <capabilities|build-info|snapshot|events> [--last N]

Reads the bounded diagnostic control plane without enabling DevTools or attaching a debugger.`);
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function defaultDir() {
  return option('--debug-dir', path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'aibackman', 'debug'));
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function latestFile(directory, predicate) {
  return fs.readdirSync(directory)
    .filter(predicate)
    .map((entry) => ({ entry, mtimeMs: fs.statSync(path.join(directory, entry)).mtimeMs }))
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .at(-1)?.entry || null;
}

function sessionFile(directory, prefix, suffix, legacyName = null) {
  const requested = option('--session');
  if (requested) {
    const exact = `${prefix}${requested}${suffix}`;
    if (fs.existsSync(path.join(directory, exact))) return exact;
    throw new Error(`No diagnostic file exists for session ${requested}.`);
  }
  return latestFile(directory, (entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
    || (legacyName && fs.existsSync(path.join(directory, legacyName)) ? legacyName : null);
}

function activeSupervisorTokenFile(directory) {
  const requested = option('--session');
  if (requested) {
    const capabilitiesPath = path.join(directory, `capabilities-${requested}.json`);
    if (fs.existsSync(capabilitiesPath)) {
      const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'));
      if (capabilities.supervisor_id) {
        const tokenFile = `supervisor-${capabilities.supervisor_id}.token`;
        const socketFile = `supervisor-${capabilities.supervisor_id}.sock`;
        if (fs.existsSync(path.join(directory, tokenFile)) && fs.existsSync(path.join(directory, socketFile))) {
          return tokenFile;
        }
      }
    }
    const legacyToken = `supervisor-${requested}.token`;
    if (fs.existsSync(path.join(directory, legacyToken))) return legacyToken;
    throw new Error(`No active diagnostic supervisor exists for session ${requested}.`);
  }
  return latestFile(directory, (entry) => {
    if (!entry.startsWith('supervisor-') || !entry.endsWith('.token')) return false;
    const socketFile = `${entry.slice(0, -'.token'.length)}.sock`;
    return fs.existsSync(path.join(directory, socketFile));
  }) || (fs.existsSync(path.join(directory, 'supervisor.token')) ? 'supervisor.token' : null);
}

function offline(directory, command) {
  const files = {
    capabilities: sessionFile(directory, 'capabilities-', '.json', 'capabilities.json'),
    snapshot: sessionFile(directory, 'snapshot-', '.json'),
    'build-info': sessionFile(directory, 'build-info-', '.json'),
    events: sessionFile(directory, 'events-', '.jsonl'),
  };
  const file = files[command];
  if (!file) throw new Error(`No offline diagnostic file exists for ${command}.`);
  const full = path.join(directory, file);
  if (command === 'events') {
    const limit = Math.min(Math.max(Number(option('--last', 100)), 1), 500);
    const lines = fs.readFileSync(full, 'utf8').trim().split('\n').filter(Boolean).slice(-limit);
    return { events: lines.map((line) => JSON.parse(line)) };
  }
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function request(socketPath, token, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Diagnostic control plane timed out.')); }, 2000);
    socket.on('connect', () => socket.end(`${JSON.stringify({ token, command, limit: option('--last', 100) })}\n`));
    socket.on('data', (chunk) => { output += chunk.toString('utf8'); });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) return usage();
  const command = process.argv.find((arg) => ['capabilities', 'build-info', 'snapshot', 'events'].includes(arg));
  if (!command) { usage(); process.exitCode = 2; return; }
    const directory = defaultDir();
  try {
    const tokenFile = activeSupervisorTokenFile(directory);
    if (!tokenFile) throw new Error('No active diagnostic supervisor token exists.');
    const token = fs.readFileSync(path.join(directory, tokenFile), 'utf8').trim();
    const socketFile = tokenFile.endsWith('.token')
      ? `${tokenFile.slice(0, -'.token'.length)}.sock`
      : 'supervisor.sock';
    print(await request(path.join(directory, socketFile), token, command));
  } catch (error) {
    try { print(offline(directory, command)); }
    catch { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}

main();
