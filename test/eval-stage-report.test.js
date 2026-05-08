'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildStageReportFromRuns,
  markdownReport,
  summarizeValues,
} = require('../scripts/eval-stage-report');

test('stage report summarizes app and Hermes timing stages from eval trace events', () => {
  const report = buildStageReportFromRuns([{
    file: '/tmp/trace.jsonl',
    events: [
      { type: 'app_ready', runId: 'customer-path-run-1', seq: 1, tRelMs: 100, uptimeMs: 120 },
      { type: 'shortcut_invoked', runId: 'customer-path-run-1', seq: 2, tRelMs: 180, modalContextId: 'modal-1' },
      { type: 'context_capture_started', runId: 'customer-path-run-1', seq: 3, tRelMs: 200, modalContextId: 'modal-1' },
      { type: 'context_capture_completed', runId: 'customer-path-run-1', seq: 4, tRelMs: 260, modalContextId: 'modal-1', durationMs: 60 },
      { type: 'modal_show_requested', runId: 'customer-path-run-1', seq: 5, tRelMs: 270, modalContextId: 'modal-1' },
      { type: 'modal_shown_and_focused', runId: 'customer-path-run-1', seq: 6, tRelMs: 330, modalContextId: 'modal-1' },
      { type: 'submit_requested', runId: 'customer-path-run-1', seq: 7, tRelMs: 500, catId: 'cat-1' },
      { type: 'cat_spawn_rendered', runId: 'customer-path-run-1', seq: 8, tRelMs: 560, catId: 'cat-1' },
      { type: 'gateway_ready_check_completed', runId: 'customer-path-run-1', seq: 9, tRelMs: 620, durationMs: 70, ok: true },
      { type: 'gateway_message_post_requested', runId: 'customer-path-run-1', seq: 10, tRelMs: 650, catId: 'cat-1' },
      { type: 'gateway_message_post_accepted', runId: 'customer-path-run-1', seq: 11, tRelMs: 710, catId: 'cat-1', durationMs: 60 },
      { type: 'gateway_first_event', runId: 'customer-path-run-1', seq: 12, tRelMs: 760, catId: 'cat-1', msSincePostAccepted: 50 },
      { type: 'terminal_state_rendered', runId: 'customer-path-run-1', seq: 13, tRelMs: 1000, catId: 'cat-1', durationMs: 500, status: 'completed' },
    ],
  }], { minRuns: 1 });

  const byId = new Map(report.stages.map((stage) => [stage.id, stage]));
  assert.equal(byId.get('shortcut_to_modal_visible_ms').p50Ms, 150);
  assert.equal(byId.get('context_capture_ms').p50Ms, 60);
  assert.equal(byId.get('modal_visible_ms').p50Ms, 60);
  assert.equal(byId.get('submit_to_pet_ms').p50Ms, 60);
  assert.equal(byId.get('submit_to_gateway_accepted_ms').p50Ms, 210);
  assert.equal(byId.get('gateway_post_ms').p50Ms, 60);
  assert.equal(byId.get('first_gateway_event_ms').p50Ms, 50);
  assert.equal(byId.get('conversation_terminal_ms').p50Ms, 500);
  assert.equal(byId.get('submit_to_pet_ms').status, 'ok');
  assert.match(markdownReport(report), /Submit to pet visible/);
});

test('stage report flags slow app-owned stages separately from Hermes-owned latency', () => {
  const report = buildStageReportFromRuns([{
    file: '/tmp/trace.jsonl',
    events: [
      { type: 'submit_requested', runId: 'slow-run-1', seq: 1, tRelMs: 100, catId: 'cat-1' },
      { type: 'cat_spawn_rendered', runId: 'slow-run-1', seq: 2, tRelMs: 1800, catId: 'cat-1' },
      { type: 'gateway_message_post_requested', runId: 'slow-run-1', seq: 3, tRelMs: 1900, catId: 'cat-1' },
      { type: 'gateway_message_post_accepted', runId: 'slow-run-1', seq: 4, tRelMs: 4000, catId: 'cat-1', durationMs: 2100 },
    ],
  }], { minRuns: 1 });

  const byId = new Map(report.stages.map((stage) => [stage.id, stage]));
  assert.equal(byId.get('submit_to_pet_ms').status, 'slow_p95');
  assert.equal(byId.get('gateway_post_ms').status, 'ok');
  assert.equal(report.findings.some((finding) => finding.stageId === 'submit_to_pet_ms' && finding.severity === 'warning'), true);
});

test('stage report percentile summary uses nearest-rank values', () => {
  assert.deepEqual(summarizeValues([10, 20, 30, 40, 50]), {
    count: 5,
    minMs: 10,
    p50Ms: 30,
    p95Ms: 50,
    maxMs: 50,
  });
});
