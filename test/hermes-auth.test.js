'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractUserCode,
  extractUrls,
  isAuthErrorText,
  readinessFromSnapshot,
} = require('../src/main/hermes-auth');

test('isAuthErrorText detects Hermes provider setup failures', () => {
  assert.equal(isAuthErrorText('Provider authentication failed: No inference provider configured. Run `hermes model`.'), true);
  assert.equal(isAuthErrorText("Run 'hermes model' to choose a provider and model."), true);
  assert.equal(isAuthErrorText('Primary provider auth failed: API key is missing.'), true);
  assert.equal(isAuthErrorText('Hermes event replay window expired.'), false);
});

test('readinessFromSnapshot separates auth and model setup states', () => {
  assert.deepEqual(readinessFromSnapshot({ ok: true, ready: true }), { ready: true, reason: 'ready' });
  assert.deepEqual(readinessFromSnapshot({ ok: true, needs_auth: true }), { ready: false, reason: 'needs_auth' });
  assert.deepEqual(readinessFromSnapshot({ ok: true, needs_model: true }), { ready: false, reason: 'needs_model' });
  assert.deepEqual(readinessFromSnapshot({ ok: false }), { ready: false, reason: 'status_error' });
});

test('extractUrls returns unique browser links from Hermes auth output', () => {
  assert.deepEqual(
    extractUrls('Open: https://auth.openai.com/codex/device\nAgain: https://auth.openai.com/codex/device.'),
    ['https://auth.openai.com/codex/device']
  );
});

test('OpenAI Codex ANSI-colored device output is cleaned for link and code extraction', () => {
  const output = [
    'To continue, follow these steps:\n',
    '  1. Open this URL in your browser:',
    '     \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n',
    '  2. Enter this code:',
    '     \u001b[94mABCD-EFGH\u001b[0m\n',
  ].join('\n');

  assert.deepEqual(extractUrls(output), ['https://auth.openai.com/codex/device']);
  assert.equal(extractUserCode(output), 'ABCD-EFGH');
});
