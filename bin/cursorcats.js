#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkgRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(pkgRoot, 'out', 'main', 'index.js');

function envWithQuietSdkLogs(env) {
  if (String(env.CURSORCATS_AGENT_LOG_VERBOSE || '').trim() === '1') {
    return env;
  }
  return {
    ...env,
    RUST_LOG: 'error',
    LOG_LEVEL: 'warn',
    OTEL_LOG_LEVEL: 'error',
    DEBUG: '',
  };
}

/**
 * The Cursor SDK uses a structured logger we cannot configure via env vars; every
 * line starts with `HH:MM:SS.mmm <LEVEL> ` (DEBUG/INFO/WARN/TRACE) and usually has
 * a `meta=` or `cursorMcp:` payload. App output uses `console.*` (e.g.
 * `[cursorcats] ...`), which never matches this shape, so this filter only drops
 * SDK noise. Set CURSORCATS_AGENT_LOG_VERBOSE=1 to keep everything.
 */
const SDK_LOG_LINE_RE = /^\d{1,2}:\d{2}:\d{2}\.\d{3}\s+(DEBUG|TRACE|INFO|WARN|ERROR)\s+/;

function shouldFilterSdkLogLine(line) {
  if (String(process.env.CURSORCATS_AGENT_LOG_VERBOSE || '').trim() === '1') {
    return false;
  }
  if (SDK_LOG_LINE_RE.test(line)) return true;
  return line.includes('cursorMcp:') || line.includes('mcp_http_exchange') || line.includes('mcp_oauth_');
}

function pipeFilteredLines(stream, target) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!shouldFilterSdkLogLine(line)) {
        target.write(`${line}\n`);
      }
    }
  });
  stream.on('end', () => {
    if (pending && !shouldFilterSdkLogLine(pending)) {
      target.write(pending);
    }
  });
}

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

if (process.argv[2] === 'remove-hooks') {
  try {
    const { removeHooks } = require(path.join(pkgRoot, 'scripts', 'add-hooks.js'));
    removeHooks(pkgRoot, { log: console.log.bind(console) });
  } catch (e) {
    console.error('[cursorcats] remove-hooks failed:', (e && e.message) || e);
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

const cyan = '\x1b[36m';
const reset = '\x1b[0m';
const yellow = '\x1b[33m';

console.log(`
${cyan}   |\\__/,|   (\`\\${reset}
${cyan} _.|o o  |_   ) )${reset}
${cyan}-(((---(((--------${reset}
${yellow}   Cursor Cats${reset}
${cyan}------------------${reset}

Use Cmd+Shift+C to launch a Cursor Cat.
`);

const child = spawn(electron, [mainEntry, ...process.argv.slice(2)], {
  cwd: pkgRoot,
  stdio: ['inherit', 'pipe', 'pipe'],
  env: envWithQuietSdkLogs(process.env),
});

pipeFilteredLines(child.stdout, process.stdout);
pipeFilteredLines(child.stderr, process.stderr);

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
