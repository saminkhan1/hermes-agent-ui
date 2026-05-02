#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkgRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(pkgRoot, 'out', 'main', 'index.js');

if (!fs.existsSync(mainEntry)) {
  console.error(
    `[agent-ui] Missing built main process at ${mainEntry}. Run "npm run build" in the package root (or reinstall so the "prepare" script can run).`
  );
  process.exit(1);
}

const electron = require('electron');

const cyan = '\x1b[36m';
const reset = '\x1b[0m';
const yellow = '\x1b[33m';

console.log(`
${cyan}   |\\__/,|   (\`\\${reset}
${cyan} _.|o o  |_   ) )${reset}
${cyan}-(((---(((--------${reset}
${yellow}   agent-UI${reset}
${cyan}------------------${reset}

Use Cmd+Shift+C to open the session launcher.
`);

const child = spawn(electron, [mainEntry, ...process.argv.slice(2)], {
  cwd: pkgRoot,
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (err) => {
  console.error('[agent-ui] Failed to start Electron:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
