'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

test('default mac distribution uses the bootstrap no-paid-plan path', () => {
  const pkg = JSON.parse(read('package.json'));
  const bootstrapConfig = require('../packaging/electron-builder.bootstrap.cjs');
  const workflow = read('.github/workflows/mac-release.yml');

  assert.equal(pkg.scripts['dist:mac'], 'npm run dist:mac:bootstrap');
  assert.match(pkg.scripts['dist:mac:bootstrap'], /assert-mac-release-env\.js bootstrap/);
  assert.match(pkg.scripts['dist:mac:bootstrap'], /electron-builder --config packaging\/electron-builder\.bootstrap\.cjs/);
  assert.match(pkg.scripts['dist:mac:developer-id'], /assert-mac-release-env\.js developer-id/);
  assert.match(pkg.scripts['release:verify'], /release:verify:bootstrap/);
  assert.match(pkg.scripts['release:verify:bootstrap'], /RELEASE_VERIFY_MODE=bootstrap/);
  assert.match(pkg.scripts['release:verify:developer-id'], /RELEASE_VERIFY_MODE=developer-id/);

  assert.equal(bootstrapConfig.mac.identity, '-');
  assert.equal(bootstrapConfig.mac.notarize, false);
  assert.equal(bootstrapConfig.mac.gatekeeperAssess, false);
  assert.match(bootstrapConfig.artifactName, /bootstrap/);

  assert.match(workflow, /macos-15/);
  assert.match(workflow, /branches:\n\s+- deployment/);
  assert.match(workflow, /RELEASE_VERIFY_MODE: bootstrap/);
  assert.match(workflow, /npm run dist:mac/);
  assert.doesNotMatch(workflow, /MACOS_CSC_LINK|APPLE_API_KEY|notarize|staple/);
});

test('release manifest distinguishes bootstrap from Developer ID verification', () => {
  const manifest = read('scripts/release-manifest.js');
  const envCheck = read('scripts/assert-mac-release-env.js');

  assert.match(manifest, /RELEASE_VERIFY_MODE/);
  assert.match(manifest, /not_applicable_bootstrap/);
  assert.match(manifest, /modeFiles = mode === 'bootstrap'/);
  assert.match(manifest, /-bootstrap\\\./);
  assert.match(manifest, /app is not ad-hoc signed for bootstrap distribution/);
  assert.match(manifest, /app is not signed with Developer ID Application/);
  assert.match(manifest, /notarizationStatus/);
  assert.match(manifest, /sourceDirty/);
  assert.match(manifest, /gitStatus/);
  assert.match(manifest, /sha256/);

  assert.match(envCheck, /bootstrap mac packaging: ad-hoc app signing, no notarization or stapling/);
  assert.match(envCheck, /Developer ID Application signing identity/);
  assert.match(envCheck, /Apple notarization credentials/);
});

test('Tart clean-room smoke uses vanilla images and password SSH isolation', () => {
  const smoke = read('scripts/tart-clean-room-smoke.sh');

  assert.match(smoke, /macos-sequoia-vanilla:latest/);
  assert.match(smoke, /TART_IMAGE must be a Cirrus vanilla image/);
  assert.match(smoke, /TART_SSH_USER:-admin/);
  assert.match(smoke, /TART_SSH_PASSWORD:-admin/);
  assert.match(smoke, /sshpass -p "\$tart_ssh_password" ssh/);
  assert.match(smoke, /--dir="agent-ui-artifacts:\$artifact_dir:ro"/);
  assert.match(smoke, /\/Volumes\/My Shared Files\/agent-ui-artifacts/);
  assert.match(smoke, /IdentitiesOnly=yes/);
  assert.match(smoke, /PreferredAuthentications=password/);
  assert.match(smoke, /PubkeyAuthentication=no/);
  assert.match(smoke, /ssh_ready=false/);
  assert.match(smoke, /command -v brew/);
});
