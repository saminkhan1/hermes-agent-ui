'use strict';

const fs = require('fs');
const path = require('path');

const enabled = process.env.AGENT_UI_EVAL === '1';
const runId =
  String(process.env.AGENT_UI_EVAL_RUN_ID || '').trim() ||
  `manual-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const baseDir = path.resolve(process.env.AGENT_UI_EVAL_DIR || path.join(process.cwd(), '.agent-ui-eval'));
const runDir = path.join(baseDir, 'runs', runId);
const traceFile = path.join(runDir, 'trace.jsonl');

/** @type {Array<Record<string, unknown>>} */
const events: any[] = [];
let seq = 0;
const startedHr = process.hrtime.bigint();

function monotonicMs() {
  return Number(process.hrtime.bigint() - startedHr) / 1e6;
}

function ensureRunDir() {
  if (!enabled) return;
  fs.mkdirSync(runDir, { recursive: true });
}

function safeName(value: any) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function getCatArtifactDir(catId: any) {
  if (!enabled) return null;
  const dir = path.join(runDir, 'cats', safeName(catId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function artifactPath(catId: any, relPath: any) {
  const dir = getCatArtifactDir(catId);
  if (!dir) return null;
  const full = path.resolve(path.join(dir, String(relPath || 'artifact')));
  if (full !== dir && !full.startsWith(dir + path.sep)) {
    throw new Error('artifact path escapes cat directory');
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

function writeArtifactText(catId: any, relPath: any, text: any) {
  if (!enabled) return null;
  const file = artifactPath(catId, relPath);
  fs.writeFileSync(file, String(text || ''), 'utf8');
  return file;
}

function appendArtifactText(catId: any, relPath: any, text: any) {
  if (!enabled) return null;
  const file = artifactPath(catId, relPath);
  fs.appendFileSync(file, String(text || ''), 'utf8');
  return file;
}

function writeArtifactJson(catId: any, relPath: any, value: any) {
  return writeArtifactText(catId, relPath, JSON.stringify(value, null, 2));
}

function appendArtifactJsonl(catId: any, relPath: any, value: any) {
  return appendArtifactText(catId, relPath, `${JSON.stringify(value)}\n`);
}

function recordTrace(type: any, payload = {}) {
  if (!enabled) return null;
  const event = {
    type: String(type || 'event'),
    at: Date.now(),
    tRelMs: Math.round(monotonicMs() * 1000) / 1000,
    seq: ++seq,
    runId,
    ...(payload && typeof payload === 'object' ? payload : {}),
  };
  events.push(event);
  try {
    ensureRunDir();
    fs.appendFileSync(traceFile, `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    /* tracing must never break the app */
  }
  return event;
}

function getTrace() {
  return {
    ok: true,
    enabled,
    runId,
    runDir,
    traceFile,
    events: events.slice(),
  };
}

function resetTrace() {
  events.length = 0;
  seq = 0;
  if (!enabled) return;
  try {
    ensureRunDir();
    fs.writeFileSync(traceFile, '', 'utf8');
  } catch {
    /* ignore */
  }
}

module.exports = {
  recordTrace,
  getTrace,
  resetTrace,
  getCatArtifactDir,
  artifactPath,
  writeArtifactText,
  appendArtifactText,
  writeArtifactJson,
  appendArtifactJsonl,
  runId,
  runDir,
  traceFile,
  enabled,
};
