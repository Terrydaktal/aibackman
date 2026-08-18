#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { secureAndPruneDiagnosticFiles } = require('../electron/diagnostics/runtime.cjs');

function rootsFromArguments(argv) {
  const roots = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--root' || !argv[index + 1]) throw new Error('Usage: secure-diagnostics.cjs [--root USER_DATA_PATH]...');
    roots.push(path.resolve(argv[index + 1]));
    index += 1;
  }
  if (roots.length > 0) return [...new Set(roots)];
  const configRoot = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), '.config');
  return [path.join(configRoot, 'aibackman'), path.join(configRoot, 'chatgpt')]
    .filter((root) => fs.existsSync(root));
}

try {
  const results = rootsFromArguments(process.argv.slice(2)).map((root) => ({
    root,
    debugDirectory: path.join(root, 'debug'),
    ...secureAndPruneDiagnosticFiles(path.join(root, 'debug')),
  }));
  console.log(JSON.stringify({ results }, null, 2));
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
