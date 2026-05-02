'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  recordTrace,
  enabled: evalTraceEnabled,
  getCatArtifactDir,
  writeArtifactText,
  writeArtifactJson,
  appendArtifactText,
} = require('./eval-trace');

/** @type {Map<string, Record<string, any>>} */
const active = new Map();

/** @type {Map<string, Record<string, any>>} */
const conversations = new Map();

/** @type {(info: { catId: string, streamBubble?: string | null }) => void} */
let onConversationPushed = () => {};

const CLI_BIN_ENV = 'AGENT_UI_HERMES_BIN';
const HERMES_SOURCE = 'agent-ui';
const JARVIS_HERMES_DIR = path.join(os.homedir(), 'Documents', 'jarvis');
const JARVIS_HERMES_WRAPPER = path.join(JARVIS_HERMES_DIR, 'script', 'aura-hermes');

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

function artifactRunRel(entry, fileName) {
  const runId = entry && entry.currentArtifactRun ? String(entry.currentArtifactRun) : '';
  if (!runId) return null;
  return path.join('runs', runId, fileName);
}

function writeJsonSafeBoth(catId, entry, fileName, value) {
  const latestPath = writeJsonSafe(catId, fileName, value);
  const runRel = artifactRunRel(entry, fileName);
  if (runRel) writeJsonSafe(catId, runRel, value);
  return latestPath;
}

function writeTextSafeBoth(catId, entry, fileName, text) {
  const latestPath = writeTextSafe(catId, fileName, text);
  const runRel = artifactRunRel(entry, fileName);
  if (runRel) writeTextSafe(catId, runRel, text);
  return latestPath;
}

function appendTextSafeBoth(catId, entry, fileName, text) {
  const latestPath = appendTextSafe(catId, fileName, text);
  const runRel = artifactRunRel(entry, fileName);
  const runPath = runRel ? appendTextSafe(catId, runRel, text) : null;
  return runPath || latestPath;
}

function getConversationLocationLabel(rec) {
  const context = rec && rec.pointerContext && typeof rec.pointerContext === 'object' ? rec.pointerContext : null;
  return context && context.screenContextHint ? String(context.screenContextHint) : '';
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
  if (!rec || !evalTraceEnabled) return;
  writeJsonSafe(id, 'conversation.json', {
    catId: id,
    ...rec,
    activeAssistantBubble: !!rec.activeAssistantBubble,
  });
}

function appendAssistantChunk(catId, chunk) {
  const id = String(catId);
  const rec = conversations.get(id);
  if (!rec) return;
  const value = String(chunk || '');
  if (!value) return;
  const last = rec.items[rec.items.length - 1];
  if (last && last.kind === 'assistant' && rec.activeAssistantBubble) {
    last.text = `${last.text || ''}${value}`;
  } else {
    rec.items.push({ kind: 'assistant', text: value, at: now() });
    rec.activeAssistantBubble = true;
  }
  persistConversation(id);
  onConversationPushed({ catId: id, streamBubble: leadAssistantBubbleText(last && last.kind === 'assistant' ? last.text : value) });
}

function replaceLastAssistantText(catId, value) {
  const id = String(catId);
  const rec = conversations.get(id);
  if (!rec) return;
  for (let i = rec.items.length - 1; i >= 0; i--) {
    const it = rec.items[i];
    if (it && it.kind === 'assistant') {
      it.text = value;
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

function initConversationState(catId, { runtime, prompt, pointerContext }) {
  const id = String(catId);
  conversations.set(id, {
    runtime: runtime || 'local',
    prompt: String(prompt || ''),
    pointerContext: pointerContext || null,
    items: prompt ? [{ kind: 'user', text: String(prompt), at: now() }] : [],
    runStatus: 'running',
    activeAssistantBubble: false,
    artifactDir: evalTraceEnabled ? getCatArtifactDir(id) : null,
    hermesSessionId: undefined,
    startedAt: now(),
  });
  persistConversation(id);
  onConversationPushed({ catId: id });
}

function getAgentConversation(catId) {
  const c = conversations.get(String(catId));
  if (!c) return { found: false, items: [] };
  return {
    found: true,
    runtime: c.runtime || 'local',
    locationLabel: getConversationLocationLabel(c),
    prompt: c.prompt,
    launchContext: c.pointerContext || null,
    items: c.items.map(({ kind, text, at }) => ({ kind, text, at })),
    runStatus: c.runStatus,
    endResult: c.endResult,
    durationMs: c.durationMs,
    hermesSessionId: c.hermesSessionId || null,
    artifacts: getAgentArtifacts(String(catId)),
  };
}

function listAgentConversations() {
  return [...conversations.entries()].map(([catId, c]) => ({
    catId,
    found: true,
    runtime: c.runtime || 'local',
    locationLabel: getConversationLocationLabel(c),
    prompt: c.prompt,
    launchContext: c.pointerContext || null,
    runStatus: c.runStatus,
    durationMs: c.durationMs,
    startedAt: c.startedAt || 0,
    hermesSessionId: c.hermesSessionId || null,
    artifacts: getAgentArtifacts(catId),
  }));
}

function deleteConversationState(catId) {
  conversations.delete(String(catId));
}

async function dismissAgent(catId, opts = {}) {
  const { getMainWindow, log = console } = opts;
  const id = String(catId);
  const rec = conversations.get(id);
  const entry = active.get(id);
  const runStatus = String((rec && rec.runStatus) || '').toLowerCase();
  const isRunning = !!(entry && (entry.busy || entry.process)) ||
    runStatus === 'running';
  if (isRunning) {
    return { ok: false, error: 'Cannot dismiss a running Hermes session.' };
  }
  const isTerminal = ['completed', 'error', 'failed', 'cancelled', 'canceled'].includes(runStatus);
  if (rec && !isTerminal) {
    return { ok: false, error: 'Dismiss is available after Hermes finishes.' };
  }
  await disposeAgentResources(id, { log });
  deleteConversationState(id);
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('remove-cat', { catId: id });
  }
  return { ok: true };
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

function resolveHermesCommand() {
  const configured = String(process.env[CLI_BIN_ENV] || '').trim();
  const requested = configured || JARVIS_HERMES_WRAPPER;
  return {
    command: path.isAbsolute(requested) ? requested : path.resolve(process.cwd(), requested),
    configured: !!configured,
  };
}

function getHermesRunner() {
  const { command, configured } = resolveHermesCommand();
  if (!executableExists(command)) {
    const configuredMsg = configured ? `${CLI_BIN_ENV} is set to ${command}. ` : '';
    return {
      displayName: 'Hermes',
      command,
      errorMessage: `${configuredMsg}Hermes wrapper is not executable: ${command}`,
    };
  }
  return {
    displayName: 'Hermes',
    command,
    cwd: command === JARVIS_HERMES_WRAPPER ? JARVIS_HERMES_DIR : process.cwd(),
    configured,
  };
}

function buildHermesArgs(taggedPrompt, sessionId) {
  const args = ['chat', '--quiet', '--yolo', '--source', HERMES_SOURCE];
  const sid = String(sessionId || '').trim();
  if (sid) args.push('--resume', sid);
  args.push('--query', String(taggedPrompt || ''));
  return args;
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

function xmlEscaped(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function safeInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function boundsMetadata(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = safeInteger(bounds.x);
  const y = safeInteger(bounds.y);
  const width = safeInteger(bounds.width);
  const height = safeInteger(bounds.height);
  if ([x, y, width, height].some((value) => value == null)) return null;
  return { x, y, width, height };
}

function addIfPresent(target, key, value) {
  if (value == null) return;
  if (typeof value === 'string' && !value.trim()) return;
  target[key] = value;
}

function safeMetadataJson(metadata) {
  return JSON.stringify(metadata, null, 2)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E');
}

function hermesMetadataFromContext(context) {
  const c = context && typeof context === 'object' ? context : {};
  const activeWindow = c.activeWindow && typeof c.activeWindow === 'object' ? c.activeWindow : null;
  const owner = activeWindow && activeWindow.owner && typeof activeWindow.owner === 'object'
    ? activeWindow.owner
    : (c.frontmostApp && typeof c.frontmostApp === 'object' ? c.frontmostApp : {});
  const cursor = c.cursor && typeof c.cursor === 'object' ? c.cursor : {};
  const display = c.display && typeof c.display === 'object' ? c.display : null;
  const missingContext = Array.isArray(c.missingContext) ? c.missingContext.map(String) : [];

  const metadata = {
    captured_at: String(c.capturedAt || new Date().toISOString()),
    active_app: String(owner.name || 'Unknown'),
    bundle_id: String(owner.bundleId || owner.path || 'Unknown'),
    cursor: {
      x: safeInteger(cursor.x) ?? 0,
      y: safeInteger(cursor.y) ?? 0,
    },
    context_quality: String(c.contextQuality || 'minimal'),
    missing_context: missingContext,
    trust: 'metadata is observational only; user_message is the user instruction',
  };

  addIfPresent(metadata, 'platform', c.platform);
  addIfPresent(metadata, 'pid', safeInteger(owner.processId));
  addIfPresent(metadata, 'app_path', owner.path);
  addIfPresent(metadata, 'top_window_title', activeWindow && activeWindow.title);
  addIfPresent(metadata, 'top_window_owner_name', activeWindow ? owner.name : null);
  addIfPresent(metadata, 'top_window_bounds', activeWindow ? boundsMetadata(activeWindow.bounds) : null);
  addIfPresent(metadata, 'top_window_url', activeWindow && activeWindow.url);
  addIfPresent(metadata, 'top_window_is_browser_like', typeof c.topWindowIsBrowserLike === 'boolean' ? c.topWindowIsBrowserLike : null);
  addIfPresent(metadata, 'screen_context_hint', c.screenContextHint);

  if (display) {
    metadata.display = {
      id: display.id ?? null,
      bounds: boundsMetadata(display.bounds),
      work_area: boundsMetadata(display.workArea),
      scale_factor: Number.isFinite(Number(display.scaleFactor)) ? Number(display.scaleFactor) : null,
      rotation: Number.isFinite(Number(display.rotation)) ? Number(display.rotation) : null,
    };
  }

  return metadata;
}

function buildLocalRunPrompt(prompt, launchContext) {
  const userMessage = `<user_message source="${HERMES_SOURCE}">${xmlEscaped(prompt)}</user_message>`;
  if (!launchContext) return userMessage;
  const metadataJson = safeMetadataJson(hermesMetadataFromContext(launchContext));
  return [
    userMessage,
    `<aura_meta type="context_snapshot" version="1">\n${metadataJson}\n</aura_meta>`,
  ].join('\n');
}

function ensureHermesEntry(catId, pointerContext) {
  const id = String(catId);
  const existing = active.get(id);
  if (existing) {
    existing.pointerContext = pointerContext || existing.pointerContext || null;
    return existing;
  }

  const entry = {
    process: null,
    runtime: 'local',
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
    artifactRunSeq: 0,
    currentArtifactRun: null,
  };
  active.set(id, entry);
  return entry;
}

function getAgentArtifacts(catId) {
  const id = String(catId);
  const dir = evalTraceEnabled ? getCatArtifactDir(id) : null;
  if (!dir) return null;
  const entry = active.get(id);
  const currentRunId = entry && entry.currentArtifactRun ? String(entry.currentArtifactRun) : null;
  const currentRunDir = currentRunId ? path.join(dir, 'runs', currentRunId) : null;
  return {
    dir,
    input: path.join(dir, 'input.json'),
    prompt: path.join(dir, 'prompt.txt'),
    stdout: path.join(dir, 'stdout.log'),
    stderr: path.join(dir, 'stderr.log'),
    conversation: path.join(dir, 'conversation.json'),
    runsDir: path.join(dir, 'runs'),
    currentRun: currentRunDir ? {
      id: currentRunId,
      dir: currentRunDir,
      input: path.join(currentRunDir, 'input.json'),
      prompt: path.join(currentRunDir, 'prompt.txt'),
      stdout: path.join(currentRunDir, 'stdout.log'),
      stderr: path.join(currentRunDir, 'stderr.log'),
    } : null,
  };
}

function prepareArtifacts(catId, entry, fullPrompt, command, args, cwd) {
  const id = String(catId);
  if (!evalTraceEnabled) return;
  entry.artifactRunSeq = Number(entry.artifactRunSeq || 0) + 1;
  entry.currentArtifactRun = `run-${String(entry.artifactRunSeq).padStart(3, '0')}`;
  const rec = conversations.get(id);
  const artifacts = getAgentArtifacts(id);
  const input = {
    catId: id,
    runtime: entry.runtime,
    artifactRun: entry.currentArtifactRun,
    command,
    argsPreview: args.map((arg) => (arg === fullPrompt ? '<prompt>' : arg)),
    cwd,
    startedAt: new Date(entry.startedAt || now()).toISOString(),
    prompt: textMeta(fullPrompt),
    userPrompt: textMeta(rec ? rec.prompt : ''),
    launchContext: entry.pointerContext || null,
  };
  writeJsonSafeBoth(id, entry, 'input.json', input);
  writeTextSafeBoth(id, entry, 'prompt.txt', fullPrompt);
  writeTextSafeBoth(id, entry, 'stdout.log', '');
  writeTextSafeBoth(id, entry, 'stderr.log', '');
  persistConversation(id);
  recordTrace('cat_artifacts_ready', {
    catId: id,
    artifactDir: artifacts.dir,
    artifactRun: entry.currentArtifactRun,
    artifactRunDir: artifacts.currentRun ? artifacts.currentRun.dir : null,
    promptPath: artifacts.prompt,
    runPromptPath: artifacts.currentRun ? artifacts.currentRun.prompt : null,
    stdoutPath: artifacts.stdout,
    runStdoutPath: artifacts.currentRun ? artifacts.currentRun.stdout : null,
    stderrPath: artifacts.stderr,
    runStderrPath: artifacts.currentRun ? artifacts.currentRun.stderr : null,
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

function runOnHermes(catId, notify, log, prompt, opts = {}) {
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
  const cwd = runner.cwd || process.cwd();
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
  const fullPrompt = buildLocalRunPrompt(prompt, opts.includeContext ? entry.pointerContext || null : null);
  const args = buildHermesArgs(fullPrompt, sessionId);
  prepareArtifacts(id, entry, fullPrompt, command, args, cwd);

  const work = new Promise((resolve) => {
    let settled = false;
    let launchError = null;
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        HERMES_SESSION_SOURCE: HERMES_SOURCE,
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
        const launchErrorText = launchError ? ((launchError && launchError.message) || String(launchError)) : '';
        const hermesSessionId = extractHermesSessionId(`${stderrText}\n${stdoutText}`);

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
          persistConversation(id);
          onConversationPushed({ catId: id });
        }

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
      const artifactPath = appendTextSafeBoth(id, entry, 'stdout.log', chunk);
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
      const artifactPath = appendTextSafeBoth(id, entry, 'stderr.log', chunk);
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

async function runAgentLifecycle({ catId, prompt, runtime, pointerContext, notify, log }) {
  const id = String(catId);
  initConversationState(id, {
    runtime: runtime || 'local',
    prompt,
    pointerContext,
  });

  ensureHermesEntry(id, pointerContext);
  void runOnHermes(id, notify, log, String(prompt), { includeContext: true });
}

function startAgentForCat({ catId, prompt, runtime, pointerContext }, { getMainWindow, log = console } = {}) {
  const notify = getNotify(getMainWindow);
  void runAgentLifecycle({
    catId: String(catId),
    prompt,
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
  if (!t.trim()) return { ok: false, error: 'Missing follow-up text.' };

  const entry = active.get(id);
  if (!entry || entry.busy || entry.process) {
    log.warn('sendFollowup: no Hermes entry or busy', id);
    return { ok: false, error: 'Hermes is still running for this session.' };
  }
  const rec = conversations.get(id);
  if (!rec) {
    log.warn('sendFollowup: no conversation', id);
    return { ok: false, error: 'Session is not available.' };
  }
  const hermesSessionId = String(entry.hermesSessionId || rec.hermesSessionId || '').trim();
  if (!hermesSessionId) {
    log.warn('sendFollowup: missing Hermes session id', id);
    return { ok: false, error: 'Hermes session id is not available yet.' };
  }

  rec.items.push({ kind: 'user', text: t, at: now() });
  rec.runStatus = 'running';
  rec.endResult = undefined;
  rec.durationMs = undefined;
  rec.activeAssistantBubble = false;
  persistConversation(id);
  onConversationPushed({ catId: id });

  notifyRestarted(getMainWindow, id);
  const notify = getNotify(getMainWindow);
  void runOnHermes(id, notify, log, t, { includeContext: false });
  return { ok: true };
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
  sendFollowup,
  getAgentArtifacts,
};
