'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const legacyRequireSigned = String(process.env.RELEASE_VERIFY_REQUIRE_SIGNED || '').trim() === '1';
const requestedMode = String(process.env.RELEASE_VERIFY_MODE || (legacyRequireSigned ? 'developer-id' : 'bootstrap')).trim().toLowerCase();
const releaseMode = requestedMode === 'developer-id' ? 'developer-id' : requestedMode;

if (!['bootstrap', 'developer-id'].includes(releaseMode)) {
  console.error(`[agent-ui] RELEASE_VERIFY_MODE must be bootstrap or developer-id, got ${requestedMode}`);
  process.exit(2);
}

const requireDeveloperId = releaseMode === 'developer-id';

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
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

function artifactFiles(mode = releaseMode) {
  if (!fs.existsSync(distDir)) return [];
  const files = fs.readdirSync(distDir)
    .filter((name) => /\.(dmg|zip)$/i.test(name))
    .map((name) => path.join(distDir, name))
    .sort();
  const modeFiles = mode === 'bootstrap'
    ? files.filter((file) => /-bootstrap\.(dmg|zip)$/i.test(path.basename(file)))
    : files.filter((file) => !/-bootstrap\.(dmg|zip)$/i.test(path.basename(file)));
  return modeFiles.length ? modeFiles : files;
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

function appChecks(appPath) {
  const display = run('codesign', ['-dv', '--verbose=4', appPath]);
  return {
    appPath,
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

function appEnforcementFailures(app, mode) {
  const failures = [];
  failures.push(...commandFailure(app.codesignDisplay, 'app.codesignDisplay'));
  failures.push(...commandFailure(app.codesignVerify, 'app.codesignVerify'));
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

function enforcementFailures(kind, checks, mode) {
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
    failures.push('artifact does not contain agent-UI.app');
  }
  for (const app of checks.apps || []) {
    failures.push(...appEnforcementFailures(app, mode).map((failure) => `${path.basename(app.appPath)}: ${failure}`));
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

const pkg = readJson(path.join(repoRoot, 'package.json'), {});
const hermesManifest = readJson(path.join(repoRoot, 'build', 'hermes-runtime', 'MANIFEST.json'), {});
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
    releaseTag: hermesManifest.hermesReleaseTag || 'v2026.4.30',
    releaseUrl: hermesManifest.hermesReleaseUrl || 'https://github.com/NousResearch/hermes-agent/releases/tag/v2026.4.30',
    gitSha: hermesManifest.gitHead || 'unknown',
    releaseGitSha: hermesManifest.hermesReleaseGitHead || 'unknown',
    sourceDirty: Boolean(hermesManifest.hermesSourceDirty),
    platformOverlays: hermesManifest.hermesPlatformOverlays || [],
    python: hermesManifest.python || {},
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    releaseMode,
    requireDeveloperId,
  },
  artifacts: [],
};

let failed = false;
for (const file of files) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const checks = ext === 'dmg' ? inspectDmg(file) : inspectZip(file);
  const allCommandFailures = commandFailures(checks);
  const failures = enforcementFailures(ext, checks, releaseMode);
  const record = {
    file: path.relative(repoRoot, file),
    kind: ext,
    sizeBytes: fs.statSync(file).size,
    sha256: sha256(file),
    releaseMode,
    signing: (checks.apps || []).map((app) => ({
      appPath: app.appPath,
      developerId: app.signingIdentity.developerId,
      teamIdentifier: app.signingIdentity.teamIdentifier,
      authorities: app.signingIdentity.authorities,
      adhoc: app.signingIdentity.adhoc,
    })),
    notarizationStatus: notarizationStatus(ext, checks, releaseMode),
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
