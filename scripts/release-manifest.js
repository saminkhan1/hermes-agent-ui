'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const expectedHermesReleaseTag = 'v2026.4.30';
const expectedHermesReleaseUrl = 'https://github.com/NousResearch/hermes-agent/releases/tag/v2026.4.30';
const runtimeTreeIgnoredNames = new Set([
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
const legacyRequireSigned = String(process.env.RELEASE_VERIFY_REQUIRE_SIGNED || '').trim() === '1';
const requestedSigningMode = String(
  process.env.RELEASE_VERIFY_SIGNING_MODE ||
  process.env.RELEASE_VERIFY_MODE ||
  (legacyRequireSigned ? 'developer-id' : 'bootstrap')
).trim().toLowerCase();
const signingMode = requestedSigningMode === 'developer-id' ? 'developer-id' : requestedSigningMode;
const requestedAppMode = String(
  process.env.RELEASE_VERIFY_APP_MODE ||
  process.env.AGENT_UI_RELEASE_MODE ||
  process.env.AGENT_UI_RELEASE_FLAVOR ||
  'all'
).trim().toLowerCase();

if (!['bootstrap', 'developer-id'].includes(signingMode)) {
  console.error(`[agent-ui] RELEASE_VERIFY_SIGNING_MODE must be bootstrap or developer-id, got ${requestedSigningMode}`);
  process.exit(2);
}
if (!['all', 'connector', 'standalone'].includes(requestedAppMode)) {
  console.error(`[agent-ui] RELEASE_VERIFY_APP_MODE must be all, connector, or standalone, got ${requestedAppMode}`);
  process.exit(2);
}

const requireDeveloperId = signingMode === 'developer-id';

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonResult(file) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')), error: '' };
  } catch (error) {
    return {
      ok: false,
      data: {},
      error: String(error && error.message ? error.message : error),
    };
  }
}

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, {
    cwd: opts.cwd || repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs || 30000,
  });
  return {
    command: [command, ...args].join(' '),
    ok: res.status === 0,
    status: res.status,
    signal: res.signal || '',
    timedOut: res.error && res.error.code === 'ETIMEDOUT',
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || res.error || '').trim(),
  };
}

function gitHead(dir) {
  const res = run('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return res.ok ? res.stdout : 'unknown';
}

function gitStatus(dir) {
  const res = run('git', ['status', '--porcelain=v1'], { cwd: dir });
  return res.ok && res.stdout ? res.stdout.split('\n').filter(Boolean) : [];
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function treeSha256(root) {
  const hash = crypto.createHash('sha256');
  const normalizedRoot = path.resolve(root);

  function walk(dir) {
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (runtimeTreeIgnoredNames.has(path.basename(full))) continue;
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

function artifactAppMode(file) {
  const name = path.basename(String(file || '')).toLowerCase();
  if (name.includes('for-hermes')) return 'connector';
  if (name.includes('standalone')) return 'standalone';
  return 'unknown';
}

function artifactFiles(mode = signingMode, appMode = requestedAppMode) {
  if (!fs.existsSync(distDir)) return [];
  const files = fs.readdirSync(distDir)
    .filter((name) => /\.(dmg|zip)$/i.test(name))
    .map((name) => path.join(distDir, name))
    .sort();
  const signingFiles = mode === 'bootstrap'
    ? files.filter((file) => /-bootstrap\.(dmg|zip)$/i.test(path.basename(file)))
    : files.filter((file) => !/-bootstrap\.(dmg|zip)$/i.test(path.basename(file)));
  const scopedFiles = signingFiles.length ? signingFiles : files;
  const knownAppFiles = scopedFiles.filter((file) => artifactAppMode(file) !== 'unknown');
  if (appMode === 'all') return knownAppFiles;
  return knownAppFiles.filter((file) => artifactAppMode(file) === appMode);
}

function findApps(dir) {
  const apps = [];
  function walk(current, depth = 0) {
    if (depth > 5 || !fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory() && entry.endsWith('.app')) {
        apps.push(full);
      } else if (st.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  }
  walk(dir);
  return apps;
}

function parseSigningIdentity(codesignDisplay) {
  const text = `${codesignDisplay.stdout}\n${codesignDisplay.stderr}`;
  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1]);
  const team = (text.match(/^TeamIdentifier=(.+)$/m) || [])[1] || '';
  return {
    authorities,
    teamIdentifier: team,
    developerId: authorities.find((value) => value.startsWith('Developer ID Application:')) || '',
    adhoc: /^Signature=adhoc$/m.test(text),
  };
}

function isExecutable(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function appRuntimeState(appPath) {
  const hermesRuntimePath = path.join(appPath, 'Contents', 'Resources', 'hermes-runtime');
  const hermesAgent = path.join(hermesRuntimePath, 'hermes-agent');
  const hermesBin = path.join(hermesRuntimePath, 'bin', 'hermes');
  const pythonBin = path.join(hermesRuntimePath, 'python', 'bin', 'python3');
  const runtimeManifest = path.join(hermesRuntimePath, 'MANIFEST.json');
  const localDesktopPlugin = path.join(hermesRuntimePath, 'hermes-agent', 'plugins', 'platforms', 'local_desktop', 'adapter.py');
  const localDesktopManifest = path.join(hermesRuntimePath, 'hermes-agent', 'plugins', 'platforms', 'local_desktop', 'plugin.yaml');
  const runtimeManifestPresent = fs.existsSync(runtimeManifest);
  const runtimeManifestResult = runtimeManifestPresent
    ? readJsonResult(runtimeManifest)
    : { ok: false, data: {}, error: 'missing' };
  let hermesAgentTreeSha256 = '';
  let hermesAgentTreeSha256Error = '';
  if (fs.existsSync(hermesAgent)) {
    try {
      hermesAgentTreeSha256 = treeSha256(hermesAgent);
    } catch (error) {
      hermesAgentTreeSha256Error = String(error && error.message ? error.message : error);
    }
  }
  return {
    hermesRuntimePath,
    hermesRuntimeIncluded: fs.existsSync(hermesRuntimePath),
    hermesAgent,
    hermesAgentPresent: fs.existsSync(hermesAgent),
    hermesAgentTreeSha256,
    hermesAgentTreeSha256Error,
    hermesBin,
    hermesBinExecutable: isExecutable(hermesBin),
    pythonBin,
    pythonBinExecutable: isExecutable(pythonBin),
    runtimeManifest,
    runtimeManifestPresent,
    runtimeManifestValid: runtimeManifestPresent && runtimeManifestResult.ok,
    runtimeManifestError: runtimeManifestResult.error,
    runtimeManifestData: runtimeManifestResult.data,
    localDesktopPlugin,
    localDesktopPluginPresent: fs.existsSync(localDesktopPlugin),
    localDesktopManifest,
    localDesktopManifestPresent: fs.existsSync(localDesktopManifest),
  };
}

function appChecks(appPath) {
  const display = run('codesign', ['-dv', '--verbose=4', appPath]);
  const runtime = appRuntimeState(appPath);
  return {
    appPath,
    runtime,
    hermesVersion: runtime.hermesRuntimeIncluded && runtime.hermesBinExecutable
      ? run(runtime.hermesBin, ['version'], { timeoutMs: 20000 })
      : null,
    codesignDisplay: display,
    signingIdentity: parseSigningIdentity(display),
    codesignVerify: run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { timeoutMs: 60000 }),
    spctlExecute: run('spctl', ['-a', '-vv', '--type', 'execute', appPath], { timeoutMs: 20000 }),
    staplerValidate: run('xcrun', ['stapler', 'validate', appPath], { timeoutMs: 20000 }),
  };
}

function withTempDir(prefix, fn) {
  const base = fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function inspectZip(file) {
  return withTempDir('agent-ui-release-zip-', (dir) => {
    const extract = run('ditto', ['-x', '-k', file, dir], { timeoutMs: 120000 });
    const apps = extract.ok ? findApps(dir).map(appChecks) : [];
    return { extract, apps };
  });
}

function inspectDmg(file) {
  const base = fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, 'agent-ui-release-dmg-'));
  const mountPoint = path.join(dir, 'mnt');
  fs.mkdirSync(mountPoint);
  const attach = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, file], { timeoutMs: 120000 });
  const device = (attach.stdout.match(/^(\/dev\/disk\S+)/m) || [])[1] || '';
  let apps = [];
  let detach = null;
  let cleanup = null;
  if (attach.ok) {
    try {
      apps = findApps(mountPoint).map(appChecks);
    } finally {
      detach = run('hdiutil', ['detach', device || mountPoint], { timeoutMs: 30000 });
    }
  }
  if (!attach.ok || (detach && detach.ok)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      cleanup = { ok: true, dir };
    } catch (error) {
      cleanup = { ok: false, dir, error: String(error && error.message ? error.message : error) };
    }
  } else {
    cleanup = { ok: false, dir, error: 'DMG stayed mounted; temp directory left in place for manual detach.' };
  }
  return {
    attach,
    detach,
    cleanup,
    apps,
    spctlOpen: run('spctl', ['-a', '-vv', '--type', 'open', '--context', 'context:primary-signature', file], { timeoutMs: 20000 }),
    staplerValidate: run('xcrun', ['stapler', 'validate', file], { timeoutMs: 20000 }),
  };
}

function commandFailures(checks) {
  const failures = [];
  function visit(value, label) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.command === 'string' && value.ok === false) {
      failures.push(`${label}: ${value.command}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${label}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, label ? `${label}.${key}` : key);
  }
  visit(checks, '');
  return failures;
}

function commandFailure(check, label) {
  return check && check.ok === false ? [`${label}: ${check.command}`] : [];
}

function appRuntimeEnforcementFailures(app, appMode) {
  const runtime = app && app.runtime ? app.runtime : {};
  const runtimeIncluded = !!runtime.hermesRuntimeIncluded;
  if (appMode === 'connector' && runtimeIncluded) {
    return ['connector app must not include Contents/Resources/hermes-runtime'];
  }
  if (appMode === 'standalone' && !runtimeIncluded) {
    return ['standalone app must include Contents/Resources/hermes-runtime'];
  }
  if (appMode === 'standalone' && runtimeIncluded) {
    const failures = [];
    if (!runtime.hermesBinExecutable) failures.push('standalone Hermes runtime missing executable bin/hermes');
    if (!runtime.pythonBinExecutable) failures.push('standalone Hermes runtime missing executable python/bin/python3');
    if (!runtime.runtimeManifestPresent) failures.push('standalone Hermes runtime missing MANIFEST.json');
    if (runtime.runtimeManifestPresent && !runtime.runtimeManifestValid) failures.push(`standalone Hermes runtime has invalid MANIFEST.json: ${runtime.runtimeManifestError || 'parse failed'}`);
    if (!runtime.hermesAgentPresent) failures.push('standalone Hermes runtime missing hermes-agent tree');
    if (!runtime.localDesktopManifestPresent) failures.push('standalone Hermes runtime missing local_desktop plugin.yaml');
    if (!runtime.localDesktopPluginPresent) failures.push('standalone Hermes runtime missing local_desktop adapter.py');
    const embedded = runtime.runtimeManifestData || {};
    if (runtime.runtimeManifestValid) {
      if (!embedded.gitHead) failures.push('standalone Hermes runtime MANIFEST.json missing gitHead');
      if (!embedded.hermesReleaseGitHead) failures.push('standalone Hermes runtime MANIFEST.json missing hermesReleaseGitHead');
      if (!embedded.bundledHermesAgentTreeSha256) failures.push('standalone Hermes runtime MANIFEST.json missing bundledHermesAgentTreeSha256');
      if (runtime.hermesAgentTreeSha256Error) failures.push(`standalone Hermes runtime tree hash failed: ${runtime.hermesAgentTreeSha256Error}`);
      if (
        runtime.hermesAgentTreeSha256 &&
        embedded.bundledHermesAgentTreeSha256 &&
        runtime.hermesAgentTreeSha256 !== embedded.bundledHermesAgentTreeSha256
      ) {
        failures.push('standalone Hermes runtime MANIFEST.json tree hash does not match embedded hermes-agent');
      }
    }
    failures.push(...commandFailure(app.hermesVersion, 'app.hermesVersion'));
    return failures;
  }
  return [];
}

function hermesReleaseEnforcementFailures(app, appMode, mode) {
  if (appMode !== 'standalone' || mode !== 'developer-id') return [];
  const failures = [];
  const runtime = app && app.runtime ? app.runtime : {};
  const embedded = runtime.runtimeManifestData || {};
  if (!runtime.runtimeManifestValid) {
    failures.push('Developer ID standalone build must include a valid embedded Hermes runtime MANIFEST.json');
    return failures;
  }
  if ((embedded.hermesSourcePolicy || '') !== 'release') {
    failures.push('Developer ID standalone build must use HERMES_BUNDLE_SOURCE_POLICY=release');
  }
  if (embedded.hermesSourceDirty) {
    failures.push('Developer ID standalone build must not bundle a dirty Hermes source');
  }
  if (!embedded.hermesSourceIsReleaseHead) {
    failures.push('Developer ID standalone build must bundle the pinned Hermes release head');
  }
  if ((embedded.hermesReleaseTag || '') !== expectedHermesReleaseTag) {
    failures.push(`Developer ID standalone build must bundle Hermes release tag ${expectedHermesReleaseTag}`);
  }
  if ((embedded.hermesReleaseUrl || '') !== expectedHermesReleaseUrl) {
    failures.push(`Developer ID standalone build must record Hermes release URL ${expectedHermesReleaseUrl}`);
  }
  if (!embedded.gitHead || !embedded.hermesReleaseGitHead) {
    failures.push('Developer ID standalone build must record embedded Hermes gitHead and hermesReleaseGitHead');
  } else if (embedded.gitHead !== embedded.hermesReleaseGitHead) {
    failures.push('Developer ID standalone build must embed Hermes gitHead matching hermesReleaseGitHead');
  }
  return failures;
}

function appEnforcementFailures(app, mode, appMode) {
  const failures = [];
  failures.push(...commandFailure(app.codesignDisplay, 'app.codesignDisplay'));
  failures.push(...commandFailure(app.codesignVerify, 'app.codesignVerify'));
  failures.push(...appRuntimeEnforcementFailures(app, appMode));
  failures.push(...hermesReleaseEnforcementFailures(app, appMode, mode));
  const signing = app.signingIdentity || {};
  if (mode === 'developer-id') {
    if (!signing.developerId) failures.push('app is not signed with Developer ID Application');
    failures.push(...commandFailure(app.spctlExecute, 'app.spctlExecute'));
    failures.push(...commandFailure(app.staplerValidate, 'app.staplerValidate'));
  } else if (!signing.adhoc) {
    failures.push('app is not ad-hoc signed for bootstrap distribution');
  }
  return failures;
}

function enforcementFailures(kind, checks, mode, appMode) {
  const failures = [];
  if (kind === 'zip') {
    failures.push(...commandFailure(checks.extract, 'zip.extract'));
  }
  if (kind === 'dmg') {
    failures.push(...commandFailure(checks.attach, 'dmg.attach'));
    if (checks.detach) failures.push(...commandFailure(checks.detach, 'dmg.detach'));
    if (checks.cleanup && checks.cleanup.ok === false) failures.push(`dmg.cleanup: ${checks.cleanup.error || 'failed'}`);
    if (mode === 'developer-id') {
      failures.push(...commandFailure(checks.spctlOpen, 'dmg.spctlOpen'));
      failures.push(...commandFailure(checks.staplerValidate, 'dmg.staplerValidate'));
    }
  }
  if (!checks.apps || checks.apps.length === 0) {
    failures.push('artifact does not contain an agent-UI app bundle');
  }
  for (const app of checks.apps || []) {
    failures.push(...appEnforcementFailures(app, mode, appMode).map((failure) => `${path.basename(app.appPath)}: ${failure}`));
  }
  return failures;
}

function notarizationStatus(kind, checks, mode) {
  if (mode === 'bootstrap') return 'not_applicable_bootstrap';
  const artifactStapler = checks && checks.staplerValidate;
  if (artifactStapler && artifactStapler.ok) return `${kind}_stapled`;
  const appStapled = (checks.apps || []).some((app) => app.staplerValidate && app.staplerValidate.ok);
  return appStapled ? 'app_stapled' : 'stapler_validation_failed';
}

function standaloneRuntimeApp(checks) {
  return (checks.apps || []).find((app) => app.runtime && app.runtime.hermesRuntimeIncluded) || null;
}

function main() {
  const pkg = readJson(path.join(repoRoot, 'package.json'), {});
  const buildHermesManifest = readJson(path.join(repoRoot, 'build', 'hermes-runtime', 'MANIFEST.json'), {});
  const files = artifactFiles();
  const packageGitStatus = gitStatus(repoRoot);

  if (!files.length) {
    console.error('[agent-ui] no .dmg or .zip artifacts found in dist/');
    process.exit(1);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    package: {
      name: pkg.name || 'agent-ui',
      version: pkg.version || 'unknown',
      gitSha: gitHead(repoRoot),
      sourceDirty: packageGitStatus.length > 0,
      gitStatus: packageGitStatus,
    },
    hermes: {
      connectorBaselineRequirement: 'v2026.4.30+',
      standaloneRuntimeIncluded: true,
      releaseTag: buildHermesManifest.hermesReleaseTag || expectedHermesReleaseTag,
      releaseUrl: buildHermesManifest.hermesReleaseUrl || expectedHermesReleaseUrl,
      source: buildHermesManifest.source || 'unknown',
      sourcePolicy: buildHermesManifest.hermesSourcePolicy || 'local',
      gitSha: buildHermesManifest.gitHead || 'unknown',
      releaseGitSha: buildHermesManifest.hermesReleaseGitHead || 'unknown',
      sourceDirty: Boolean(buildHermesManifest.hermesSourceDirty),
      sourceGitStatus: buildHermesManifest.hermesSourceGitStatus || [],
      sourceIsReleaseHead: Boolean(buildHermesManifest.hermesSourceIsReleaseHead),
      bundledHermesAgentTreeSha256: buildHermesManifest.bundledHermesAgentTreeSha256 || 'unknown',
      platformOverlays: buildHermesManifest.hermesPlatformOverlays || [],
      python: buildHermesManifest.python || {},
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      releaseMode: requestedAppMode,
      appMode: requestedAppMode,
      signingMode,
      requireDeveloperId,
    },
    artifacts: [],
  };

  let failed = false;
  for (const file of files) {
    const ext = path.extname(file).slice(1).toLowerCase();
    const checks = ext === 'dmg' ? inspectDmg(file) : inspectZip(file);
    const allCommandFailures = commandFailures(checks);
    const appMode = artifactAppMode(file);
    const failures = enforcementFailures(ext, checks, signingMode, appMode);
    const hermesRuntimeIncluded = (checks.apps || []).some((app) => app.runtime && app.runtime.hermesRuntimeIncluded);
    const runtimeApp = standaloneRuntimeApp(checks);
    const embeddedHermesManifest = runtimeApp && runtimeApp.runtime ? runtimeApp.runtime.runtimeManifestData || {} : {};
    const record = {
      file: path.relative(repoRoot, file),
      name: path.basename(file),
      kind: ext,
      appMode,
      sizeBytes: fs.statSync(file).size,
      sha256: sha256(file),
      releaseMode: appMode,
      signingMode,
      hermesRuntimeIncluded,
      hermes: {
        runtimeIncluded: hermesRuntimeIncluded,
        baselineRequirement: appMode === 'connector' ? 'v2026.4.30+' : undefined,
        bundledGitSha: appMode === 'standalone' ? (embeddedHermesManifest.gitHead || 'unknown') : undefined,
        bundledReleaseGitSha: appMode === 'standalone' ? (embeddedHermesManifest.hermesReleaseGitHead || 'unknown') : undefined,
        bundledSourcePolicy: appMode === 'standalone' ? (embeddedHermesManifest.hermesSourcePolicy || 'unknown') : undefined,
        bundledSourceDirty: appMode === 'standalone' ? Boolean(embeddedHermesManifest.hermesSourceDirty) : undefined,
        bundledHermesAgentTreeSha256: appMode === 'standalone' ? (embeddedHermesManifest.bundledHermesAgentTreeSha256 || 'unknown') : undefined,
        embeddedRuntimeManifestPath: runtimeApp && runtimeApp.runtime ? runtimeApp.runtime.runtimeManifest : undefined,
        embeddedRuntimeManifestValid: runtimeApp && runtimeApp.runtime ? runtimeApp.runtime.runtimeManifestValid : undefined,
      },
      signing: (checks.apps || []).map((app) => ({
        appPath: app.appPath,
        developerId: app.signingIdentity.developerId,
        teamIdentifier: app.signingIdentity.teamIdentifier,
        authorities: app.signingIdentity.authorities,
        adhoc: app.signingIdentity.adhoc,
      })),
      notarizationStatus: notarizationStatus(ext, checks, signingMode),
      checks,
      allCommandFailures,
      failures,
    };
    manifest.artifacts.push(record);
    if (failures.length) failed = true;
  }

  const out = path.join(distDir, 'release-manifest.json');
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[agent-ui] wrote ${path.relative(repoRoot, out)}`);

  if (failed) {
    console.error('[agent-ui] release verification failed:');
    for (const artifact of manifest.artifacts) {
      for (const failure of artifact.failures) {
        console.error(`- ${artifact.file}: ${failure}`);
      }
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  appRuntimeEnforcementFailures,
  appRuntimeState,
  hermesReleaseEnforcementFailures,
  standaloneRuntimeApp,
  treeSha256,
};
