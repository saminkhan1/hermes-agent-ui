#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EVAL_DIR = path.join(ROOT, '.agent-ui-eval', 'runs');

function fail(message) {
  console.error(`[validate-trace] ${message}`);
  process.exit(1);
}

function latestRunDir() {
  const explicit = process.env.AGENT_UI_EVAL_RUN_DIR;
  if (explicit) return explicit;
  if (!fs.existsSync(EVAL_DIR)) fail(`missing eval run directory: ${EVAL_DIR}`);
  const dirs = fs.readdirSync(EVAL_DIR)
    .map((name) => path.join(EVAL_DIR, name))
    .filter((p) => fs.statSync(p).isDirectory())
    .filter((p) => {
      const trace = path.join(p, 'trace.jsonl');
      const results = path.join(p, 'results.json');
      if (!fs.existsSync(trace) || fs.statSync(trace).size <= 0) return false;
      if (!fs.existsSync(results)) return false;
      try {
        const data = JSON.parse(fs.readFileSync(results, 'utf8'));
        return Array.isArray(data.results) && data.results.some((r) => r && r.catId && r.status);
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!dirs.length) fail('no completed eval runs with trace output found');
  return dirs[0];
}

function readJsonl(file) {
  if (!fs.existsSync(file)) fail(`missing trace file: ${file}`);
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        fail(`invalid JSONL at ${file}:${idx + 1}: ${e.message}`);
      }
    });
}

const dir = latestRunDir();
const events = readJsonl(path.join(dir, 'trace.jsonl'));
if (!events.length) fail('trace is empty');

for (let i = 0; i < events.length; i++) {
  const event = events[i];
  if (!event || typeof event !== 'object') fail(`event ${i + 1} is not an object`);
  if (typeof event.type !== 'string' || !event.type) fail(`event ${i + 1} has no type`);
  if (!Number.isFinite(Number(event.at))) fail(`event ${i + 1} has invalid timestamp`);
  if (Object.prototype.hasOwnProperty.call(event, 'prompt')) fail(`event ${event.type} contains full prompt content`);
  if (Object.prototype.hasOwnProperty.call(event, 'transcript')) fail(`event ${event.type} contains full transcript content`);
}

const types = new Set(events.map((e) => e.type));
for (const type of [
  'shortcut_received',
  'modal_shown_and_focused',
  'pointer_context_captured',
  'submit_requested',
  'cat_spawn_sent',
  'cat_artifacts_ready',
  'cli_runner_resolved',
  'cli_process_started',
  'terminal_state_rendered',
]) {
  if (!types.has(type)) fail(`missing required trace event: ${type}`);
}

if (types.has('eval_spawn_requested') || types.has('direct_spawn_requested')) {
  fail('trace contains a direct spawn event');
}

for (let i = 1; i < events.length; i++) {
  if (Number(events[i].at) < Number(events[i - 1].at)) {
    fail(`trace timestamp moved backwards at event ${i}`);
  }
}

const spawned = events.filter((e) => e.type === 'cat_spawn_sent' && e.catId).map((e) => String(e.catId));
const terminal = new Set(events.filter((e) => e.type === 'terminal_state_rendered' && e.catId).map((e) => String(e.catId)));
const artifactsReady = new Map(
  events
    .filter((e) => e.type === 'cat_artifacts_ready' && e.catId && e.artifactDir)
    .map((e) => [String(e.catId), e])
);
const submitByCat = new Map(
  events
    .filter((e) => e.type === 'submit_requested' && e.catId)
    .map((e) => [String(e.catId), e])
);
for (const catId of spawned) {
  if (!terminal.has(catId)) fail(`cat ${catId} never reached terminal trace state`);
  const artifactEvent = artifactsReady.get(catId);
  if (!artifactEvent) fail(`cat ${catId} has no artifact-ready trace event`);
  const artifactDir = String(artifactEvent.artifactDir);
  if (!fs.existsSync(artifactDir)) fail(`cat ${catId} artifact directory is missing: ${artifactDir}`);
  for (const rel of ['input.json', 'prompt.txt', 'stdout.log', 'stderr.log', 'conversation.json', 'tool-events.jsonl']) {
    const file = path.join(artifactDir, rel);
    if (!fs.existsSync(file)) fail(`cat ${catId} missing artifact ${rel}`);
  }
  const input = JSON.parse(fs.readFileSync(path.join(artifactDir, 'input.json'), 'utf8'));
  if (String(input.catId || '') !== catId) fail(`cat ${catId} input.json has mismatched catId`);
  if (!input.prompt || !Number.isFinite(Number(input.prompt.bytes))) fail(`cat ${catId} input.json missing prompt metadata`);
  if (!input.userPrompt || input.prompt.sha256 !== input.userPrompt.sha256 || input.prompt.bytes !== input.userPrompt.bytes) {
    fail(`cat ${catId} Hermes prompt differs from user-entered prompt`);
  }
  if (!Array.isArray(input.argsPreview) || !input.argsPreview.includes('-q')) {
    fail(`cat ${catId} input.json does not show Hermes chat -q invocation`);
  }
  if (input.environment && input.environment.ANKI_BASE) {
    const cwdName = path.basename(path.resolve(String(input.cwd || '')));
    const ankiBase = path.resolve(String(input.environment.ANKI_BASE));
    if (cwdName && path.basename(ankiBase) !== cwdName) {
      fail(`cat ${catId} ANKI_BASE is not scoped to its scenario cwd`);
    }
  }
  const submit = submitByCat.get(catId);
  if (!submit || !submit.modalContextId) fail(`cat ${catId} submit event is missing modalContextId`);
}

const knownCats = new Set(spawned);
for (const event of events) {
  if (!event.catId) continue;
  const id = String(event.catId);
  if (event.type !== 'cat_spawn_sent' && !knownCats.has(id)) {
    fail(`event ${event.type} references unknown cat ${id}`);
  }
}

const resultsFile = path.join(dir, 'results.json');
if (fs.existsSync(resultsFile)) {
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  for (const result of results.results || []) {
    if (!result.status) fail(`scenario ${result.name} has no terminal status`);
    if (result.status === 'completed' && result.artifacts) {
      const sessionFile = result.artifacts.hermesSession;
      if (sessionFile && !fs.existsSync(sessionFile)) {
        fail(`scenario ${result.name} completed without hermes-session.json`);
      }
      const oracleFile = result.artifacts.oracle;
      if (oracleFile && !fs.existsSync(oracleFile)) {
        fail(`scenario ${result.name} completed without oracle.json`);
      }
    }
  }
}

console.log(`[validate-trace] ok: ${events.length} events in ${dir}`);
