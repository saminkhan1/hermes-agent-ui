#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION_START_CMD = 'node ./hooks/cursorcats/sessionStart.js';
const SESSION_END_CMD = 'node ./hooks/cursorcats/sessionEnd.js';

/**
 * @param {unknown} val
 * @returns {{ command: string }[]}
 */
function normalizeHookList(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.filter((x) => x && typeof x.command === 'string');
  if (typeof val === 'object' && typeof val.command === 'string') return [val];
  return [];
}

/**
 * @param {{ command: string }[]} entries
 * @param {'start' | 'end'} kind
 */
function stripCursorcatsEntries(entries, kind) {
  const needle =
    kind === 'start' ? 'hooks/cursorcats/sessionStart.js' : 'hooks/cursorcats/sessionEnd.js';
  return entries.filter((e) => {
    const c = e.command;
    const norm = c.split(path.sep).join('/');
    if (c.includes(needle)) return false;
    if (norm.includes('plugins/local/cursorcats')) return false;
    return true;
  });
}

/**
 * @param {{ command: string }[]} entries
 * @param {string} cmd
 */
function hasExactCommand(entries, cmd) {
  return entries.some((e) => e.command === cmd);
}

/**
 * @param {string} root
 * @param {(msg: string, ...rest: unknown[]) => void} log
 */
function copyBundledHookScripts(root, log) {
  const srcDir = path.join(root, 'assets', 'cursor-plugin', 'hooks');
  const destDir = path.join(os.homedir(), '.cursor', 'hooks', 'cursorcats');
  const files = ['notify.js', 'sessionStart.js', 'sessionEnd.js'];
  for (const name of files) {
    const from = path.join(srcDir, name);
    if (!fs.existsSync(from)) {
      throw new Error(`Missing bundled hook file: ${from}`);
    }
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of files) {
    fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
  }
  log(`Wrote hook scripts under ${destDir}`);
}

/**
 * @param {string} hooksJsonPath
 * @returns {Record<string, unknown>}
 */
function readHooksJson(hooksJsonPath) {
  if (!fs.existsSync(hooksJsonPath)) {
    return { version: 1, hooks: {} };
  }
  const raw = fs.readFileSync(hooksJsonPath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') {
    return { version: 1, hooks: {} };
  }
  return data;
}

/**
 * @param {string} pkgRoot
 * @param {{ log?: (msg: string, ...rest: unknown[]) => void }} [opts]
 */
function addHooks(pkgRoot, opts = {}) {
  const log = opts.log || console.log.bind(console);
  copyBundledHookScripts(pkgRoot, log);

  const cursorDir = path.join(os.homedir(), '.cursor');
  fs.mkdirSync(cursorDir, { recursive: true });

  const hooksJsonPath = path.join(cursorDir, 'hooks.json');
  const data = readHooksJson(hooksJsonPath);
  const hooks = data.hooks && typeof data.hooks === 'object' ? { ...data.hooks } : {};

  let ss = stripCursorcatsEntries(normalizeHookList(hooks.sessionStart), 'start');
  let se = stripCursorcatsEntries(normalizeHookList(hooks.sessionEnd), 'end');

  if (!hasExactCommand(ss, SESSION_START_CMD)) {
    ss = [...ss, { command: SESSION_START_CMD }];
  }
  if (!hasExactCommand(se, SESSION_END_CMD)) {
    se = [...se, { command: SESSION_END_CMD }];
  }

  const out = {
    ...data,
    version: typeof data.version === 'number' ? data.version : 1,
    hooks: {
      ...hooks,
      sessionStart: ss,
      sessionEnd: se,
    },
  };

  fs.writeFileSync(hooksJsonPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  log(`Updated ${hooksJsonPath}`);
  log('Reload the Cursor window (Command Palette: Developer: Reload Window) so hook changes take effect.');
}

module.exports = { addHooks };

if (require.main === module) {
  try {
    addHooks(path.resolve(__dirname, '..'), { log: console.log.bind(console) });
  } catch (e) {
    console.error('[cursorcats] add-hooks failed:', (e && e.message) || e);
    process.exit(1);
  }
}
