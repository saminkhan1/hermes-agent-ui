#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'dist', 'release-manifest.json');
const installerPath = path.join(repoRoot, 'dist', 'install-agent-ui-for-hermes.sh');
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

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function releaseAssetUrl(repo, releaseTag, name) {
  return `https://github.com/${repo}/releases/download/${releaseTag}/${encodeURIComponent(name)}`;
}

function installerScript(repo, releaseTag, zip) {
  const zipUrl = releaseAssetUrl(repo, releaseTag, zip.name);
  return `#!/usr/bin/env bash
set -euo pipefail

APP_NAME="agent-UI for Hermes.app"
ZIP_NAME="${zip.name}"
ZIP_URL="${zipUrl}"
ZIP_SHA256="${zip.sha256}"
INSTALL_DIR="/Applications"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "agent-UI for Hermes only supports macOS." >&2
  exit 1
fi

if [ "$(uname -m)" != "arm64" ]; then
  echo "This beta build is for Apple silicon Macs." >&2
  exit 1
fi

command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }
command -v ditto >/dev/null || { echo "ditto is required." >&2; exit 1; }
command -v shasum >/dev/null || { echo "shasum is required." >&2; exit 1; }
command -v codesign >/dev/null || { echo "codesign is required." >&2; exit 1; }

tmpdir="$(mktemp -d "\${TMPDIR:-/tmp}/agent-ui-install.XXXXXX")"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

zip_file="$tmpdir/$ZIP_NAME"
echo "Downloading $ZIP_NAME..."
curl -fL --proto '=https' --tlsv1.2 -o "$zip_file" "$ZIP_URL"

actual_sha="$(shasum -a 256 "$zip_file" | awk '{print $1}')"
if [ "$actual_sha" != "$ZIP_SHA256" ]; then
  echo "SHA-256 mismatch for $ZIP_NAME" >&2
  echo "expected: $ZIP_SHA256" >&2
  echo "actual:   $actual_sha" >&2
  exit 1
fi

extract_dir="$tmpdir/extract"
mkdir -p "$extract_dir"
ditto -x -k "$zip_file" "$extract_dir"
source_app="$extract_dir/$APP_NAME"
if [ ! -d "$source_app" ]; then
  source_app="$(find "$extract_dir" -maxdepth 2 -name "$APP_NAME" -type d -print -quit)"
fi
if [ ! -d "$source_app" ]; then
  echo "Could not find $APP_NAME in $ZIP_NAME." >&2
  exit 1
fi
codesign --verify --deep --strict --verbose=2 "$source_app"

dest_app="$INSTALL_DIR/$APP_NAME"
if [ -e "$dest_app" ]; then
  rm -rf "$dest_app"
fi
ditto "$source_app" "$dest_app"
xattr -dr com.apple.quarantine "$dest_app" 2>/dev/null || true
codesign --verify --deep --strict --verbose=2 "$dest_app"

echo "Installed $dest_app"
open "$dest_app"
`;
}

function writeInstallerRecord(repo, releaseTag, records) {
  const zip = records.find((record) => record.name.endsWith('.zip'));
  if (!zip) fail('cannot build installer script without a zip artifact.');
  fs.writeFileSync(installerPath, installerScript(repo, releaseTag, zip), { encoding: 'utf8', mode: 0o755 });
  return {
    name: path.basename(installerPath),
    file: installerPath,
    sha256: sha256(installerPath),
    sizeBytes: fs.statSync(installerPath).size,
  };
}

function releaseBody(manifest, records, repo) {
  const dmg = records.find((record) => record.name.endsWith('.dmg'));
  const zip = records.find((record) => record.name.endsWith('.zip'));
  const installer = records.find((record) => record.name === path.basename(installerPath));
  const manifestRecord = records.find((record) => record.name === 'release-manifest.json');
  const lines = [
    '# agent-UI for Hermes - Bootstrap Beta',
    '',
    'This is a private macOS beta for people already using a local Hermes setup. agent-UI gives you a desktop shortcut for sending text or voice tasks to Hermes, then shows the running session with follow-up, cancel, and reopen controls.',
    '',
    '## Download',
    '',
    dmg
      ? `Download \`${dmg.name}\` for the normal Mac install.`
      : 'Download the DMG artifact for the normal Mac install.',
    '',
    zip
      ? `The zip \`${zip.name}\` is included as a backup for testers who cannot use the DMG.`
      : 'The zip artifact is included as a backup for testers who cannot use the DMG.',
    '',
    '## Before You Install',
    '',
    '- macOS on Apple silicon.',
    `- Local Hermes ${manifest.hermes.connectorBaselineRequirement || 'v2026.4.30+'}.`,
    '- A Hermes provider/model already configured through Hermes.',
    '- Microphone permission only if you want voice input.',
    '',
    'This app is connector-only. It does not bundle Hermes, store provider credentials, or copy tools into your Hermes install.',
    '',
    '## Install Without The Apple Verification Dialog',
    '',
    "Because this beta is not notarized, the normal browser-download DMG path can show Apple's malware-verification warning and, on some Macs, right-click Open can keep looping. The no-dialog beta path is the checksum-verified installer script below: it downloads the release zip, verifies the SHA-256, verifies the app signature before install, installs the app in `/Applications`, clears quarantine on that installed copy, verifies the installed signature again, and opens the app.",
    '',
    installer
      ? '```bash\n' +
        `curl -fL -o /tmp/${installer.name} ${releaseAssetUrl(repo, tag, installer.name)} && \\\n` +
        `printf '${installer.sha256}  /tmp/${installer.name}\\n' | shasum -a 256 -c - && \\\n` +
        `bash /tmp/${installer.name}\n` +
        '```'
      : 'Download and run the installer script asset from this release.',
    '',
    '## Manual DMG Install',
    '',
    '1. Open the DMG.',
    '2. Drag `agent-UI for Hermes.app` to `/Applications`.',
    '3. Launch from Finder.',
    '4. If macOS says Apple could not verify the app is free of malware, right-click `agent-UI for Hermes.app`, choose `Open`, then confirm `Open` once. That approval is only needed for the first launch of this ad-hoc signed beta.',
    '5. Choose `Use Text Input` or `Use Voice Input`, press `Cmd+Shift+C`, and submit a small test task.',
    '',
    '## Beta Notes',
    '',
    '- This bootstrap build is ad-hoc signed and not notarized yet. Without a paid Apple Developer ID, macOS can still show the first-launch verification warning even when the bundle passes local code-signature checks.',
    '- Hermes still owns model/provider auth and the actual run. agent-UI is only the desktop connector.',
    '- If Hermes has no provider/model configured, agent-UI should preserve your task and show the Hermes setup path.',
    '',
    '## Verification',
    '',
    'Before upload, this release was checked with:',
    '',
    '- `pnpm run verify`',
    '- `pnpm run dist:mac`',
    '- `pnpm run release:verify`',
    '- `pnpm run verify:live:release -- "dist/mac-arm64/agent-UI for Hermes.app"`',
    '- `pnpm run verify:interaction:lmstudio -- "dist/mac-arm64/agent-UI for Hermes.app"`',
    '',
    '## Files',
    '',
    `Build commit: \`${manifest.package.gitSha}\``,
    '',
  ];
  for (const record of records) {
    lines.push(`- \`${record.name}\` (${formatSize(record.sizeBytes)})`);
    lines.push(`  - SHA-256: \`${record.sha256}\``);
  }
  if (manifestRecord) {
    lines.push(
      '',
      '`release-manifest.json` contains artifact hashes, signing/notarization evidence, packaged plugin checks, and build provenance.',
    );
  }
  return lines.join('\n');
}

function main() {
  const manifest = readJson(manifestPath);
  validateManifest(manifest);
  const repo = repoOverride || ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
  const records = artifactRecords(manifest);
  records.push(writeInstallerRecord(repo, tag, records));
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
      'agent-UI for Hermes Bootstrap Beta 1',
      '--draft=false',
      '--prerelease',
      '--notes-file',
      '-',
    ],
    { input: releaseBody(manifest, records, repo), timeoutMs: 60000 },
  );
  ghRelease(['release', 'upload', tag, ...records.map((record) => record.file), '--clobber'], { timeoutMs: 300000 });

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
