'use strict';

const { spawnSync } = require('node:child_process');

const mode = String(process.argv[2] || process.env.AGENT_UI_MAC_RELEASE_MODE || 'bootstrap').trim().toLowerCase();

function hasCommand(command) {
  const res = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

function hasDeveloperIdIdentity() {
  if (String(process.env.CSC_LINK || '').trim()) return true;
  const res = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  return res.status === 0 && /"Developer ID Application:/.test(res.stdout || '');
}

function hasNotarizationCredentials() {
  const apiKey = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
  const appleId = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;
  const keychainProfile = process.env.APPLE_KEYCHAIN && process.env.APPLE_KEYCHAIN_PROFILE;
  return !!(apiKey || appleId || keychainProfile);
}

const missing = [];

if (process.platform !== 'darwin') {
  missing.push('macOS host for mac app packaging');
}
if (!hasCommand('uv')) {
  missing.push('uv for bundled Python dependency resolution');
}

if (mode === 'developer-id') {
  if (!hasDeveloperIdIdentity()) {
    missing.push('Developer ID Application signing identity or CSC_LINK/CSC_KEY_PASSWORD');
  }
  if (!hasNotarizationCredentials()) {
    missing.push('Apple notarization credentials');
  }
} else if (mode !== 'bootstrap') {
  missing.push(`known release mode, got ${mode}`);
}

if (missing.length) {
  console.error(`[agent-ui] mac ${mode} packaging requires:`);
  for (const item of missing) console.error(`- ${item}`);
  if (mode === 'developer-id') {
    console.error('[agent-ui] Use the Developer ID workflow with release secrets, or provide these env vars locally.');
  } else {
    console.error('[agent-ui] Bootstrap builds use ad-hoc signing and skip Apple notarization.');
  }
  process.exit(1);
}

if (mode === 'bootstrap') {
  console.log('[agent-ui] bootstrap mac packaging: ad-hoc app signing, no notarization or stapling.');
}
