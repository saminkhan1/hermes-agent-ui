'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

test('default mac distribution builds connector and standalone bootstrap apps', () => {
  const pkg = JSON.parse(read('package.json'));
  const connectorConfig = require('../packaging/electron-builder.connector.bootstrap.cjs');
  const standaloneConfig = require('../packaging/electron-builder.standalone.bootstrap.cjs');
  const workflow = read('.github/workflows/mac-release.yml');

  assert.equal(pkg.scripts['dist:mac'], 'npm run dist:mac:bootstrap');
  assert.match(pkg.scripts['dist:mac:bootstrap'], /dist:mac:connector:bootstrap/);
  assert.match(pkg.scripts['dist:mac:bootstrap'], /dist:mac:standalone:bootstrap/);
  assert.match(pkg.scripts['dist:mac:connector:bootstrap'], /assert-mac-release-env\.js bootstrap connector/);
  assert.match(pkg.scripts['dist:mac:connector:bootstrap'], /electron-builder --config packaging\/electron-builder\.connector\.bootstrap\.cjs/);
  assert.match(pkg.scripts['dist:mac:standalone:bootstrap'], /assert-mac-release-env\.js bootstrap standalone/);
  assert.match(pkg.scripts['dist:mac:standalone:bootstrap'], /npm run bundle:hermes/);
  assert.match(pkg.scripts['dist:mac:developer-id'], /dist:mac:connector:developer-id/);
  assert.match(pkg.scripts['release:verify'], /release:verify:bootstrap/);
  assert.match(pkg.scripts['release:verify:bootstrap'], /RELEASE_VERIFY_SIGNING_MODE=bootstrap/);
  assert.match(pkg.scripts['release:verify:bootstrap'], /RELEASE_VERIFY_APP_MODE=all/);
  assert.match(pkg.scripts['release:verify:developer-id'], /RELEASE_VERIFY_SIGNING_MODE=developer-id/);

  assert.equal(connectorConfig.productName, 'agent-UI for Hermes');
  assert.equal(connectorConfig.appId, 'ai.agent-ui.hermes');
  assert.equal(connectorConfig.extraResources.length, 0);
  assert.equal(connectorConfig.afterPack, undefined);
  assert.match(connectorConfig.artifactName, /agent-UI-for-Hermes/);
  assert.equal(connectorConfig.extraMetadata.agentUI.releaseMode, 'connector');
  assert.equal(connectorConfig.extraMetadata.agentUI.hermesRuntimeIncluded, false);

  assert.equal(standaloneConfig.productName, 'agent-UI Standalone');
  assert.equal(standaloneConfig.appId, 'ai.agent-ui.standalone');
  assert.equal(standaloneConfig.extraResources.some((entry) => entry.to === 'hermes-runtime'), true);
  assert.match(standaloneConfig.artifactName, /agent-UI-Standalone/);
  assert.equal(standaloneConfig.extraMetadata.agentUI.releaseMode, 'standalone');
  assert.equal(standaloneConfig.extraMetadata.agentUI.hermesRuntimeIncluded, true);

  assert.equal(connectorConfig.mac.identity, '-');
  assert.equal(standaloneConfig.mac.identity, '-');
  assert.equal(connectorConfig.mac.notarize, false);
  assert.equal(standaloneConfig.mac.notarize, false);
  assert.equal(connectorConfig.mac.gatekeeperAssess, false);
  assert.equal(standaloneConfig.mac.gatekeeperAssess, false);

  assert.match(workflow, /macos-15/);
  assert.match(workflow, /branches:\n\s+- deployment/);
  assert.match(workflow, /RELEASE_VERIFY_SIGNING_MODE: bootstrap/);
  assert.match(workflow, /RELEASE_VERIFY_APP_MODE: all/);
  assert.match(workflow, /npm run dist:mac/);
  assert.doesNotMatch(workflow, /MACOS_CSC_LINK|APPLE_API_KEY|notarize|staple/);
});

test('release manifest records app mode and enforces Hermes runtime inclusion', () => {
  const manifest = read('scripts/release-manifest.js');
  const envCheck = read('scripts/assert-mac-release-env.js');

  assert.match(manifest, /RELEASE_VERIFY_SIGNING_MODE/);
  assert.match(manifest, /RELEASE_VERIFY_APP_MODE/);
  assert.match(manifest, /not_applicable_bootstrap/);
  assert.match(manifest, /artifactAppMode/);
  assert.match(manifest, /knownAppFiles/);
  assert.match(manifest, /-bootstrap\\\./);
  assert.match(manifest, /connector app must not include Contents\/Resources\/hermes-runtime/);
  assert.match(manifest, /standalone app must include Contents\/Resources\/hermes-runtime/);
  assert.match(manifest, /hermesRuntimeIncluded/);
  assert.match(manifest, /baselineRequirement/);
  assert.match(manifest, /app is not ad-hoc signed for bootstrap distribution/);
  assert.match(manifest, /app is not signed with Developer ID Application/);
  assert.match(manifest, /notarizationStatus/);
  assert.match(manifest, /sourceDirty/);
  assert.match(manifest, /sourcePolicy/);
  assert.match(manifest, /sourceGitStatus/);
  assert.match(manifest, /bundledHermesAgentTreeSha256/);
  assert.match(manifest, /hermesBinExecutable/);
  assert.match(manifest, /pythonBinExecutable/);
  assert.match(manifest, /localDesktopPluginPresent/);
  assert.match(manifest, /Developer ID standalone build must use HERMES_BUNDLE_SOURCE_POLICY=release/);
  assert.match(manifest, /gitStatus/);
  assert.match(manifest, /sha256/);

  assert.match(envCheck, /standalone.*uv for bundled Python dependency resolution/s);
  assert.match(envCheck, /bootstrap mac packaging: ad-hoc app signing, no notarization or stapling/);
  assert.match(envCheck, /Developer ID Application signing identity/);
  assert.match(envCheck, /Apple notarization credentials/);
});

test('release manifest enforces embedded Hermes runtime provenance', () => {
  const {
    appRuntimeEnforcementFailures,
    hermesReleaseEnforcementFailures,
  } = require('../scripts/release-manifest.js');
  const app = {
    runtime: {
      hermesRuntimeIncluded: true,
      hermesBinExecutable: true,
      pythonBinExecutable: true,
      runtimeManifestPresent: true,
      runtimeManifestValid: true,
      hermesAgentPresent: true,
      hermesAgentTreeSha256: 'actual-tree',
      localDesktopManifestPresent: true,
      localDesktopPluginPresent: true,
      runtimeManifestData: {
        gitHead: 'dirty-head',
        hermesReleaseGitHead: 'release-head',
        hermesSourcePolicy: 'local',
        hermesSourceDirty: true,
        hermesSourceIsReleaseHead: false,
        hermesReleaseTag: 'v0.0.0',
        hermesReleaseUrl: 'https://example.invalid/hermes',
        bundledHermesAgentTreeSha256: 'manifest-tree',
      },
    },
  };

  assert.match(
    appRuntimeEnforcementFailures(app, 'standalone').join('\n'),
    /MANIFEST\.json tree hash does not match embedded hermes-agent/
  );
  const releaseFailures = hermesReleaseEnforcementFailures(app, 'standalone', 'developer-id').join('\n');
  assert.match(releaseFailures, /HERMES_BUNDLE_SOURCE_POLICY=release/);
  assert.match(releaseFailures, /must not bundle a dirty Hermes source/);
  assert.match(releaseFailures, /must bundle the pinned Hermes release head/);
  assert.match(releaseFailures, /must bundle Hermes release tag v2026\.4\.30/);
  assert.match(releaseFailures, /must record Hermes release URL/);
  assert.match(releaseFailures, /gitHead matching hermesReleaseGitHead/);
});

test('standalone Hermes bundler uses local source provenance by default', () => {
  const bundler = read('scripts/bundle-hermes-runtime.js');

  assert.match(bundler, /HERMES_BUNDLE_SOURCE_POLICY \|\| 'local'/);
  assert.match(bundler, /HERMES_BUNDLE_REQUIRE_RELEASE/);
  assert.match(bundler, /Bundling local Hermes source/);
  assert.match(bundler, /hermesSourceGitStatus/);
  assert.match(bundler, /bundledHermesAgentTreeSha256/);
  assert.match(bundler, /action: 'kept-source'/);
  assert.match(bundler, /action: 'copied-vendored'/);
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['dist:mac:standalone:developer-id'], /HERMES_BUNDLE_SOURCE_POLICY=release npm run bundle:hermes/);
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
  assert.match(smoke, /before_hash/);
  assert.match(smoke, /after_hash/);
});

test('manual customer pass documents bootstrap Gatekeeper expectations', () => {
  const checklist = read('docs/release/MANUAL_CUSTOMER_PASS.md');

  assert.match(checklist, /right-click Open approval/);
  assert.match(checklist, /expected only for future Developer ID-notarized artifacts/);
  assert.match(checklist, /spctl.*stapler rejection is expected evidence/);
  assert.doesNotMatch(checklist, /without override steps/);
});

test('installed app release smoke is a committed repeatable gate', () => {
  const pkg = JSON.parse(read('package.json'));
  const smoke = read('scripts/installed-app-release-smoke.js');
  const gatewaySmoke = read('scripts/local-gateway-smoke.js');
  const guiSmoke = read('scripts/tart-gui-manual.sh');
  const readme = read('README.md');
  const evidenceTemplate = read('docs/release/evidence-template.md');

  assert.equal(pkg.scripts['smoke:installed-release'], 'node scripts/installed-app-release-smoke.js');
  assert.equal(pkg.scripts['tart:manual-gui'], 'bash scripts/tart-gui-manual.sh');
  assert.match(smoke, /AGENT_UI_EVAL/);
  assert.match(smoke, /AGENT_UI_EVAL_TOKEN/);
  assert.match(smoke, /AGENT_UI_CONFIG_DIR/);
  assert.match(smoke, /AGENT_UI_HERMES_HOME/);
  assert.match(smoke, /createPortBlocker/);
  assert.match(smoke, /\/set-input-mode/);
  assert.match(smoke, /\/background Release background smoke/);
  assert.match(smoke, /\/followup/);
  assert.match(smoke, /\/cancel/);
  assert.match(gatewaySmoke, /\/events/);
  assert.match(smoke, /\/open-conversation/);
  assert.match(smoke, /reopen-smoke/);
  assert.match(smoke, /assertNoErrorItems/);
  assert.match(smoke, /installed-release-smoke-summary\.json/);
  assert.match(smoke, /app-seal-before/);
  assert.match(smoke, /installed app bundle changed after launch/);
  assert.match(guiSmoke, /TART_IMAGE must be a Cirrus vanilla image/);
  assert.match(guiSmoke, /tart run --dir="agent-ui-artifacts:\$artifact_dir:ro"/);
  assert.match(guiSmoke, /Open the Tart VM window/);
  assert.match(readme, /npm run smoke:installed-release -- "\/Applications\/agent-UI Standalone\.app"/);
  assert.match(evidenceTemplate, /Installed-App Automation/);
  assert.match(evidenceTemplate, /Ring 3 - Manual Customer Pass/);
});
