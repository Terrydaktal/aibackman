const path = require('path');
const { writeBuildInfo } = require('../electron/diagnostics/build-info.cjs');

const modeIndex = process.argv.indexOf('--mode');
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : process.env.AIBACKMAN_BUILD_MODE || 'release-minimal';
const info = writeBuildInfo({ root: path.resolve(__dirname, '..'), mode });
console.log(`Wrote ${info.build_mode} build identity ${info.build_id} to dist/build-info.json`);
