'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');

function functionBody(name) {
  const start = main.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = main.indexOf('\nfunction ', start + 1);
  return main.slice(start, next === -1 ? main.length : next);
}

test('new session request focuses existing session window instead of replacing it', () => {
  const shortcutBody = functionBody('handleNewCatShortcut');
  const modalBody = functionBody('openNewCatModal');

  assert.match(shortcutBody, /focusExistingSessionWindow\('new_session_shortcut'\)/);
  assert.match(modalBody, /focusExistingSessionWindow\('new_session_requested'\)/);
  assert.doesNotMatch(modalBody, /conversationWindow\.close\(\)/);
  assert.doesNotMatch(modalBody, /modalWindow\.close\(\)/);
});

test('opening a conversation focuses existing session window instead of replacing it', () => {
  const body = functionBody('openConversationWindow');

  assert.match(body, /focusExistingSessionWindow\('conversation_requested'\)/);
  assert.doesNotMatch(body, /modalWindow\.close\(\)/);
  assert.doesNotMatch(body, /conversationWindow\.loadURL\(/);
  assert.doesNotMatch(body, /conversationWindow\.loadFile\(/);
});

test('auth window dismisses without clearing pending auth work', () => {
  const body = functionBody('openHermesAuthWindow');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'auth.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf8');

  assert.match(body, /dismissHermesAuthWindow\(\)/);
  assert.doesNotMatch(body, /pendingAuthRun = null/);
  assert.match(renderer, /dismissHermesAuth/);
  assert.doesNotMatch(renderer.match(/async function closeWindow\(\) \{[\s\S]*?\n\}/)[0], /cancelOAuth\(\)/);
  assert.match(preload, /dismissHermesAuth/);
});

test('auth browser handoff has monitor recovery and fallback menu copy', () => {
  const authHelpers = main.slice(main.indexOf('function idleAuthFlow'), main.indexOf('function getPetOverlayStatePath'));
  const menuBody = functionBody('hermesLoginMenuItem');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'auth.html'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf8');

  assert.match(authHelpers, /AUTH_MONITOR_INTERVAL_MS/);
  assert.match(authHelpers, /AUTH_STALE_MS/);
  assert.match(authHelpers, /checkHermesAuthFlow/);
  assert.match(authHelpers, /showHermesAuthWindowForState\('auth-success'\)/);
  assert.match(authHelpers, /showHermesAuthWindowForState\('auth-stale'\)/);
  assert.match(authHelpers, /showHermesAuthWindowForState\('auth-status-failed'\)/);
  assert.match(menuBody, /Return to Hermes Sign-In/);
  assert.match(html, /btn-check-oauth/);
  assert.match(html, /btn-retry-oauth/);
  assert.match(preload, /checkHermesAuthNow/);
});

test('auth finish resumes follow-up retries without duplicating user input', () => {
  const start = main.indexOf("trustedIpcHandle('hermes-auth-finish'");
  const end = main.indexOf("trustedIpcOn('hermes-auth-close'", start);
  assert.notEqual(start, -1, 'hermes-auth-finish handler exists');
  assert.notEqual(end, -1, 'hermes-auth-finish handler end exists');
  const body = main.slice(start, end);

  assert.match(body, /pending\.retryKind/);
  assert.match(body, /sendFollowup\(pending\.catId, boundedText\(pending\.prompt\)/);
  assert.match(body, /recordUserItem: false/);
  assert.match(body, /launchPreparedCatRun\(pending/);
});

test('privileged preload is bound to trusted renderer origins', () => {
  assert.match(main, /function trustedRendererDevBaseUrl/);
  assert.match(main, /app\.isPackaged/);
  assert.match(main, /function isLoopbackHost/);
  assert.match(main, /function isTrustedRendererUrl/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /will-navigate/);
  assert.match(main, /function isTrustedIpcEvent/);
  assert.match(main, /function trustedIpcHandle/);
  assert.match(main, /trustedIpcHandle\('open-external-url'/);
  assert.doesNotMatch(main, /if \(process\.env\.ELECTRON_RENDERER_URL\)/);
});

test('global quit shortcut is not registered', () => {
  assert.match(main, /globalShortcut\.register\(newCatAccelerator/);
  assert.doesNotMatch(main, /globalShortcut\.register\('Command\+Q'/);
  assert.doesNotMatch(main, /globalShortcut\.register\('Control\+Q'/);
});

test('gateway replay hydration is pushed into the overlay on launch', () => {
  assert.match(main, /hydrateGatewayConversations\(\{ getMainWindow: \(\) => mainWindow, log: console \}\)/);
  assert.match(main, /function sendConversationToOverlay/);
  assert.match(main, /sendConversationToOverlay\(_id\)/);
});
