'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { EVENTS, STAGE_DEFS } = require('../src/main/reliability-schema');

const DEFAULT_MIN_RUNS = 5;
const APP_P50_THRESHOLD_MS = 500;
const APP_P95_THRESHOLD_MS = 1500;

function listFromCsv(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function eventTimeMs(event) {
  return numberOrNull(event && event.tRelMs) ?? numberOrNull(event && event.at);
}

function eventKey(event, key) {
  const value = event && event[key] != null ? String(event[key]).trim() : '';
  return value || '__global__';
}

function scenarioFromRunId(runId) {
  const id = String(runId || '').trim() || 'unknown';
  return id
    .replace(/-run-\d+$/i, '')
    .replace(/-run\d+$/i, '')
    .replace(/-\d+$/i, '');
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[idx];
}

function summarizeValues(values) {
  const clean = values
    .map(numberOrNull)
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  if (!clean.length) {
    return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  return {
    count: clean.length,
    minMs: clean[0],
    p50Ms: percentile(clean, 50),
    p95Ms: percentile(clean, 95),
    maxMs: clean[clean.length - 1],
  };
}

function readTraceFile(file) {
  const events = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const [idx, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch (error) {
      throw new Error(`${file}:${idx + 1}: invalid trace JSON: ${error && error.message ? error.message : error}`, {
        cause: error,
      });
    }
  }
  return events;
}

function walkTraceFiles(dir, out) {
  if (!fs.existsSync(dir)) return;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (path.basename(dir) === 'trace.jsonl' || dir.endsWith('.jsonl')) out.push(path.resolve(dir));
    return;
  }
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const childStat = fs.statSync(full);
    if (childStat.isDirectory()) {
      walkTraceFiles(full, out);
    } else if (entry === 'trace.jsonl' || entry.endsWith('.jsonl')) {
      out.push(path.resolve(full));
    }
  }
}

function discoverTraceFiles(inputs = []) {
  const out = [];
  const targets = inputs.length
    ? inputs
    : [process.env.AGENT_UI_EVAL_DIR || path.join(process.cwd(), '.agent-ui-eval')];
  for (const target of targets) {
    walkTraceFiles(path.resolve(String(target)), out);
  }
  return [...new Set(out)];
}

function addSample(samples, stageId, run, value, meta = {}) {
  const durationMs = numberOrNull(value);
  if (durationMs == null || durationMs < 0) return;
  samples.push({
    stageId,
    durationMs,
    runId: run.runId,
    scenario: run.scenario,
    traceFile: run.file,
    ...meta,
  });
}

function firstEventsByKey(events, type, key) {
  const map = new Map();
  for (const event of events) {
    if (event.type !== type) continue;
    const k = eventKey(event, key);
    if (!map.has(k)) map.set(k, event);
  }
  return map;
}

function addPairedSamples(samples, run, stageId, startType, endType, key) {
  const starts = firstEventsByKey(run.events, startType, key);
  const consumed = new Set();
  for (const end of run.events) {
    if (end.type !== endType) continue;
    const k = eventKey(end, key);
    if (consumed.has(k)) continue;
    const start = starts.get(k);
    if (!start) continue;
    const startMs = eventTimeMs(start);
    const endMs = eventTimeMs(end);
    if (startMs == null || endMs == null || endMs < startMs) continue;
    addSample(samples, stageId, run, endMs - startMs, { key: k });
    consumed.add(k);
  }
}

function normalizeRun(file, events) {
  const first = events.find((event) => event && event.runId);
  const runId = String((first && first.runId) || path.basename(path.dirname(file)) || 'unknown');
  return {
    file,
    runId,
    scenario: scenarioFromRunId(runId),
    events: events.slice().sort((a, b) => {
      const left = numberOrNull(a.seq) ?? eventTimeMs(a) ?? 0;
      const right = numberOrNull(b.seq) ?? eventTimeMs(b) ?? 0;
      return left - right;
    }),
  };
}

function collectSamples(runs) {
  const samples = [];
  for (const run of runs) {
    for (const event of run.events) {
      if (event.type === EVENTS.APP_READY)
        addSample(samples, 'app_ready_ms', run, numberOrNull(event.uptimeMs) ?? eventTimeMs(event));
      if (event.type === EVENTS.CONTEXT_CAPTURE_COMPLETED)
        addSample(samples, 'context_capture_ms', run, event.durationMs, {
          modalContextId: event.modalContextId || null,
        });
      if (event.type === EVENTS.GATEWAY_READY_CHECK_COMPLETED)
        addSample(samples, 'gateway_ready_ms', run, event.durationMs, { ok: event.ok !== false });
      if (event.type === EVENTS.GATEWAY_MESSAGE_POST_ACCEPTED) {
        addSample(samples, 'gateway_post_ms', run, event.durationMs, { catId: event.catId || null });
      }
      if (event.type === EVENTS.GATEWAY_FIRST_EVENT) {
        addSample(samples, 'first_gateway_event_ms', run, event.msSincePostAccepted, {
          catId: event.catId || null,
          gatewayEventType: event.gatewayEventType || null,
        });
      }
      if (event.type === EVENTS.VOICE_SESSION_TRANSCRIPT_READY) {
        const deterministic = event.deterministic === true;
        addSample(samples, 'voice_recording_ms', run, event.recordingMs ?? (deterministic ? 0 : null), {
          modalContextId: event.modalContextId || null,
        });
        addSample(samples, 'voice_transcribing_ms', run, event.transcribingMs ?? (deterministic ? 0 : null), {
          modalContextId: event.modalContextId || null,
        });
        addSample(samples, 'voice_transcript_ms', run, event.durationMs, {
          modalContextId: event.modalContextId || null,
        });
      }
      if (event.type === EVENTS.TERMINAL_STATE_RENDERED)
        addSample(samples, 'conversation_terminal_ms', run, event.durationMs, {
          catId: event.catId || null,
          status: event.status || null,
        });
      if (event.type === EVENTS.GATEWAY_HYDRATION_COMPLETED)
        addSample(samples, 'quit_reopen_hydration_ms', run, event.durationMs, {
          ok: event.ok !== false,
          resetLastSeq: !!event.resetLastSeq,
        });
    }
    addPairedSamples(
      samples,
      run,
      'modal_visible_ms',
      EVENTS.MODAL_SHOW_REQUESTED,
      EVENTS.MODAL_SHOWN_AND_FOCUSED,
      'modalContextId',
    );
    addPairedSamples(
      samples,
      run,
      'shortcut_to_modal_visible_ms',
      EVENTS.SHORTCUT_INVOKED,
      EVENTS.MODAL_SHOWN_AND_FOCUSED,
      'modalContextId',
    );
    addPairedSamples(samples, run, 'submit_to_pet_ms', EVENTS.SUBMIT_REQUESTED, EVENTS.CAT_SPAWN_RENDERED, 'catId');
    addPairedSamples(
      samples,
      run,
      'submit_to_gateway_accepted_ms',
      EVENTS.SUBMIT_REQUESTED,
      EVENTS.GATEWAY_MESSAGE_POST_ACCEPTED,
      'catId',
    );
    addPairedSamples(
      samples,
      run,
      'auth_window_visible_ms',
      EVENTS.AUTH_WINDOW_REQUESTED,
      EVENTS.AUTH_WINDOW_SHOWN_AND_FOCUSED,
      'catId',
    );
    addPairedSamples(
      samples,
      run,
      'auth_handoff_ms',
      EVENTS.GATEWAY_MESSAGE_POST_FAILED,
      EVENTS.AUTH_HANDOFF_REQUESTED,
      'catId',
    );
  }
  return samples;
}

function stageStatus(def, summary, opts) {
  if (!summary.count) return 'missing';
  if (def.owner === 'app') {
    if (summary.p95Ms != null && summary.p95Ms > opts.appP95ThresholdMs) return 'slow_p95';
    if (summary.p50Ms != null && summary.p50Ms > opts.appP50ThresholdMs) return 'slow_p50';
  }
  if (summary.count < opts.minRuns) return 'needs_more_runs';
  return 'ok';
}

function buildStageReportFromRuns(inputRuns, opts = {}) {
  const requiredStageIds = new Set(listFromCsv(opts.requiredStageIds));
  const options = {
    minRuns: Math.max(1, Math.trunc(Number(opts.minRuns) || DEFAULT_MIN_RUNS)),
    appP50ThresholdMs: Math.max(0, Number(opts.appP50ThresholdMs) || APP_P50_THRESHOLD_MS),
    appP95ThresholdMs: Math.max(0, Number(opts.appP95ThresholdMs) || APP_P95_THRESHOLD_MS),
    requiredStageIds: [...requiredStageIds],
  };
  const runs = inputRuns.map((run) => normalizeRun(run.file || 'trace.jsonl', run.events || []));
  const samples = collectSamples(runs);
  const stages = STAGE_DEFS.map((def) => {
    const stageSamples = samples.filter((sample) => sample.stageId === def.id);
    const summary = summarizeValues(stageSamples.map((sample) => sample.durationMs));
    const scenarios = {};
    for (const sample of stageSamples) {
      scenarios[sample.scenario] = (scenarios[sample.scenario] || 0) + 1;
    }
    return {
      ...def,
      ...summary,
      required: requiredStageIds.has(def.id),
      status: stageStatus(def, summary, options),
      scenarios,
      samples: stageSamples,
    };
  });
  const findings = [];
  for (const stage of stages) {
    if (stage.status === 'missing') {
      findings.push({
        severity: stage.required ? 'error' : 'info',
        stageId: stage.id,
        message: `${stage.label} has no samples.`,
      });
    } else if (stage.status === 'slow_p50') {
      findings.push({
        severity: 'warning',
        stageId: stage.id,
        message: `${stage.label} app-owned p50 is ${stage.p50Ms}ms.`,
      });
    } else if (stage.status === 'slow_p95') {
      findings.push({
        severity: 'warning',
        stageId: stage.id,
        message: `${stage.label} app-owned p95 is ${stage.p95Ms}ms.`,
      });
    }
    if (stage.count > 0 && stage.count < options.minRuns) {
      findings.push({
        severity: 'info',
        stageId: stage.id,
        message: `${stage.label} has ${stage.count} sample(s); target is ${options.minRuns}.`,
      });
    }
  }
  const ok = !findings.some((finding) => finding.severity === 'error');
  return {
    ok,
    generatedAt: new Date().toISOString(),
    thresholds: options,
    runCount: runs.length,
    traceFiles: runs.map((run) => run.file),
    stages,
    findings,
  };
}

function buildStageReportFromTraceFiles(files, opts = {}) {
  const runs = files.map((file) => ({ file, events: readTraceFile(file) }));
  return buildStageReportFromRuns(runs, opts);
}

function markdownReport(report) {
  const lines = [
    '# Agent UI Stage Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Runs: ${report.runCount}`,
    '',
    '| Stage | Owner | Count | p50 ms | p95 ms | Status |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ];
  for (const stage of report.stages) {
    lines.push(
      `| ${stage.label} | ${stage.owner} | ${stage.count} | ${stage.p50Ms ?? ''} | ${stage.p95Ms ?? ''} | ${stage.status} |`,
    );
  }
  if (report.findings.length) {
    lines.push('', '## Findings');
    for (const finding of report.findings) {
      lines.push(`- ${finding.severity}: ${finding.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseCliArgs(argv) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: {
      markdown: { type: 'boolean' },
      json: { type: 'boolean' },
      strict: { type: 'boolean', default: false },
      out: { type: 'string', default: '' },
      'min-runs': { type: 'string', default: String(DEFAULT_MIN_RUNS) },
      'require-stage': { type: 'string', default: process.env.AGENT_UI_REQUIRED_STAGE_IDS || '' },
    },
  });
  let format = 'json';
  for (const token of parsed.tokens) {
    if (token.kind === 'option' && (token.name === 'markdown' || token.name === 'json')) {
      format = token.name === 'markdown' ? 'markdown' : 'json';
    }
  }
  return {
    inputs: parsed.positionals,
    format,
    out: parsed.values.out || '',
    minRuns: Math.max(1, Math.trunc(Number(parsed.values['min-runs']) || DEFAULT_MIN_RUNS)),
    requiredStageIds: listFromCsv(parsed.values['require-stage']),
    strict: !!parsed.values.strict,
  };
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));
  const files = discoverTraceFiles(args.inputs);
  const report = buildStageReportFromTraceFiles(files, {
    minRuns: args.minRuns,
    requiredStageIds: args.requiredStageIds,
  });
  const output = args.format === 'markdown' ? markdownReport(report) : `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, output, 'utf8');
  } else {
    process.stdout.write(output);
  }
  if (
    args.strict &&
    report.findings.some((finding) => finding.severity === 'warning' || finding.severity === 'error')
  ) {
    process.exitCode = 1;
  }
}

module.exports = {
  buildStageReportFromRuns,
  buildStageReportFromTraceFiles,
  collectSamples,
  discoverTraceFiles,
  listFromCsv,
  markdownReport,
  readTraceFile,
  summarizeValues,
};
