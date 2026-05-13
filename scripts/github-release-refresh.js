#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'dist', 'release-manifest.json');
const defaultTag = 'v1.0.0-beta.1';
const args = process.argv.slice(2);

function optionValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : '';
}

const dryRun = args.includes('--dry-run');
const repoOverride = process.env.AGENT_UI_RELEASE_REPO || optionValue('--repo');
const tag =
  process.env.AGENT_UI_RELEASE_TAG ||
  args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '--repo') ||
  defaultTag;
const repoArgs = repoOverride ? ['--repo', repoOverride] : [];

function fail(message, details = '') {
  console.error(`[agent-ui] release refresh failed: ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

function run(command, commandArgs, opts = {}) {
  const res = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    input: opts.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: opts.timeoutMs || 30000,
  });
  if (res.status !== 0) {
    fail(`${command} ${commandArgs.join(' ')}`, String(res.stderr || res.stdout || res.error || '').trim());
  }
  return String(res.stdout || '').trim();
}

function gh(commandArgs, opts = {}) {
  return run('gh', commandArgs, opts);
}

function ghRelease(commandArgs, opts = {}) {
  return gh([...commandArgs, ...repoArgs], opts);
}

function ghJson(commandArgs) {
  return JSON.parse(gh(commandArgs, { timeoutMs: 60000 }) || '{}');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`could not read ${path.relative(repoRoot, file)}`, error && error.message ? error.message : String(error));
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validateManifest(manifest) {
  const gitSha = manifest.package && manifest.package.gitSha;
  if (!gitSha) fail('release manifest has no package.gitSha.');
  if (manifest.package.sourceDirty) fail('release manifest was generated from a dirty source tree.');
  if (manifest.environment && manifest.environment.releaseMode !== 'connector') {
    fail(`release manifest must be connector mode, got ${manifest.environment.releaseMode}`);
  }
  if (manifest.hermes && manifest.hermes.runtimeIncluded !== false) {
    fail('connector release manifest must record hermes.runtimeIncluded=false.');
  }
  for (const artifact of manifest.artifacts || []) {
    if (artifact.hermesRuntimeIncluded !== false) fail(`${artifact.name} includes Hermes runtime.`);
    if (!artifact.localDesktopPlugin || artifact.localDesktopPlugin.matchesSource !== true) {
      fail(`${artifact.name} local_desktop plugin does not match source.`);
    }
  }
}

function artifactRecords(manifest) {
  const records = (manifest.artifacts || []).map((artifact) => {
    const file = path.resolve(repoRoot, artifact.file || path.join('dist', artifact.name || ''));
    if (!fs.existsSync(file)) fail(`missing artifact ${path.relative(repoRoot, file)}`);
    const actualSha = sha256(file);
    if (actualSha !== artifact.sha256) {
      fail(`${path.basename(file)} hash mismatch`, `manifest=${artifact.sha256}\nactual=${actualSha}`);
    }
    return {
      name: artifact.name || path.basename(file),
      file,
      sha256: actualSha,
      sizeBytes: fs.statSync(file).size,
    };
  });
  if (!records.length) fail('release manifest has no artifacts.');
  records.push({
    name: 'release-manifest.json',
    file: manifestPath,
    sha256: sha256(manifestPath),
    sizeBytes: fs.statSync(manifestPath).size,
  });
  return records;
}

function expectedDigest(record) {
  return `sha256:${record.sha256}`;
}

function releaseBody(manifest, records) {
  const lines = [
    'Private bootstrap beta for macOS arm64.',
    '',
    `This build is from main commit ${manifest.package.gitSha}.`,
    '',
    'Artifacts:',
  ];
  for (const record of records) {
    lines.push(`- ${record.name}`);
    lines.push(`  - sha256: ${record.sha256}`);
  }
  lines.push(
    '',
    'Verification completed before upload:',
    '- npm run verify',
    '- npm run dist:mac',
    '- npm run release:verify',
    '- npm run verify:live:release -- "dist/mac-arm64/agent-UI for Hermes.app"',
    '- npm run verify:interaction:lmstudio -- "dist/mac-arm64/agent-UI for Hermes.app"',
    '',
    'This is the connector build for an existing local Hermes setup. It is ad-hoc signed and not notarized; first launch may require Finder right-click Open. See release-manifest.json for hashes, provenance, and validation metadata.',
  );
  return lines.join('\n');
}

function main() {
  const manifest = readJson(manifestPath);
  validateManifest(manifest);
  const records = artifactRecords(manifest);
  const plan = {
    tag,
    gitSha: manifest.package.gitSha,
    artifacts: records.map((record) => ({
      name: record.name,
      sizeBytes: record.sizeBytes,
      digest: expectedDigest(record),
    })),
  };
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, ...plan }, null, 2));
    return;
  }

  const remoteTag = run('git', ['ls-remote', 'origin', `refs/tags/${tag}`]);
  if (!remoteTag.startsWith(`${manifest.package.gitSha}\t`)) {
    fail(
      `origin tag ${tag} does not point at manifest commit ${manifest.package.gitSha}`,
      remoteTag || `Run: git tag -f ${tag} ${manifest.package.gitSha} && git push --force origin ${tag}`,
    );
  }

  ghRelease(
    [
      'release',
      'edit',
      tag,
      '--verify-tag',
      '--target',
      manifest.package.gitSha,
      '--title',
      'agent-UI Bootstrap Beta 1',
      '--draft=false',
      '--prerelease',
      '--notes-file',
      '-',
    ],
    { input: releaseBody(manifest, records), timeoutMs: 60000 },
  );
  ghRelease(['release', 'upload', tag, ...records.map((record) => record.file), '--clobber'], { timeoutMs: 300000 });

  const repo = repoOverride || ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
  const refreshed = ghJson(['api', `repos/${repo}/releases/tags/${tag}`]);
  const uploaded = new Map((refreshed.assets || []).map((asset) => [asset.name, asset]));
  for (const record of records) {
    const asset = uploaded.get(record.name);
    if (!asset) fail(`release is missing uploaded asset ${record.name}`);
    if (asset.digest !== expectedDigest(record)) {
      fail(`${record.name} uploaded digest mismatch`, `github=${asset.digest}\nexpected=${expectedDigest(record)}`);
    }
  }
  console.log(JSON.stringify({ ok: true, release: refreshed.html_url, ...plan }, null, 2));
}

try {
  main();
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
