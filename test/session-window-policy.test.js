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
