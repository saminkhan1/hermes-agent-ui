'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function realUserHomeDir() {
  try {
    const userHome = os.userInfo().homedir;
    if (userHome) return userHome;
  } catch {
    // Fall through to Node's HOME-aware default.
  }
  return os.homedir();
}

const repoRoot = path.resolve(__dirname, '..');
const outRoot = path.join(repoRoot, 'build', 'hermes-runtime');
const source = path.resolve(
  process.env.HERMES_BUNDLE_SOURCE ||
  path.join(realUserHomeDir(), 'Documents', 'jarvis', '.aura', 'hermes-agent')
);

const ignoredNames = new Set([
  '.git',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '__pycache__',
  'venv',
  '.venv',
  'node_modules',
  'sessions',
  'logs',
  'cache',
]);

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyTree(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (ignoredNames.has(path.basename(src))) return;
    ensureDir(dst);
    for (const entry of fs.readdirSync(src)) {
      copyTree(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }
  if (!st.isFile()) return;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function gitHead(dir) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : 'unknown';
}

function runChecked(command, args, opts = {}) {
  const res = spawnSync(command, args, {
    cwd: opts.cwd || repoRoot,
    env: opts.env || process.env,
    encoding: 'utf8',
    stdio: opts.stdio || 'inherit',
  });
  if (res.status !== 0) {
    const rendered = [command, ...args].join(' ');
    throw new Error(`${rendered} failed with status ${res.status}`);
  }
}

function runtimePython(venvDir) {
  return path.join(venvDir, 'bin', 'python3');
}

function createVenv(venvDir) {
  if (fs.existsSync(runtimePython(venvDir))) return;
  if (spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0) {
    runChecked('uv', ['venv', venvDir]);
    return;
  }
  runChecked('/usr/bin/python3', ['-m', 'venv', venvDir]);
  runChecked(runtimePython(venvDir), ['-m', 'pip', 'install', '--upgrade', 'pip']);
}

function installRuntimeDeps(venvDir) {
  const py = runtimePython(venvDir);
  const packageSpec = `${path.join(outRoot, 'hermes-agent')}[voice,messaging]`;
  if (spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0) {
    runChecked('uv', ['pip', 'install', '--python', py, packageSpec]);
    return;
  }
  runChecked(py, ['-m', 'pip', 'install', packageSpec]);
}

function verifyRuntimeDeps(venvDir) {
  runChecked(runtimePython(venvDir), ['-c', [
    'import importlib.util',
    'missing = [name for name in ("aiohttp", "yaml", "openai", "rich", "sounddevice", "numpy", "faster_whisper") if importlib.util.find_spec(name) is None]',
    'raise SystemExit("missing runtime deps: " + ", ".join(missing) if missing else 0)',
  ].join('\n')]);
}

function buildEmbeddedVenv() {
  const venvDir = path.join(outRoot, 'venv');
  createVenv(venvDir);
  installRuntimeDeps(venvDir);
  verifyRuntimeDeps(venvDir);
}

function writeLauncher() {
  const binDir = path.join(outRoot, 'bin');
  ensureDir(binDir);
  const launcher = path.join(binDir, 'hermes');
  const content = `#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/hermes-agent"
EMBEDDED_VENV_DIR="$ROOT_DIR/venv"
USER_VENV_DIR="$HOME/.agent-ui/hermes-runtime-venv"
VENV_DIR="\${HERMES_RUNTIME_VENV:-}"
if [[ -z "$VENV_DIR" ]]; then
  if [[ -x "$EMBEDDED_VENV_DIR/bin/python3" ]]; then
    VENV_DIR="$EMBEDDED_VENV_DIR"
  else
    VENV_DIR="$USER_VENV_DIR"
  fi
fi
PY="$VENV_DIR/bin/python3"

install_runtime() {
  local package_spec="$SRC_DIR[voice,messaging]"
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$PY" "$package_spec"
  else
    "$PY" -m pip install "$package_spec"
  fi
}

runtime_deps_available() {
  "$PY" - <<'PY' >/dev/null 2>&1
import importlib.util
import sys

missing = [
    name for name in ("aiohttp", "yaml", "openai", "rich", "sounddevice", "numpy", "faster_whisper")
    if importlib.util.find_spec(name) is None
]
sys.exit(1 if missing else 0)
PY
}

if [[ ! -x "$PY" ]]; then
  mkdir -p "$(dirname "$VENV_DIR")"
  if command -v uv >/dev/null 2>&1; then
    uv venv "$VENV_DIR"
  else
    /usr/bin/python3 -m venv "$VENV_DIR"
    "$PY" -m pip install --upgrade pip
  fi
  install_runtime
elif ! runtime_deps_available; then
  install_runtime
fi
export PYTHONPATH="$SRC_DIR\${PYTHONPATH:+:$PYTHONPATH}"
exec "$PY" -m hermes_cli.main "$@"
`;
  fs.writeFileSync(launcher, content, { mode: 0o755 });
}

if (!fs.existsSync(source)) {
  console.error(`[agent-ui] Hermes source not found: ${source}`);
  console.error('[agent-ui] Set HERMES_BUNDLE_SOURCE=/path/to/hermes-agent or install the local AURA checkout.');
  process.exit(1);
}

rmrf(outRoot);
ensureDir(outRoot);
copyTree(source, path.join(outRoot, 'hermes-agent'));
buildEmbeddedVenv();
writeLauncher();
fs.writeFileSync(path.join(outRoot, 'MANIFEST.json'), JSON.stringify({
  source,
  gitHead: gitHead(source),
  builtAt: new Date().toISOString(),
}, null, 2));
console.log(`[agent-ui] Bundled Hermes runtime from ${source}`);
console.log(`[agent-ui] Wrote ${outRoot}`);
