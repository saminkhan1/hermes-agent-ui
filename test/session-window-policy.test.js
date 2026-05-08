'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

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

test('launcher opens before live context capture finishes', () => {
  const body = functionBody('handleNewCatShortcut');
  const openIndex = body.indexOf('openNewCatModal(modalContextId, inputMode)');
  const captureIndex = body.indexOf('startLaunchContextCapture(source, modalContextId)');

  assert.notEqual(openIndex, -1, 'shortcut opens modal');
  assert.notEqual(captureIndex, -1, 'shortcut starts async context capture');
  assert.ok(openIndex < captureIndex, 'modal opens before async context capture starts');
  assert.doesNotMatch(body, /await captureLaunchContext/);
});

test('opening a conversation reuses the session window for the requested conversation', () => {
  const body = functionBody('openConversationWindow');
  const reuseBody = functionBody('showExistingConversationWindow');

  assert.match(body, /showExistingConversationWindow\(q\.catId\)/);
  assert.match(reuseBody, /activeConversationCatId = id/);
  assert.match(reuseBody, /loadTrustedRendererPage\(conversationWindow, 'conversation\.html', \{ catId: id \}\)/);
  assert.doesNotMatch(body, /modalWindow\.close\(\)/);
  assert.doesNotMatch(body, /conversationWindow\.loadURL\(/);
  assert.doesNotMatch(body, /conversationWindow\.loadFile\(/);
});

test('eval UI targets keep live window state authoritative over stale snapshots', () => {
  const body = functionBody('getEvalUiTargets');

  assert.match(body, /modal: \{[\s\S]*\.\.\.modal,[\s\S]*\.\.\.evalWindowState\(modalWindow\)/);
  assert.match(body, /conversation: \{[\s\S]*\.\.\.conversation,[\s\S]*\.\.\.evalWindowState\(conversationWindow\)/);
  assert.match(body, /overlay: \{[\s\S]*\.\.\.overlay,[\s\S]*\.\.\.evalWindowState\(mainWindow\)/);
});

test('overlay and session windows stay compatible with display screen sharing', () => {
  const compatibilityBody = functionBody('applyScreenShareCompatibilityPolicy');
  const overlayPolicyBody = functionBody('applyOverlayWindowPolicy');
  const activeWindowBody = functionBody('readActiveWindowSnapshot');

  assert.match(compatibilityBody, /setContentProtection\(false\)/);
  assert.match(overlayPolicyBody, /applyScreenShareCompatibilityPolicy\(win\)/);
  assert.match(activeWindowBody, /screenRecordingPermission: false/);
  assert.doesNotMatch(main, /setContentProtection\(true\)/);
  assert.doesNotMatch(main, /desktopCapturer|getDisplayMedia|ScreenCaptureKit/);
});

test('auth window dismisses without clearing pending auth work', () => {
  const body = functionBody('openHermesAuthWindow');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'auth.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.ts'), 'utf8');

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
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.ts'), 'utf8');

  assert.match(authHelpers, /AUTH_MONITOR_INTERVAL_MS/);
  assert.match(authHelpers, /AUTH_STALE_MS/);
  assert.match(authHelpers, /checkHermesAuthFlow/);
  assert.match(authHelpers, /showHermesAuthWindowForState\('auth-success'\)/);
  assert.match(authHelpers, /showHermesAuthWindowForState\('auth-stale'\)/);
  assert.match(authHelpers, /showHermesAuthWindowForState\('auth-status-failed'\)/);
  assert.match(menuBody, /Continue Hermes Sign-In/);
  assert.match(menuBody, /Sign In to Hermes/);
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

test('new session entry points are available before startup gateway hydration', () => {
  const readyStart = main.indexOf('app.whenReady().then');
  assert.notEqual(readyStart, -1, 'app ready startup block exists');
  const readyBody = main.slice(readyStart);
  const registerIndex = readyBody.indexOf('registerNewCatShortcut()');
  const evalServerIndex = readyBody.indexOf('startEvalServerIfNeeded()');
  const prewarmIndex = readyBody.indexOf('prewarmGatewayReady');
  const hydrationIndex = readyBody.indexOf('hydrateGatewayConversations');

  assert.notEqual(registerIndex, -1, 'shortcut is registered during startup');
  assert.notEqual(evalServerIndex, -1, 'eval launcher server starts during startup');
  assert.notEqual(prewarmIndex, -1, 'gateway prewarm still starts during startup');
  assert.notEqual(hydrationIndex, -1, 'gateway hydration still starts during startup');
  assert.ok(registerIndex < prewarmIndex, 'shortcut is registered before gateway prewarm');
  assert.ok(evalServerIndex < prewarmIndex, 'eval launcher starts before gateway prewarm');
  assert.ok(prewarmIndex < hydrationIndex, 'gateway prewarm still precedes hydration');
  assert.doesNotMatch(main, /sessionEntryReady/);
  assert.doesNotMatch(main, /startup gateway readiness still pending/);
});

test('gateway replay hydration is pushed into the overlay on launch', () => {
  assert.match(main, /hydrateGatewayConversations\(\{ getMainWindow: \(\) => mainWindow, log: console \}\)/);
  assert.match(main, /function sendConversationToOverlay/);
  assert.match(main, /sendConversationToOverlay\(_id\)/);
});
