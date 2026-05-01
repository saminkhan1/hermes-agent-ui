'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { promisify } = require('util');
const { execFile, spawn } = require('child_process');
const {
  recordTrace,
  enabled: evalTraceEnabled,
  getCatArtifactDir,
  writeArtifactText,
  appendArtifactText,
  writeArtifactJson,
  appendArtifactJsonl,
} = require('./eval-trace');

const execFileAsync = promisify(execFile);

/** @typedef {'local'} AgentRuntime */
/** @typedef {{ runtime: AgentRuntime, folder?: string }} AgentTarget */

/** @type {Map<string, import('child_process').ChildProcess & Record<string, unknown>>} */
const active = new Map();

/** @type {Map<string, Record<string, any>>} */
const conversations = new Map();

/** @type {(info: { catId: string, streamBubble?: string | null }) => void} */
let onConversationPushed = () => {};

const DEFAULT_AGENT_MODEL_ID = 'hermes-cli';
const CLI_BIN_ENV = 'AGENT_UI_HERMES_BIN';
const HERMES_SOURCE = 'agent-ui';
const DEFAULT_MAX_TURNS = 90;
const JARVIS_HERMES_DIR = path.join(os.homedir(), 'Documents', 'jarvis');
const JARVIS_HERMES_HOME = path.join(JARVIS_HERMES_DIR, '.aura', 'hermes-home');
const SEARCH_EXECUTABLE_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  '/usr/bin',
  '/bin',
];

function setOnConversationPushed(fn) {
  onConversationPushed = typeof fn === 'function' ? fn : () => {};
}

function now() {
  return Date.now();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function preview(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function textMeta(value, max = 180) {
  const text = String(value || '');
  return {
    bytes: Buffer.byteLength(text),
    chars: text.length,
    sha256: sha256(text),
    preview: preview(text, max),
  };
}

function appendJsonlSafe(catId, relPath, value) {
  try {
    return appendArtifactJsonl(catId, relPath, value);
  } catch {
    return null;
  }
}

function writeJsonSafe(catId, relPath, value) {
  try {
    return writeArtifactJson(catId, relPath, value);
  } catch {
    return null;
  }
}

function writeTextSafe(catId, relPath, text) {
  try {
    return writeArtifactText(catId, relPath, text);
  } catch {
    return null;
  }
}

function appendTextSafe(catId, relPath, text) {
  try {
    return appendArtifactText(catId, relPath, text);
  } catch {
    return null;
  }
}

function normalizeRuntime() {
  return 'local';
}

function normalizeAgentTarget({ folder } = {}) {
  return {
    runtime: 'local',
    folder: String(folder || ''),
  };
}

function sameAgentTarget(entry, target, modelId) {
  return !!entry && entry.modelId === modelId && entry.folder === target.folder;
}

function getConversationLocationLabel(rec) {
  return rec && rec.folder ? rec.folder : '';
}

function leadAssistantBubbleText(fullText) {
  const raw = String(fullText || '').trim();
  if (!raw) return null;
  const para = raw.indexOf('\n\n');
  const head = para >= 0 ? raw.slice(0, para) : raw;
  const firstLine = head.split('\n')[0].trim();
  if (!firstLine) return null;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function finishBubbleLineFromConversation(rec) {
  if (!rec || !Array.isArray(rec.items)) return undefined;
  for (let i = rec.items.length - 1; i >= 0; i--) {
    const it = rec.items[i];
    if (it && it.kind === 'assistant' && it.text) {
      const line = leadAssistantBubbleText(it.text);
      if (line) return line;
    }
  }
  return undefined;
}

function getNotify(getMainWindow) {
  return (payload) => {
    const win = getMainWindow && getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent-finished', payload);
    }
  };
}

function notifyRestarted(getMainWindow, catId) {
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent-restarted', { catId: String(catId) });
  }
}

async function captureGitSnapshotForFolder(folder, log = console) {
  const f = String(folder || '').trim();
  if (!f) return null;
  try {
    const { stdout: inTree } = await execFileAsync('git', ['-C', f, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    });
    if (String(inTree).trim() !== 'true') return null;
  } catch {
    return null;
  }
  let headSha = null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', f, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    headSha = String(stdout || '').trim() || null;
  } catch {
    headSha = null;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-git-'));
  const indexFile = path.join(tmp, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: f, env, encoding: 'utf8' });
    const { stdout: treeOut } = await execFileAsync('git', ['write-tree'], { cwd: f, env, encoding: 'utf8' });
    const tree = String(treeOut || '').trim();
    if (!/^[0-9a-f]{40}$/i.test(tree)) {
      log.warn('captureGitSnapshot: unexpected write-tree output', treeOut);
      return null;
    }
    return { tree, headSha, capturedAt: now() };
  } catch (e) {
    log.warn('captureGitSnapshot failed', e);
    return null;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function revertAgentChanges(catId, opts = {}) {
  const { log = console } = opts;
  const id = String(catId);
  const rec = conversations.get(id);
  if (!rec || !rec.snapshotTree) return { ok: false, error: 'No git snapshot to revert to.' };
  if (rec.reverted) return { ok: false, error: 'Already reverted.' };
  if (String(rec.runStatus || '').toLowerCase() === 'running') {
    return { ok: false, error: 'Agent is still running. Wait for it to finish, then try again.' };
  }
  const folder = String(rec.folder || '').trim();
  if (!folder) return { ok: false, error: 'Missing folder for this cat.' };

  try {
    await execFileAsync('git', ['read-tree', '--reset', '-u', rec.snapshotTree], { cwd: folder, encoding: 'utf8' });
    await execFileAsync('git', ['clean', '-fd'], { cwd: folder, encoding: 'utf8' });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log.warn('revertAgentChanges failed', e);
    rec.revertError = msg;
    persistConversation(id);
    onConversationPushed({ catId: id });
    return { ok: false, error: msg };
  }

  rec.reverted = true;
  rec.revertError = undefined;
  rec.items.push({ kind: 'system', text: 'Changes reverted to the folder state at spawn.', at: now() });
  persistConversation(id);
  onConversationPushed({ catId: id });
  return { ok: true };
}

function terminateHermesProcess(entry) {
  const child = entry && entry.process;
  if (!child || child.killed) return;
  entry.terminating = true;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 1500);
}

async function disposeAgentResources(catId, opts = {}) {
  const { log = console } = opts;
  const id = String(catId);
  const entry = active.get(id);
  if (!entry) return;
  terminateHermesProcess(entry);
  if (entry.runPromise) {
    try {
      await entry.runPromise;
    } catch (e) {
      log.warn('Hermes process cleanup failed', e);
    }
  }
  active.delete(id);
}

function conversationHasAssistantText(rec) {
  return !!(rec && Array.isArray(rec.items) && rec.items.some((it) => it && it.kind === 'assistant' && String(it.text || '').length > 0));
}

function persistConversation(catId) {
  const id = String(catId);
  const rec = conversations.get(id);
  if (!rec) return null;
  return writeJsonSafe(id, 'conversation.json', getAgentConversation(id));
}

function appendAssistantChunk(catId, chunk) {
  const id = String(catId);
  const text = String(chunk || '');
  if (!text) return;
  const rec = conversations.get(id);
  if (!rec) return;
  const pushedAt = now();

  const flushStreamUpdate = (bubbleText, force = false) => {
    const lastPushed = Number(rec.lastStreamPushedAt || 0);
    const shouldPush = force || !lastPushed || pushedAt - lastPushed >= 75;
    const lastPersisted = Number(rec.lastStreamPersistedAt || 0);
    const shouldPersist = force || !lastPersisted || pushedAt - lastPersisted >= 150;
    if (shouldPersist) {
      rec.lastStreamPersistedAt = pushedAt;
      persistConversation(id);
    }
    if (shouldPush) {
      rec.lastStreamPushedAt = pushedAt;
      onConversationPushed({ catId: id, streamBubble: bubbleText });
    }
  };

  const last = rec.items.length ? rec.items[rec.items.length - 1] : null;
  if (last && last.kind === 'assistant' && rec.activeAssistantBubble) {
    last.text = (last.text || '') + text;
    last.at = pushedAt;
    flushStreamUpdate(leadAssistantBubbleText(last.text));
    return;
  }

  rec.items.push({ kind: 'assistant', text, at: pushedAt });
  rec.activeAssistantBubble = true;
  flushStreamUpdate(leadAssistantBubbleText(text), true);
}

function replaceLastAssistantText(catId, text) {
  const id = String(catId);
  const rec = conversations.get(id);
  if (!rec) return;
  const value = String(text || '');
  for (let i = rec.items.length - 1; i >= 0; i--) {
    if (rec.items[i] && rec.items[i].kind === 'assistant') {
      rec.items[i].text = value;
      rec.items[i].at = now();
      rec.activeAssistantBubble = false;
      persistConversation(id);
      onConversationPushed({ catId: id, streamBubble: leadAssistantBubbleText(value) });
      return;
    }
  }
  if (value) rec.items.push({ kind: 'assistant', text: value, at: now() });
  rec.activeAssistantBubble = false;
  persistConversation(id);
  onConversationPushed({ catId: id, streamBubble: leadAssistantBubbleText(value) });
}

function initConversationState(catId, { runtime, folder, prompt, snapshotTree, headShaAtSnapshot, snapshotCapturedAt, pointerContext }) {
  const id = String(catId);
  conversations.set(id, {
    runtime: normalizeRuntime(runtime),
    folder: String(folder || ''),
    prompt: String(prompt || ''),
    pointerContext: pointerContext || null,
    items: prompt ? [{ kind: 'user', text: String(prompt), at: now() }] : [],
    runStatus: 'running',
    activeAssistantBubble: false,
    snapshotTree: snapshotTree || undefined,
    headShaAtSnapshot: headShaAtSnapshot != null ? String(headShaAtSnapshot) : undefined,
    snapshotCapturedAt: snapshotCapturedAt != null ? snapshotCapturedAt : undefined,
    reverted: false,
    revertError: undefined,
    artifactDir: evalTraceEnabled ? getCatArtifactDir(id) : null,
    hermesSessionId: undefined,
  });
  persistConversation(id);
  onConversationPushed({ catId: id });
}

function getAgentConversation(catId) {
  const c = conversations.get(String(catId));
  if (!c) return { found: false, items: [] };
  const hasSnapshot = !!c.snapshotTree;
  return {
    found: true,
    runtime: c.runtime || 'local',
    folder: c.folder,
    locationLabel: getConversationLocationLabel(c),
    prompt: c.prompt,
    items: c.items.map(({ kind, text, at }) => ({ kind, text, at })),
    runStatus: c.runStatus,
    endResult: c.endResult,
    durationMs: c.durationMs,
    canRevert: hasSnapshot,
    reverted: !!c.reverted,
    revertError: c.revertError != null ? String(c.revertError) : null,
    hermesSessionId: c.hermesSessionId || null,
    artifacts: getAgentArtifacts(String(catId)),
    gitBranches: [],
  };
}

function listAgentConversations() {
  return [...conversations.entries()].map(([catId, c]) => ({
    catId,
    found: true,
    runtime: c.runtime || 'local',
    folder: c.folder,
    prompt: c.prompt,
    runStatus: c.runStatus,
    durationMs: c.durationMs,
    startedAt: c.items && c.items.length ? c.items[0].at : c.snapshotCapturedAt || 0,
    hermesSessionId: c.hermesSessionId || null,
    artifacts: getAgentArtifacts(catId),
    canRevert: !!c.snapshotTree,
    reverted: !!c.reverted,
  }));
}

function deleteConversationState(catId) {
  conversations.delete(String(catId));
}

async function dismissAgent(catId, opts = {}) {
  const { getMainWindow, log = console } = opts;
  const id = String(catId);
  await disposeAgentResources(id, { log });
  deleteConversationState(id);
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('remove-cat', { catId: id });
  }
}

async function cancelAgent(catId, opts = {}) {
  const { getMainWindow, log = console } = opts;
  const id = String(catId);
  const entry = active.get(id);
  const rec = conversations.get(id);
  if (!entry && !rec) return { ok: false, error: 'missing cat id' };
  if (entry) terminateHermesProcess(entry);
  if (rec && String(rec.runStatus || '').toLowerCase() === 'running') {
    rec.runStatus = 'cancelled';
    rec.endResult = 'cancelled by user';
    rec.durationMs = rec.startedAt ? now() - rec.startedAt : undefined;
    rec.activeAssistantBubble = false;
    rec.items.push({ kind: 'system', text: 'Run cancelled.', at: now() });
    persistConversation(id);
    onConversationPushed({ catId: id });
  }
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent-finished', {
      catId: id,
      status: 'cancelled',
      result: 'cancelled by user',
      durationMs: rec && rec.durationMs,
      finishBubbleLine: finishBubbleLineFromConversation(rec),
    });
  }
  recordTrace('cancel_completed', { catId: id, ok: true });
  // Let the child close handler finish artifact export if it is still running;
  // dispose after a short grace period to avoid orphaned processes.
  setTimeout(() => {
    const still = active.get(id);
    if (still && still.process) terminateHermesProcess(still);
  }, 1500);
  return { ok: true };
}

function hermesCandidatesFromDir(dir) {
  const root = String(dir || '').trim();
  if (!root) return [];
  return [
    path.join(root, '.aura', 'hermes-agent', '.venv', 'bin', 'hermes'),
    path.join(root, '.aura', 'hermes-agent', 'venv', 'bin', 'hermes'),
    path.join(root, '.venv', 'bin', 'hermes'),
    path.join(root, 'venv', 'bin', 'hermes'),
    path.join(root, '.aura', 'hermes-agent', 'hermes'),
    path.join(root, 'hermes'),
  ];
}

function executableExists(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandHasPathSeparator(command) {
  return String(command || '').includes('/') || String(command || '').includes('\\');
}

function commandBaseName(command) {
  return path.basename(String(command || '').trim()).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

function findExecutable(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return null;
  if (commandHasPathSeparator(cmd)) {
    const abs = path.isAbsolute(cmd) ? cmd : path.resolve(process.cwd(), cmd);
    try {
      if (fs.statSync(abs).isDirectory()) {
        return hermesCandidatesFromDir(abs).find(executableExists) || null;
      }
    } catch {
      /* ignore */
    }
    return executableExists(abs) ? abs : null;
  }

  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .concat(SEARCH_EXECUTABLE_DIRS);
  const seen = new Set();
  for (const dir of dirs) {
    const resolvedDir = path.resolve(dir);
    if (seen.has(resolvedDir)) continue;
    seen.add(resolvedDir);
    const candidate = path.join(resolvedDir, cmd);
    if (executableExists(candidate)) return candidate;
  }
  if (cmd === 'hermes') {
    return hermesCandidatesFromDir(JARVIS_HERMES_DIR).find(executableExists) || null;
  }
  return null;
}

function directoryExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isPathInside(childPath, parentPath) {
  const child = path.resolve(String(childPath || ''));
  const parent = path.resolve(String(parentPath || ''));
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function getHermesHomeForCommand(command) {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  if (!directoryExists(JARVIS_HERMES_HOME)) return null;
  if (isPathInside(command, JARVIS_HERMES_DIR)) return JARVIS_HERMES_HOME;
  return null;
}

function buildHermesEnv(command) {
  const hermesHome = getHermesHomeForCommand(command);
  return {
    ...(hermesHome ? { HERMES_HOME: hermesHome } : {}),
    HERMES_SESSION_SOURCE: HERMES_SOURCE,
  };
}

function buildHermesRunEnv(baseEnv, cwd) {
  const env = { ...(baseEnv || {}) };
  const ankiRoot = process.env.AGENT_UI_EVAL_ANKI_ROOT || process.env.ANKI_BASE || '';
  if (process.env.AGENT_UI_EVAL === '1' && ankiRoot) {
    const root = path.resolve(String(ankiRoot));
    const folderName = path.basename(path.resolve(String(cwd || process.cwd()))) || 'cat';
    env.ANKI_BASE = path.join(root, folderName);
    try {
      fs.mkdirSync(env.ANKI_BASE, { recursive: true });
    } catch {
      /* best effort; Hermes/Anki will report a real failure if it cannot use it */
    }
  }
  return env;
}

function artifactEnvSummary(env) {
  const out = {};
  for (const key of ['HERMES_HOME', 'HERMES_SESSION_SOURCE', 'ANKI_BASE']) {
    if (env && env[key]) out[key] = env[key];
  }
  return out;
}

function buildHermesArgs(prompt, sessionId) {
  const maxTurns = String(process.env.AGENT_UI_HERMES_MAX_TURNS || DEFAULT_MAX_TURNS);
  const args = ['chat', '-q', String(prompt || ''), '--quiet', '--source', HERMES_SOURCE, '--pass-session-id', '--yolo', '--max-turns', maxTurns];
  const sid = String(sessionId || '').trim();
  if (sid) args.push('--resume', sid);
  return args;
}

function buildNoHermesMessage(configured) {
  const configuredMsg = configured ? `${CLI_BIN_ENV} is set to ${configured}. ` : '';
  return `${configuredMsg}agent-UI requires Hermes. Set ${CLI_BIN_ENV} to a Hermes binary or Hermes checkout.`;
}

function getHermesRunner() {
  const configured = String(process.env[CLI_BIN_ENV] || '').trim();
  const requested = configured || 'hermes';
  const resolved = findExecutable(requested);
  if (!resolved) {
    return { displayName: 'Hermes', errorMessage: buildNoHermesMessage(configured) };
  }
  if (commandBaseName(resolved) !== 'hermes') {
    return {
      displayName: 'Hermes',
      errorMessage: `${CLI_BIN_ENV} must point to Hermes, not ${path.basename(resolved)}.`,
      command: resolved,
    };
  }
  return {
    displayName: 'Hermes',
    command: resolved,
    env: buildHermesEnv(resolved),
    configured: !!configured,
  };
}

function extractHermesSessionId(text) {
  const raw = String(text || '');
  const patterns = [
    /\bsession_id:\s*([A-Za-z0-9_-]+)/i,
    /\bsession id:\s*([A-Za-z0-9_-]+)/i,
    /\bSession:\s*([A-Za-z0-9_-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function getHermesCwd(folder) {
  const f = String(folder || '').trim();
  if (!f) return process.cwd();
  try {
    const st = fs.statSync(f);
    if (st.isDirectory()) return f;
  } catch {
    /* ignore */
  }
  return process.cwd();
}

function buildLocalRunPrompt(prompt) {
  // Keep Hermes input exactly what the user typed or dictated. agent-UI may
  // collect folder, pointer, screenshot, and artifact metadata for UI/eval
  // verification, but must not inject hidden context that helps the agent solve
  // the task or changes the user's requested semantics.
  return String(prompt || '');
}

function ensureHermesEntry(catId, target, modelId, pointerContext) {
  const id = String(catId);
  const normalizedTarget = normalizeAgentTarget(target);
  const modelIdStr = String(modelId || '').trim() || DEFAULT_AGENT_MODEL_ID;
  const existing = active.get(id);
  if (existing && sameAgentTarget(existing, normalizedTarget, modelIdStr)) {
    existing.pointerContext = pointerContext || null;
    return existing;
  }

  const entry = {
    process: null,
    folder: normalizedTarget.folder,
    modelId: modelIdStr,
    runtime: normalizedTarget.runtime,
    busy: false,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSeq: 0,
    stderrSeq: 0,
    startedAt: undefined,
    pointerContext: pointerContext || null,
    firstOutputSeen: false,
    artifactDir: evalTraceEnabled ? getCatArtifactDir(id) : null,
    stdoutPath: evalTraceEnabled ? path.join(getCatArtifactDir(id), 'stdout.log') : null,
    stderrPath: evalTraceEnabled ? path.join(getCatArtifactDir(id), 'stderr.log') : null,
  };
  active.set(id, entry);
  return entry;
}

function getAgentArtifacts(catId) {
  const id = String(catId);
  const dir = evalTraceEnabled ? getCatArtifactDir(id) : null;
  if (!dir) return null;
  return {
    dir,
    input: path.join(dir, 'input.json'),
    prompt: path.join(dir, 'prompt.txt'),
    stdout: path.join(dir, 'stdout.log'),
    stderr: path.join(dir, 'stderr.log'),
    conversation: path.join(dir, 'conversation.json'),
    hermesSession: path.join(dir, 'hermes-session.json'),
    hermesSessionExport: path.join(dir, 'hermes-session-export.jsonl'),
    toolEvents: path.join(dir, 'tool-events.jsonl'),
    contextScreenshot: path.join(dir, 'screenshot-context.png'),
    oracle: path.join(dir, 'oracle.json'),
  };
}

function prepareArtifacts(catId, entry, fullPrompt, command, args, cwd, runEnv) {
  const id = String(catId);
  if (!evalTraceEnabled) return;
  const rec = conversations.get(id);
  const artifacts = getAgentArtifacts(id);
  let contextScreenshot = null;
  const sourceScreenshot = entry.pointerContext && entry.pointerContext.screenshotPath;
  if (sourceScreenshot && fs.existsSync(sourceScreenshot)) {
    try {
      fs.copyFileSync(sourceScreenshot, artifacts.contextScreenshot);
      contextScreenshot = artifacts.contextScreenshot;
    } catch {
      contextScreenshot = sourceScreenshot;
    }
  }
  writeJsonSafe(id, 'input.json', {
    catId: id,
    folder: entry.folder,
    runtime: entry.runtime,
    modelId: entry.modelId,
    command,
    argsPreview: args.map((arg) => (arg === fullPrompt ? '<prompt>' : arg)),
    cwd,
    startedAt: new Date(entry.startedAt || now()).toISOString(),
    prompt: textMeta(fullPrompt),
    userPrompt: textMeta(rec ? rec.prompt : ''),
    pointerContext: entry.pointerContext || null,
    contextScreenshot,
    environment: artifactEnvSummary(runEnv),
  });
  writeTextSafe(id, 'prompt.txt', fullPrompt);
  writeTextSafe(id, 'stdout.log', '');
  writeTextSafe(id, 'stderr.log', '');
  writeTextSafe(id, 'tool-events.jsonl', '');
  persistConversation(id);
  recordTrace('cat_artifacts_ready', {
    catId: id,
    artifactDir: artifacts.dir,
    promptPath: artifacts.prompt,
    stdoutPath: artifacts.stdout,
    stderrPath: artifacts.stderr,
    contextScreenshot,
  });
}

function traceStreamChunk(catId, stream, seq, chunk, totalBytes, pathName) {
  const meta = textMeta(chunk);
  recordTrace(`cli_${stream}_chunk`, {
    catId: String(catId),
    seq,
    bytes: meta.bytes,
    totalBytes,
    sha256: meta.sha256,
    preview: meta.preview,
    artifactPath: pathName || null,
  });
}

function sessionFilesDir(hermesHome) {
  return hermesHome ? path.join(hermesHome, 'sessions') : null;
}

function readSessionJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findHermesSessionFileById(hermesHome, sessionId) {
  const dir = sessionFilesDir(hermesHome);
  if (!dir || !sessionId || !fs.existsSync(dir)) return null;
  const direct = path.join(dir, `session_${sessionId}.json`);
  if (fs.existsSync(direct)) return direct;
  const matches = fs.readdirSync(dir).filter((name) => name.includes(String(sessionId)) && name.endsWith('.json'));
  return matches.length ? path.join(dir, matches[0]) : null;
}

function findHermesSessionFileByCatId(hermesHome, catId, startedAt) {
  const dir = sessionFilesDir(hermesHome);
  if (!dir || !fs.existsSync(dir)) return null;
  const minMtime = Number(startedAt || 0) - 30000;
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).mtimeMs >= minMtime;
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  const needle = `agent-UI cat id: ${catId}`;
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(needle) || text.includes(String(catId))) return file;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function toolCallName(toolCall) {
  return String(
    (toolCall && toolCall.function && toolCall.function.name) ||
    (toolCall && toolCall.name) ||
    ''
  );
}

function toolCallArgs(toolCall) {
  const args = (toolCall && toolCall.function && toolCall.function.arguments) || (toolCall && toolCall.arguments) || '';
  return typeof args === 'string' ? args : JSON.stringify(args || {});
}

function writeToolEvents(catId, sessionJson, sessionId) {
  const id = String(catId);
  const messages = Array.isArray(sessionJson && sessionJson.messages) ? sessionJson.messages : [];
  const callsById = new Map();
  let callCount = 0;
  let resultCount = 0;
  writeTextSafe(id, 'tool-events.jsonl', '');

  messages.forEach((msg, messageIndex) => {
    const calls = Array.isArray(msg && msg.tool_calls) ? msg.tool_calls : [];
    for (const call of calls) {
      const toolCallId = String(call && call.id ? call.id : '');
      const toolName = toolCallName(call);
      const args = toolCallArgs(call);
      callsById.set(toolCallId, { toolName, args });
      callCount += 1;
      appendJsonlSafe(id, 'tool-events.jsonl', {
        type: 'tool_call',
        catId: id,
        hermesSessionId: sessionId || null,
        messageIndex,
        toolCallId,
        toolName,
        args,
        argsMeta: textMeta(args),
      });
    }
    if (msg && msg.role === 'tool') {
      const toolCallId = String(msg.tool_call_id || '');
      const prior = callsById.get(toolCallId) || {};
      const result = String(msg.content || '');
      resultCount += 1;
      appendJsonlSafe(id, 'tool-events.jsonl', {
        type: 'tool_result',
        catId: id,
        hermesSessionId: sessionId || null,
        messageIndex,
        toolCallId,
        toolName: prior.toolName || String(msg.tool_name || ''),
        result,
        resultMeta: textMeta(result),
      });
    }
  });

  recordTrace('hermes_tool_events_exported', {
    catId: id,
    hermesSessionId: sessionId || null,
    toolCallCount: callCount,
    toolResultCount: resultCount,
    artifactPath: getAgentArtifacts(id)?.toolEvents || null,
  });
}

async function exportHermesSession({ catId, command, env, hermesHome, sessionId, startedAt }) {
  const id = String(catId);
  let resolvedSessionId = sessionId || null;
  let sessionFile = resolvedSessionId ? findHermesSessionFileById(hermesHome, resolvedSessionId) : null;
  if (!sessionFile) sessionFile = findHermesSessionFileByCatId(hermesHome, id, startedAt);
  const sessionJson = sessionFile ? readSessionJson(sessionFile) : null;
  if (sessionJson && sessionJson.session_id && !resolvedSessionId) {
    resolvedSessionId = String(sessionJson.session_id);
  }

  const rec = conversations.get(id);
  const entry = active.get(id);
  if (resolvedSessionId) {
    if (rec) rec.hermesSessionId = resolvedSessionId;
    if (entry) entry.hermesSessionId = resolvedSessionId;
  }

  if (sessionJson) {
    writeJsonSafe(id, 'hermes-session.json', sessionJson);
    writeToolEvents(id, sessionJson, resolvedSessionId);
  }

  if (resolvedSessionId && command) {
    const exportPath = getAgentArtifacts(id)?.hermesSessionExport;
    if (exportPath) {
      try {
        await execFileAsync(command, ['sessions', 'export', exportPath, '--session-id', resolvedSessionId], {
          env: { ...process.env, ...(env || {}) },
          encoding: 'utf8',
          timeout: 30000,
        });
      } catch (e) {
        appendJsonlSafe(id, 'tool-events.jsonl', {
          type: 'hermes_export_error',
          catId: id,
          hermesSessionId: resolvedSessionId,
          error: (e && (e.stderr || e.message)) || String(e),
        });
      }
    }
  }

  persistConversation(id);
  recordTrace('hermes_session_exported', {
    catId: id,
    hermesSessionId: resolvedSessionId,
    sessionFile: sessionFile || null,
    artifactPath: getAgentArtifacts(id)?.hermesSession || null,
    found: !!sessionJson,
  });
  return resolvedSessionId;
}

function formatLaunchError(error, runner) {
  const msg = (error && error.message) || String(error);
  if (error && error.code === 'ENOENT') {
    return `Hermes executable was not found: ${runner.command}`;
  }
  return msg;
}

function runOnHermes(catId, notify, log, prompt) {
  const id = String(catId);
  const entry = active.get(id);
  if (!entry) {
    log.warn('runOnHermes: no active entry for', id);
    return Promise.resolve();
  }
  if (entry.busy || entry.process) {
    log.warn('runOnHermes: busy', id);
    return Promise.resolve();
  }

  entry.busy = true;
  entry.stdout = '';
  entry.stderr = '';
  entry.stdoutBytes = 0;
  entry.stderrBytes = 0;
  entry.stdoutSeq = 0;
  entry.stderrSeq = 0;
  entry.startedAt = now();
  entry.terminating = false;
  entry.firstOutputSeen = false;

  const runner = getHermesRunner();
  const cwd = getHermesCwd(entry.folder);
  recordTrace('cli_runner_resolved', {
    catId: id,
    runner: runner.displayName,
    command: runner.command || null,
    cwd,
    configured: !!runner.configured,
    error: runner.errorMessage || null,
  });

  if (runner.errorMessage) {
    const rec = conversations.get(id);
    if (rec) {
      rec.items.push({ kind: 'error', text: runner.errorMessage, at: now() });
      rec.runStatus = 'error';
      rec.endResult = runner.errorMessage;
      rec.durationMs = 0;
      rec.activeAssistantBubble = false;
      persistConversation(id);
      onConversationPushed({ catId: id });
    }
    entry.busy = false;
    entry.runPromise = undefined;
    recordTrace('terminal_state_rendered', { catId: id, status: 'error', reason: 'missing_hermes' });
    notify({ catId: id, status: 'error', result: runner.errorMessage, durationMs: 0, finishBubbleLine: finishBubbleLineFromConversation(rec) });
    return Promise.resolve();
  }

  const command = runner.command;
  const recForSession = conversations.get(id);
  const sessionId = entry.hermesSessionId || recForSession?.hermesSessionId;
  const fullPrompt = buildLocalRunPrompt(prompt);
  const args = buildHermesArgs(fullPrompt, sessionId);
  const runEnv = buildHermesRunEnv(runner.env, cwd);
  const artifactPrepStartedAt = now();
  prepareArtifacts(id, entry, fullPrompt, command, args, cwd, runEnv);
  recordTrace('cat_artifact_prepare_completed', { catId: id, durationMs: now() - artifactPrepStartedAt });

  const work = new Promise((resolve) => {
    let settled = false;
    let launchError = null;
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...runEnv,
      },
      windowsHide: true,
    });
    entry.process = child;
    recordTrace('cli_process_started', {
      catId: id,
      runner: runner.displayName,
      command,
      pid: child.pid || null,
      cwd,
    });

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      void (async () => {
        const endedAt = now();
        const durationMs = entry.startedAt ? endedAt - entry.startedAt : undefined;
        const rec = conversations.get(id);
        const stdoutText = String(entry.stdout || '').trim();
        const stderrText = String(entry.stderr || '').trim();
        const launchErrorText = launchError ? formatLaunchError(launchError, runner) : '';
        let hermesSessionId = extractHermesSessionId(`${stderrText}\n${stdoutText}`);

        const status = launchError
          ? 'error'
          : entry.terminating
            ? 'cancelled'
            : Number(code) === 0
              ? 'completed'
              : 'error';
        const errorText = [stderrText, launchErrorText].filter(Boolean).join('\n') ||
          (status === 'error' && !stdoutText ? 'Hermes exited with no output.' : '');

        if (rec) {
          if (hermesSessionId) {
            rec.hermesSessionId = hermesSessionId;
            entry.hermesSessionId = hermesSessionId;
          }
          if (stdoutText && !conversationHasAssistantText(rec)) {
            replaceLastAssistantText(id, stdoutText);
          }
          if (status === 'error' && errorText) {
            rec.items.push({ kind: 'error', text: errorText, at: now() });
          }
          if (status !== 'error' && !conversationHasAssistantText(rec)) {
            replaceLastAssistantText(id, 'Hermes returned no visible output.');
          }
          rec.runStatus = status;
          rec.endResult = launchErrorText || `exit ${code ?? 'unknown'}`;
          if (signal) rec.endResult += ` (${signal})`;
          rec.durationMs = durationMs;
          rec.activeAssistantBubble = false;
        }

        hermesSessionId = await exportHermesSession({
          catId: id,
          command,
          env: runEnv,
          hermesHome: runEnv && runEnv.HERMES_HOME ? runEnv.HERMES_HOME : getHermesHomeForCommand(command),
          sessionId: hermesSessionId,
          startedAt: entry.startedAt,
        });

        if (rec && hermesSessionId) rec.hermesSessionId = hermesSessionId;
        persistConversation(id);
        onConversationPushed({ catId: id });

        entry.process = null;
        entry.busy = false;
        entry.runPromise = undefined;

        recordTrace('terminal_state_rendered', {
          catId: id,
          status,
          durationMs,
          endResult: rec && rec.endResult ? rec.endResult : null,
          hermesSessionId: hermesSessionId || null,
          artifacts: getAgentArtifacts(id),
        });
        notify({
          catId: id,
          status,
          result: undefined,
          durationMs,
          finishBubbleLine: finishBubbleLineFromConversation(rec),
        });
        resolve();
      })().catch((e) => {
        log.warn('Hermes finish handling failed', e);
        resolve();
      });
    };

    child.stdout.on('data', (data) => {
      const chunk = data.toString('utf8');
      entry.stdout += chunk;
      entry.stdoutSeq += 1;
      const bytes = Buffer.byteLength(chunk);
      entry.stdoutBytes += bytes;
      const artifactPath = appendTextSafe(id, 'stdout.log', chunk);
      traceStreamChunk(id, 'stdout', entry.stdoutSeq, chunk, entry.stdoutBytes, artifactPath);
      if (!entry.firstOutputSeen && chunk.trim()) {
        entry.firstOutputSeen = true;
        recordTrace('first_cli_output', { catId: id, bytes, artifactPath });
      }
      appendAssistantChunk(id, chunk);
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString('utf8');
      entry.stderr += chunk;
      entry.stderrSeq += 1;
      const bytes = Buffer.byteLength(chunk);
      entry.stderrBytes += bytes;
      const artifactPath = appendTextSafe(id, 'stderr.log', chunk);
      traceStreamChunk(id, 'stderr', entry.stderrSeq, chunk, entry.stderrBytes, artifactPath);
      const sid = extractHermesSessionId(chunk);
      if (sid) {
        entry.hermesSessionId = sid;
        const rec = conversations.get(id);
        if (rec) {
          rec.hermesSessionId = sid;
          persistConversation(id);
        }
      }
    });

    child.once('error', (e) => {
      launchError = e;
      finish(127, null);
    });
    child.once('close', finish);
  });

  entry.runPromise = work;
  return work;
}

async function runAgentLifecycle({ catId, folder, prompt, model, runtime, pointerContext, notify, log }) {
  const id = String(catId);
  const target = normalizeAgentTarget({ runtime, folder });
  const snap = await captureGitSnapshotForFolder(String(target.folder), log);
  initConversationState(id, {
    runtime: target.runtime,
    folder: target.folder,
    prompt,
    pointerContext,
    snapshotTree: snap?.tree,
    headShaAtSnapshot: snap?.headSha != null ? snap.headSha : undefined,
    snapshotCapturedAt: snap?.capturedAt,
  });

  ensureHermesEntry(id, target, model, pointerContext);
  void runOnHermes(id, notify, log, String(prompt));
}

function startAgentForCat({ catId, folder, prompt, model, runtime, pointerContext }, { getMainWindow, log = console } = {}) {
  const notify = getNotify(getMainWindow);
  void runAgentLifecycle({
    catId: String(catId),
    folder,
    prompt,
    model,
    runtime,
    pointerContext,
    notify,
    log,
  });
}

function sendFollowup(catId, text, opts = {}) {
  const { getMainWindow, log = console } = opts;
  const id = String(catId);
  const t = String(text || '');
  if (!t.trim()) return;

  const entry = active.get(id);
  if (!entry || entry.busy || entry.process) {
    log.warn('sendFollowup: no Hermes entry or busy', id);
    return;
  }
  if (!conversations.has(id)) {
    log.warn('sendFollowup: no conversation', id);
    return;
  }

  const rec = conversations.get(id);
  rec.items.push({ kind: 'user', text: t, at: now() });
  rec.runStatus = 'running';
  rec.endResult = undefined;
  rec.durationMs = undefined;
  rec.activeAssistantBubble = false;
  persistConversation(id);
  onConversationPushed({ catId: id });

  notifyRestarted(getMainWindow, id);
  const notify = getNotify(getMainWindow);
  void runOnHermes(id, notify, log, t);
}

function cancelAllAgents() {
  for (const [, entry] of active) {
    terminateHermesProcess(entry);
  }
  active.clear();
}

module.exports = {
  startAgentForCat,
  cancelAllAgents,
  getAgentConversation,
  listAgentConversations,
  setOnConversationPushed,
  deleteConversationState,
  dismissAgent,
  cancelAgent,
  sendFollowup,
  revertAgentChanges,
  getAgentArtifacts,
};
