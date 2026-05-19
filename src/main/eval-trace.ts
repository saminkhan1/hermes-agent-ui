'use strict';

import fs from 'node:fs';
import path from 'node:path';

const enabled = process.env.AGENT_UI_EVAL === '1';
const runId =
  String(process.env.AGENT_UI_EVAL_RUN_ID || '').trim() || `manual-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const baseDir = path.resolve(process.env.AGENT_UI_EVAL_DIR || path.join(process.cwd(), '.agent-ui-eval'));
const runDir = path.join(baseDir, 'runs', runId);
const traceFile = path.join(runDir, 'trace.jsonl');

/** @type {Array<Record<string, LooseBoundaryValue>>} */
const events: LooseBoundaryValue[] = [];
let seq = 0;
const startedHr = process.hrtime.bigint();

function monotonicMs() {
  return Number(process.hrtime.bigint() - startedHr) / 1e6;
}

function ensureRunDir() {
  if (!enabled) return;
  fs.mkdirSync(runDir, { recursive: true });
}

function safeName(value: LooseBoundaryValue) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function getConversationArtifactDir(conversationId: LooseBoundaryValue) {
  if (!enabled) return null;
  const dir = path.join(runDir, 'conversations', safeName(conversationId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function artifactPath(conversationId: LooseBoundaryValue, relPath: LooseBoundaryValue) {
  const dir = getConversationArtifactDir(conversationId);
  if (!dir) return null;
  const full = path.resolve(path.join(dir, String(relPath || 'artifact')));
  if (full !== dir && !full.startsWith(dir + path.sep)) {
    throw new Error('artifact path escapes conversation directory');
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

function writeArtifactText(conversationId: LooseBoundaryValue, relPath: LooseBoundaryValue, text: LooseBoundaryValue) {
  if (!enabled) return null;
  const file = artifactPath(conversationId, relPath);
  if (!file) return null;
  fs.writeFileSync(file, String(text || ''), 'utf8');
  return file;
}

function writeArtifactJson(conversationId: LooseBoundaryValue, relPath: LooseBoundaryValue, value: LooseBoundaryValue) {
  return writeArtifactText(conversationId, relPath, JSON.stringify(value, null, 2));
}

function recordTrace(type: LooseBoundaryValue, payload = {}) {
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

export { recordTrace, getTrace, getConversationArtifactDir, writeArtifactJson, runId, runDir, traceFile, enabled };
