#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkgRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(pkgRoot, 'out', 'main', 'index.js');

if (process.argv[2] === 'add-hooks') {
  try {
    const { addHooks } = require(path.join(pkgRoot, 'scripts', 'add-hooks.js'));
    addHooks(pkgRoot, { log: console.log.bind(console) });
  } catch (e) {
    console.error('[cursorcats] add-hooks failed:', (e && e.message) || e);
    process.exit(1);
  }
  process.exit(0);
}

if (!process.env.CURSOR_API_KEY) {
  console.error(
    '[cursorcats] Warning: CURSOR_API_KEY is not set. New Cursor Cat agents will not run; set it before launching if you use that feature.'
  );
}

if (!fs.existsSync(mainEntry)) {
  console.error(
    `[cursorcats] Missing built main process at ${mainEntry}. Run "npm run build" in the package root (or reinstall so the "prepare" script can run).`
  );
  process.exit(1);
}

const electron = require('electron');

const child = spawn(electron, [mainEntry, ...process.argv.slice(2)], {
  cwd: pkgRoot,
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (err) => {
  console.error('[cursorcats] Failed to start Electron:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
