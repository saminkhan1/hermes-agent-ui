'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

test('reliability event schema is centralized outside product flow modules', () => {
  const main = read('src/main/index.ts');
  const agents = read('src/main/agents.ts');
  const telemetry = read('src/main/reliability-telemetry.ts');
  const report = read('scripts/eval-stage-report.js');

  assert.doesNotMatch(main, /recordTrace\(/);
  assert.doesNotMatch(agents, /recordTrace\(/);
  assert.match(telemetry, /recordTrace\(/);
  assert.match(report, /reliability-schema/);
});

test('stage definitions preserve owner separation for customer reports', () => {
  const { STAGE_DEFS } = require('../src/main/reliability-schema');
  const byId = new Map(STAGE_DEFS.map((stage) => [stage.id, stage]));

  assert.equal(byId.get('shortcut_to_modal_visible_ms').owner, 'app');
  assert.equal(byId.get('submit_to_pet_ms').owner, 'app');
  assert.equal(byId.get('gateway_ready_ms').owner, 'hermes_boundary');
  assert.equal(byId.get('conversation_terminal_ms').owner, 'hermes_provider');
});

test('external reliability sinks receive scrubbed payloads', () => {
  const { _test } = require('../src/main/reliability-telemetry');

  const event = _test.externalEvent('voice_final_transcript', {
    transcript: 'private dictated prompt',
    prompt: { preview: 'open this customer page', chars: 23 },
    error: 'provider unavailable',
    catId: 'cat-1',
  });

  assert.equal(event.transcript, '[redacted]');
  assert.equal(event.prompt, '[redacted]');
  assert.equal(event.error, 'provider unavailable');
  assert.equal(event.catId, 'cat-1');
});
