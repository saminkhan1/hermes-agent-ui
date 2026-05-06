'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
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
const buildVenvDir = path.join(repoRoot, 'build', 'hermes-runtime-build-venv');
const pythonRoot = path.join(outRoot, 'python');
const hermesReleaseTag = 'v2026.4.30';
const hermesReleaseUrl = 'https://github.com/NousResearch/hermes-agent/releases/tag/v2026.4.30';
const platformOverlayRoot = path.join(repoRoot, 'vendor', 'hermes-platforms');
const defaultHermesSource = path.join(realUserHomeDir(), 'Documents', 'hermes', 'hermes-agent');
const source = path.resolve(
  process.env.HERMES_BUNDLE_SOURCE ||
  defaultHermesSource
);
const hermesSourcePolicy = String(process.env.HERMES_BUNDLE_SOURCE_POLICY || 'local').trim().toLowerCase();
if (!['local', 'release'].includes(hermesSourcePolicy)) {
  throw new Error(`HERMES_BUNDLE_SOURCE_POLICY must be local or release, got ${hermesSourcePolicy}`);
}
const requireReleaseSource = hermesSourcePolicy === 'release' ||
  String(process.env.HERMES_BUNDLE_REQUIRE_RELEASE || '').trim() === '1';

const ignoredNames = new Set([
  '.git',
  '.github',
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
  'build',
  'dist',
]);

const pythonCopyIgnoredNames = new Set([
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'test',
  'tests',
]);

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyTree(src, dst, opts = {}) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    if (opts.preserveSymlinks) {
      const link = fs.readlinkSync(src);
      ensureDir(path.dirname(dst));
      fs.symlinkSync(link, dst);
      return;
    }
    copyTree(fs.realpathSync(src), dst, opts);
    return;
  }
  if (st.isDirectory()) {
    const ignored = opts.ignoredNames || ignoredNames;
    if (ignored.has(path.basename(src))) return;
    ensureDir(dst);
    for (const entry of fs.readdirSync(src)) {
      copyTree(path.join(src, entry), path.join(dst, entry), opts);
    }
    return;
  }
  if (!st.isFile()) return;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, st.mode & 0o777);
}

function treeSha256(root) {
  const hash = crypto.createHash('sha256');
  const normalizedRoot = path.resolve(root);

  function walk(dir) {
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (ignoredNames.has(path.basename(full))) continue;
      const st = fs.lstatSync(full);
      const rel = path.relative(normalizedRoot, full).split(path.sep).join('/');
      if (st.isSymbolicLink()) {
        hash.update(`L\0${rel}\0${fs.readlinkSync(full)}\0`);
        continue;
      }
      if (st.isDirectory()) {
        hash.update(`D\0${rel}\0`);
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      hash.update(`F\0${rel}\0${st.mode & 0o777}\0`);
      hash.update(fs.readFileSync(full));
      hash.update('\0');
    }
  }

  walk(normalizedRoot);
  return hash.digest('hex');
}

function vendoredPlatformOverlays() {
  if (!fs.existsSync(platformOverlayRoot)) return [];
  const overlays = [];
  for (const entry of fs.readdirSync(platformOverlayRoot).sort()) {
    const src = path.join(platformOverlayRoot, entry);
    if (!fs.lstatSync(src).isDirectory()) continue;
    const manifest = path.join(src, 'plugin.yaml');
    const init = path.join(src, '__init__.py');
    if (!fs.existsSync(manifest) || !fs.existsSync(init)) {
      throw new Error(`Hermes platform overlay ${entry} must contain plugin.yaml and __init__.py`);
    }
    overlays.push({
      name: entry,
      source: src,
      sha256: treeSha256(src),
    });
  }
  return overlays;
}

function copyVendoredPlatformOverlays(hermesRoot) {
  const overlays = vendoredPlatformOverlays();
  const copied = [];
  for (const overlay of overlays) {
    const dst = path.join(hermesRoot, 'plugins', 'platforms', overlay.name);
    if (fs.existsSync(dst)) {
      const manifest = path.join(dst, 'plugin.yaml');
      const init = path.join(dst, '__init__.py');
      if (!fs.existsSync(manifest) || !fs.existsSync(init)) {
        throw new Error(`Hermes source already contains plugins/platforms/${overlay.name}, but it is missing plugin.yaml or __init__.py.`);
      }
      copied.push({
        name: overlay.name,
        source: 'hermes-source',
        sourcePath: path.relative(outRoot, dst),
        target: path.relative(outRoot, dst),
        sha256: treeSha256(dst),
        vendoredSha256: overlay.sha256,
        action: 'kept-source',
      });
      continue;
    }
    copyTree(overlay.source, dst);
    copied.push({
      ...overlay,
      target: path.relative(outRoot, dst),
      action: 'copied-vendored',
    });
  }
  return copied;
}

function gitHead(dir) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : 'unknown';
}

function gitOutput(dir, args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : '';
}

function verifyHermesSource(dir) {
  const head = gitHead(dir);
  const releaseHead = gitOutput(dir, ['rev-parse', `${hermesReleaseTag}^{commit}`]);
  const dirty = gitOutput(dir, ['status', '--porcelain']);
  if (head === 'unknown') {
    throw new Error(`Hermes source must be a git checkout: ${dir}`);
  }
  if (requireReleaseSource && !releaseHead) {
    throw new Error(`Hermes source must contain release tag ${hermesReleaseTag}: ${dir}`);
  }
  if (requireReleaseSource && head !== releaseHead) {
    throw new Error(`Hermes source must be checked out at ${hermesReleaseTag} (${releaseHead}); got ${head}. Set HERMES_BUNDLE_SOURCE to a clean release checkout.`);
  }
  if (requireReleaseSource && dirty) {
    throw new Error(`Hermes source must be clean for release bundling:\n${dirty}`);
  }
  if (!requireReleaseSource && (dirty || (releaseHead && head !== releaseHead) || !releaseHead)) {
    console.warn(`[agent-ui] Bundling local Hermes source from ${dir}; provenance will be recorded in MANIFEST.json.`);
  }
  return {
    head,
    releaseHead: releaseHead || 'unknown',
    dirty: !!dirty,
    gitStatus: dirty ? dirty.split('\n').filter(Boolean) : [],
    sourcePolicy: requireReleaseSource ? 'release' : 'local',
    isReleaseHead: releaseHead ? head === releaseHead : false,
  };
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

function createBuildVenv(venvDir) {
  if (fs.existsSync(runtimePython(venvDir))) return;
  const requestedPython = String(process.env.HERMES_BUNDLE_PYTHON || '3.13').trim();
  if (spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0) {
    runChecked('uv', ['venv', '--python', requestedPython, '--managed-python', '--link-mode', 'copy', venvDir]);
    return;
  }
  throw new Error('uv is required to create the bundled, redistributable Python runtime. Install uv for release builds.');
}

function installRuntimeDeps(venvDir) {
  const py = runtimePython(venvDir);
  const packageSpec = `${path.join(outRoot, 'hermes-agent')}[voice,messaging]`;
  if (spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0) {
    runChecked('uv', ['pip', 'install', '--python', py, '--link-mode', 'copy', '--compile-bytecode', packageSpec]);
    return;
  }
  throw new Error('uv is required to pre-resolve Hermes runtime dependencies for the distributable.');
}

function verifyRuntimeDeps(venvDir) {
  runChecked(runtimePython(venvDir), ['-c', [
    'import importlib.util',
    'missing = [name for name in ("aiohttp", "yaml", "openai", "rich", "sounddevice", "numpy", "faster_whisper") if importlib.util.find_spec(name) is None]',
    'raise SystemExit("missing runtime deps: " + ", ".join(missing) if missing else 0)',
  ].join('\n')]);
}

function embeddedVoiceRuntimeInfo(python) {
  const code = [
    'import json, os, pathlib, sounddevice',
    'root = pathlib.Path(os.environ["AGENT_UI_BUNDLED_PYTHON_ROOT"]).resolve()',
    'lib = pathlib.Path(str(getattr(sounddevice, "_libname", ""))).resolve()',
    'inside = str(lib).startswith(str(root) + os.sep)',
    'ok = lib.name == "libportaudio.dylib" and lib.exists() and inside',
    'print(json.dumps({"ok": ok, "sounddevicePortAudio": str(lib), "insidePythonRoot": inside}))',
    'raise SystemExit(0 if ok else 1)',
  ].join('\n');
  const res = spawnSync(python, ['-c', code], {
    cwd: repoRoot,
    env: { ...process.env, AGENT_UI_BUNDLED_PYTHON_ROOT: pythonRoot },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`bundled voice runtime is missing bundled PortAudio:\n${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout);
}

function pythonInfo(python) {
  const code = [
    'import json, site, sys, sysconfig',
    'print(json.dumps({',
    '  "basePrefix": sys.base_prefix,',
    '  "executable": sys.executable,',
    '  "major": sys.version_info.major,',
    '  "minor": sys.version_info.minor,',
    '  "micro": sys.version_info.micro,',
    '  "purelib": sysconfig.get_path("purelib"),',
    '  "sitePackages": site.getsitepackages(),',
    '}))',
  ].join('\n');
  const res = spawnSync(python, ['-c', code], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`failed to inspect Python runtime: ${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout);
}

function verifyNoEscapingSymlinks(root) {
  const escaped = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        if (path.isAbsolute(target) && !path.resolve(target).startsWith(path.resolve(root) + path.sep)) {
          escaped.push(`${path.relative(root, full)} -> ${target}`);
        }
        continue;
      }
      if (st.isDirectory()) walk(full);
    }
  }
  walk(root);
  if (escaped.length) {
    throw new Error(`bundled runtime contains absolute symlinks that escape the bundle:\n${escaped.join('\n')}`);
  }
}

function buildEmbeddedPython() {
  rmrf(buildVenvDir);
  createBuildVenv(buildVenvDir);
  installRuntimeDeps(buildVenvDir);
  verifyRuntimeDeps(buildVenvDir);

  const py = runtimePython(buildVenvDir);
  const info = pythonInfo(py);
  if (info.major < 3 || (info.major === 3 && info.minor < 11)) {
    throw new Error(`Hermes runtime requires Python >= 3.11; got ${info.major}.${info.minor}.${info.micro}`);
  }
  if (!info.basePrefix || !fs.existsSync(info.basePrefix)) {
    throw new Error(`Cannot locate redistributable Python base prefix: ${info.basePrefix || '(empty)'}`);
  }

  copyTree(info.basePrefix, pythonRoot, { ignoredNames: pythonCopyIgnoredNames, preserveSymlinks: true });
  const pythonVersionDir = `python${info.major}.${info.minor}`;
  const embeddedSitePackages = path.join(pythonRoot, 'lib', pythonVersionDir, 'site-packages');
  rmrf(embeddedSitePackages);
  copyTree(info.purelib, embeddedSitePackages, { ignoredNames: pythonCopyIgnoredNames, preserveSymlinks: true });
  verifyNoEscapingSymlinks(pythonRoot);
  runChecked(path.join(pythonRoot, 'bin', 'python3'), ['-c', [
    'import importlib.util, json, sys',
    'missing = [name for name in ("aiohttp", "yaml", "openai", "rich", "sounddevice", "numpy", "faster_whisper") if importlib.util.find_spec(name) is None]',
    'print(json.dumps({"ok": not missing, "missing": missing, "version": sys.version}))',
    'raise SystemExit(1 if missing else 0)',
  ].join('\n')]);
  const voiceRuntime = embeddedVoiceRuntimeInfo(path.join(pythonRoot, 'bin', 'python3'));
  rmrf(buildVenvDir);
  return {
    version: `${info.major}.${info.minor}.${info.micro}`,
    basePrefix: info.basePrefix,
    sitePackages: path.relative(outRoot, embeddedSitePackages),
    voiceRuntime,
  };
}

function writeLauncher() {
  const binDir = path.join(outRoot, 'bin');
  ensureDir(binDir);
  const launcher = path.join(binDir, 'hermes');
  const content = `#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/hermes-agent"
PY="$ROOT_DIR/python/bin/python3"
if [[ ! -x "$PY" ]]; then
  echo "Bundled Hermes Python runtime is missing at $PY. Rebuild the app with npm run bundle:hermes." >&2
  exit 127
fi
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONNOUSERSITE=1
export PYTHONPATH="$SRC_DIR"
exec "$PY" -m hermes_cli.main "$@"
`;
  fs.writeFileSync(launcher, content, { mode: 0o755 });
}

if (!fs.existsSync(source)) {
  console.error(`[agent-ui] Hermes source not found: ${source}`);
  console.error(`[agent-ui] Set HERMES_BUNDLE_SOURCE=/path/to/hermes-agent or install Hermes at ${defaultHermesSource}.`);
  process.exit(1);
}

const hermesSourceState = verifyHermesSource(source);
rmrf(outRoot);
ensureDir(outRoot);
const hermesRoot = path.join(outRoot, 'hermes-agent');
copyTree(source, hermesRoot);
const hermesPlatformOverlays = copyVendoredPlatformOverlays(hermesRoot);
const bundledHermesAgentTreeSha256 = treeSha256(hermesRoot);
const embeddedPython = buildEmbeddedPython();
writeLauncher();
fs.writeFileSync(path.join(outRoot, 'MANIFEST.json'), JSON.stringify({
  version: require(path.join(repoRoot, 'package.json')).version,
  source,
  hermesSourcePolicy: hermesSourceState.sourcePolicy,
  hermesReleaseTag,
  hermesReleaseUrl,
  gitHead: hermesSourceState.head,
  hermesReleaseGitHead: hermesSourceState.releaseHead,
  hermesSourceDirty: hermesSourceState.dirty,
  hermesSourceGitStatus: hermesSourceState.gitStatus,
  hermesSourceIsReleaseHead: hermesSourceState.isReleaseHead,
  bundledHermesAgentTreeSha256,
  hermesPlatformOverlays,
  appGitHead: gitHead(repoRoot),
  python: embeddedPython,
  builtAt: new Date().toISOString(),
}, null, 2));
console.log(`[agent-ui] Bundled Hermes runtime from ${source}`);
if (hermesPlatformOverlays.length) {
  console.log(`[agent-ui] Added Hermes platform overlays: ${hermesPlatformOverlays.map((overlay) => overlay.name).join(', ')}`);
}
console.log(`[agent-ui] Wrote ${outRoot}`);
