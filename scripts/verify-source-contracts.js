'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function fail(message, details = '') {
  console.error(`[agent-ui] source contract failed: ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

function read(rel) {
  const file = path.join(repoRoot, rel);
  if (!fs.existsSync(file)) fail(`missing ${rel}`);
  return fs.readFileSync(file, 'utf8');
}

function requireText(rel, needle, reason) {
  const text = read(rel);
  if (!text.includes(needle)) fail(`${rel} missing ${reason || needle}`);
}

function requireRegex(rel, regex, reason) {
  const text = read(rel);
  if (!regex.test(text)) fail(`${rel} missing ${reason || regex}`);
}

function requireNoText(rel, needle, reason) {
  const text = read(rel);
  if (text.includes(needle)) fail(`${rel} must not include ${reason || needle}`);
}

function requireFile(rel) {
  const file = path.join(repoRoot, rel);
  if (!fs.existsSync(file)) fail(`build output missing ${rel}`, 'Run npm run build before verify-source-contracts.');
}

function packageScript(name) {
  const pkg = JSON.parse(read('package.json'));
  const value = pkg.scripts && pkg.scripts[name];
  if (!value) fail(`package.json missing script ${name}`);
  return String(value);
}

function requireNoPackageScript(name, reason) {
  const pkg = JSON.parse(read('package.json'));
  if (pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, name)) {
    fail(`package.json must not expose ${name}`, reason);
  }
}

function verifyPackageScripts() {
  if (packageScript('verify') !== 'npm run verify:source') fail('verify must route to verify:source.');
  for (const token of ['verify:hermes-contracts', 'typecheck', 'build', 'verify:source-contracts']) {
    if (!packageScript('verify:source').includes(token)) fail(`verify:source must include ${token}.`);
  }
  requireNoPackageScript('dist:mac:connector', 'Use dist:mac or the explicit dist:mac:connector:bootstrap implementation.');
  requireNoPackageScript('release:verify:connector:bootstrap', 'Use release:verify or release:verify:bootstrap.');
  requireNoPackageScript('smoke:installed-release:lmstudio', 'Use verify:live:lmstudio so LM Studio preflight cannot be skipped.');
  if (packageScript('verify:installed') !== 'node scripts/installed-app-release-smoke.js') {
    fail('verify:installed must be the black-box installed-app smoke.');
  }
  const live = packageScript('verify:live:lmstudio');
  for (const token of ['lmstudio-live-preflight.js', 'AGENT_UI_INSTALLED_SMOKE_PROVIDER=lmstudio', 'AGENT_UI_LMSTUDIO_MODEL=google/gemma-4-26b-a4b', 'installed-app-release-smoke.js']) {
    if (!live.includes(token)) fail(`verify:live:lmstudio must include ${token}.`);
  }
  const concurrency = packageScript('verify:concurrency:3');
  for (const token of ['lmstudio-live-preflight.js', 'AGENT_UI_INSTALLED_SMOKE_PHASES=concurrency', 'AGENT_UI_STAGE_REPORT_MIN_RUNS=3', 'AGENT_UI_LMSTUDIO_MODEL=google/gemma-4-26b-a4b']) {
    if (!concurrency.includes(token)) fail(`verify:concurrency:3 must include ${token}.`);
  }
  const interaction = packageScript('verify:interaction:lmstudio');
  for (const token of ['lmstudio-live-preflight.js', 'AGENT_UI_LMSTUDIO_MODEL=google/gemma-4-26b-a4b', 'interaction-lmstudio-smoke.js']) {
    if (!interaction.includes(token)) fail(`verify:interaction:lmstudio must include ${token}.`);
  }
}

function verifyPackagingModes() {
  const { makeConfig } = require(path.join(repoRoot, 'packaging', 'electron-builder.shared.cjs'));
  const connector = makeConfig({ appMode: 'connector', signingMode: 'bootstrap' });
  if (connector.extraMetadata.agentUI.hermesRuntimeIncluded !== false) {
    fail('connector package must not claim embedded Hermes runtime.');
  }
  if (Array.isArray(connector.extraResources) && connector.extraResources.some((item) => String(item && item.to || '').includes('hermes-runtime'))) {
    fail('connector package must not include hermes-runtime resources.');
  }
  if (!Array.isArray(connector.extraResources) || !connector.extraResources.some((item) => item && item.from === 'vendor/hermes-platforms' && item.to === 'hermes-platforms')) {
    fail('connector package must include the local_desktop platform plugin resource.');
  }
  const appModes = Object.keys(require(path.join(repoRoot, 'packaging', 'electron-builder.shared.cjs')).APP_MODES).sort();
  if (appModes.length !== 1 || appModes[0] !== 'connector') {
    fail('packaging must stay connector-only.', appModes.join(', '));
  }
}

function verifyGatewayEnvContract() {
  for (const key of [
    'LOCAL_DESKTOP_GATEWAY_KEY',
    'LOCAL_DESKTOP_ALLOWED_USERS',
    'LOCAL_DESKTOP_ALLOW_ALL_USERS',
    'LOCAL_DESKTOP_HOST',
    'LOCAL_DESKTOP_PORT',
    'LOCAL_DESKTOP_HOME_CHANNEL',
    'LOCAL_DESKTOP_HOME_CHANNEL_NAME',
  ]) {
    requireText('src/main/hermes-runtime.ts', `'${key}'`, `gateway env key ${key}`);
  }
  requireText('src/main/hermes-runtime.ts', "['gateway', 'run', '--replace']", 'Hermes gateway replacement args');
  requireText('src/main/hermes-runtime.ts', 'HERMES_BUNDLED_PLUGINS', 'Hermes plugin resource env');
  requireText('src/main/hermes-runtime.ts', 'hermes-platforms', 'local_desktop plugin resource path');
  requireText('src/main/hermes-gateway-client.ts', '/messages', 'local desktop message route');
  requireText('src/main/hermes-gateway-client.ts', '/events', 'local desktop event route');
  requireText('src/main/hermes-gateway-client.ts', '/health', 'local desktop health route');
}

function verifyEvalSurface() {
  requireText('src/main/eval-server.ts', 'AGENT_UI_EVAL_TOKEN', 'eval token gate');
  requireText('src/main/eval-server.ts', 'timingSafeEqual', 'constant-time eval auth compare');
  requireText('src/main/eval-server.ts', "server.listen(port, '127.0.0.1'", 'loopback-only eval server');
  for (const route of ['/start', '/followup', '/cancel', '/open-conversation', '/wait', '/ui-targets']) {
    requireText('src/main/eval-server.ts', `url.pathname === '${route}'`, `eval route ${route}`);
  }
}

function verifyInstalledSmokeContract() {
  requireText('scripts/installed-app-release-smoke.js', "providerSmoke === 'lmstudio'", 'live LM Studio mode');
  requireText('scripts/installed-app-release-smoke.js', 'AGENT_UI_LMSTUDIO_MODEL', 'pinned LM Studio model env');
  requireText('scripts/installed-app-release-smoke.js', 'context_length: 64000', 'Hermes minimum context override for LM Studio live smoke');
  requireText('scripts/installed-app-release-smoke.js', 'auxiliary:', 'Hermes auxiliary config for LM Studio live smoke');
  requireText('scripts/installed-app-release-smoke.js', 'compression:', 'Hermes compression config for LM Studio live smoke');
  requireText('scripts/installed-app-release-smoke.js', 'AGENT_UI_LMSTUDIO_INITIAL_OK', 'initial live sentinel');
  requireText('scripts/installed-app-release-smoke.js', 'AGENT_UI_LMSTUDIO_FOLLOWUP_OK', 'follow-up live sentinel');
  requireText('scripts/installed-app-release-smoke.js', 'AGENT_UI_LMSTUDIO_REOPEN_OK', 'reopen live sentinel');
  requireText('scripts/installed-app-release-smoke.js', 'AGENT_UI_LMSTUDIO_POST_CANCEL_OK', 'post-cancel live sentinel');
  requireText('scripts/installed-app-release-smoke.js', 'AGENT_UI_LMSTUDIO_CONCURRENT_1_OK', 'concurrency live sentinel');
  requireText('scripts/installed-app-release-smoke.js', 'runConcurrencyChecks', 'three-conversation live stress phase');
  requireText('scripts/installed-app-release-smoke.js', 'appSealSnapshot', 'installed app mutation guard');
  requireRegex('scripts/installed-app-release-smoke.js', /sealBefore\.sha256\s*===\s*sealAfter\.sha256/, 'bundle integrity comparison');
}

function verifyInteractionSmokeContract() {
  requireText('scripts/interaction-lmstudio-smoke.js', "clickMenuItem('File', 'Use Text Input')", 'menu input-mode interaction');
  requireText('scripts/interaction-lmstudio-smoke.js', 'pressShortcutC()', 'keyboard shortcut interaction');
  requireText('scripts/interaction-lmstudio-smoke.js', 'clickAtRect(', 'real mouse click interaction');
  requireText('scripts/interaction-lmstudio-smoke.js', 'CGEvent(mouseEventSource', 'native mouse event click automation');
  requireText('scripts/interaction-lmstudio-smoke.js', 'pasteText(', 'real paste interaction');
  requireText('scripts/interaction-lmstudio-smoke.js', 'screencapture', 'screenshot evidence');
  requireText('scripts/interaction-lmstudio-smoke.js', 'assertRealHermesAvailable', 'real Hermes executable preflight');
  requireText('scripts/interaction-lmstudio-smoke.js', 'https://github.com/NousResearch/hermes-agent.git', 'direct upstream Hermes clone assertion');
  requireText('scripts/interaction-lmstudio-smoke.js', 'AGENT_UI_HERMES_BIN: evidence.realHermes.command', 'app process uses verified upstream Hermes executable');
  requireText('scripts/interaction-lmstudio-smoke.js', 'gatewayPostEvents', 'Hermes gateway message assertions');
  requireText('scripts/interaction-lmstudio-smoke.js', 'includeContext === true', 'normal prompt context assertion');
  requireText('scripts/interaction-lmstudio-smoke.js', 'includeContext === false', 'follow-up no-context assertion');
  requireText('scripts/interaction-lmstudio-smoke.js', 'AGENT_UI_INTERACTION_INITIAL_OK', 'initial live sentinel');
  requireText('scripts/interaction-lmstudio-smoke.js', 'AGENT_UI_INTERACTION_FOLLOWUP_OK', 'follow-up live sentinel');
  requireNoText('scripts/interaction-lmstudio-smoke.js', 'createLocalAdapterHermes', 'local adapter path');
  requireNoText('scripts/interaction-lmstudio-smoke.js', 'fallback_adapter', 'fake gateway metadata');
  requireNoText('scripts/interaction-lmstudio-smoke.js', 'AGENT_UI_INTERACTION_AUTH_REQUIRED', 'synthetic auth prompt');
  requireNoText('scripts/interaction-lmstudio-smoke.js', 'AGENT_UI_INTERACTION_REPLAY_EXPIRE', 'synthetic replay prompt');
  requireNoText('scripts/interaction-lmstudio-smoke.js', 'AGENT_UI_INTERACTION_ATTACHMENT', 'synthetic attachment prompt');
  requireNoText('scripts/interaction-lmstudio-smoke.js', 'process.env.AGENT_UI_HERMES_BIN', 'externally selected Hermes executable');
  requireText('src/renderer/src/renderer.ts', 'rows,', 'overlay row eval rectangles');
  requireText('src/renderer/src/conversation.ts', 'followupValueLength', 'conversation follow-up value assertion');
}

function verifyBuildOutputs() {
  for (const rel of [
    'out/main/index.js',
    'out/main/agents.js',
    'out/main/eval-server.js',
    'out/main/hermes-gateway-client.js',
    'out/main/hermes-runtime.js',
    'out/main/hermes-release.js',
    'out/preload/index.js',
    'out/renderer/index.html',
    'out/renderer/modal.html',
    'out/renderer/conversation.html',
    'out/renderer/auth.html',
  ]) {
    requireFile(rel);
  }
}

function verifyPublicSurface() {
  for (const rel of ['README.md', '.github/workflows/mac-release.yml', 'package.json']) {
    const text = read(rel);
    for (const stale of [
      'CONTRIBUTING.md',
      'docs/RELEASE.md',
      'agent-UI Standalone',
      'bundle:hermes',
      'HERMES_BUNDLE_SOURCE',
      'RELEASE_VERIFY_APP_MODE: all',
      'npm test',
      'standalone bootstrap',
      'two-app',
    ]) {
      if (text.includes(stale)) fail(`${rel} still references removed surface ${stale}`);
    }
  }
}

verifyPackageScripts();
verifyPackagingModes();
verifyGatewayEnvContract();
verifyEvalSurface();
verifyInstalledSmokeContract();
verifyInteractionSmokeContract();
verifyBuildOutputs();
verifyPublicSurface();

console.log('[agent-ui] source contract checks passed');
