'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const runtimeEntitlements = path.join(repoRoot, 'packaging', 'mac', 'entitlements.hermes-runtime.plist');

const MACHO_MAGICS = new Set([
  0xfeedface,
  0xfeedfacf,
  0xcafebabe,
  0xcafebabf,
  0xcefaedfe,
  0xcffaedfe,
  0xbebafeca,
  0xbfbafeca,
]);

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0 && opts.check !== false) {
    throw new Error(`${[command, ...args].join(' ')} failed:\n${res.stdout || ''}\n${res.stderr || ''}`);
  }
  return res;
}

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) !== 4) return false;
    return MACHO_MAGICS.has(buf.readUInt32BE(0)) || MACHO_MAGICS.has(buf.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function walkMachOFiles(root) {
  const out = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && isMachO(full)) {
        out.push(full);
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return out.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function findSigningIdentity() {
  const configured = String(process.env.CSC_NAME || process.env.MACOS_CODESIGN_IDENTITY || '').trim();
  if (configured) return configured;

  const res = run('security', ['find-identity', '-v', '-p', 'codesigning'], { check: false });
  const lines = String(res.stdout || '').split(/\r?\n/);
  const identities = lines
    .map((line) => {
      const match = line.match(/"([^"]+)"/);
      return match ? match[1] : '';
    })
    .filter(Boolean);
  return identities.find((identity) => identity.startsWith('Developer ID Application:')) ||
    '-';
}

function signFile(file, identity) {
  const args = ['--force', '--options', 'runtime', '--entitlements', runtimeEntitlements, '--sign', identity];
  if (identity.startsWith('Developer ID Application:')) {
    args.push('--timestamp');
  } else {
    args.push('--timestamp=none');
  }
  args.push(file);
  run('codesign', args, { stdio: 'inherit' });
}

module.exports = async function signHermesRuntime(context) {
  if (!context || context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const runtimeRoot = path.join(context.appOutDir, appName, 'Contents', 'Resources', 'hermes-runtime');
  if (!fs.existsSync(runtimeRoot)) return;

  const identity = findSigningIdentity();
  const files = walkMachOFiles(runtimeRoot);
  for (const file of files) signFile(file, identity);
  console.log(`[agent-ui] signed ${files.length} Hermes runtime Mach-O files with ${identity}`);
};
