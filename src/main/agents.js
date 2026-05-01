'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const { execFile, spawn } = require('child_process');

const execFileAsync = promisify(execFile);

/**
 * One local CLI process per on-screen cat run. Output streams into a per-cat
 * conversation log for the UI.
 */

/** @typedef {'local'} AgentRuntime */
/** @typedef {{ url?: string, startingRef?: string }} CloudRepoConfig */
/** @typedef {{ runtime: AgentRuntime, folder?: string, cloudRepo?: CloudRepoConfig | null }} AgentTarget */
/** @typedef {{ process: import('child_process').ChildProcess | null, folder: string, modelId: string, runtime: AgentRuntime, busy: boolean, runPromise?: Promise<void>, stdout: string, stderr: string, startedAt?: number, terminating?: boolean, hermesSessionId?: string }} ActiveEntry */

/** @type {Map<string, { runtime?: AgentRuntime, folder: string, prompt: string, items: Array<{ kind: string, text: string, at: number, streamId?: string }>, runStatus: string, endResult?: string, durationMs?: number, activeAssistantBubble?: boolean, hermesSessionId?: string, snapshotTree?: string, headShaAtSnapshot?: string, snapshotCapturedAt?: number, reverted?: boolean, revertError?: string, cloudRepoUrl?: string, cloudStartingRef?: string, gitBranches?: Array<{ repoUrl: string, branch?: string, prUrl?: string }> }>} */
const conversations = new Map();

/** @type {Map<string, ActiveEntry>} */
const active = new Map();

/** @type {(info: { catId: string, streamBubble?: string | null }) => void} */
let onConversationPushed = () => {};

function setOnConversationPushed(fn) {
  onConversationPushed = typeof fn === 'function' ? fn : () => {};
}

/** First line before a paragraph break, used only for the small overlay bubble. */
function leadAssistantBubbleText(fullText) {
  const raw = String(fullText || '').trim();
  if (!raw) return null;
  const para = raw.indexOf('\n\n');
  const head = para >= 0 ? raw.slice(0, para) : raw;
  const firstLine = head.split('\n')[0].trim();
  if (!firstLine) return null;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

/** Same line as live stream bubbles: last assistant turn’s short first line. */
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

function now() {
  return Date.now();
}

function normalizeRuntime() {
  return 'local';
}

function normalizeCloudRepoConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const url = typeof value.url === 'string' ? value.url.trim() : '';
  if (!url) return null;
  const startingRef = typeof value.startingRef === 'string' ? value.startingRef.trim() : '';
  return { url, startingRef };
}

function normalizeAgentTarget({ runtime, folder } = {}) {
  const rt = normalizeRuntime(runtime);
  return {
    runtime: rt,
    folder: String(folder || ''),
    cloudRepo: null,
  };
}

function sameAgentTarget(entry, target, modelId) {
  if (!entry) return false;
  if (entry.modelId !== modelId || entry.runtime !== target.runtime) return false;
  return entry.folder === target.folder;
}

function getConversationLocationLabel(rec) {
  if (!rec) return '';
  return rec.folder || '';
}

/**
 * Captures a git tree object for the current working tree (tracked + untracked, .gitignore respected)
 * using a temp index, without touching the user's real index. Returns null if not a git worktree
 * or on failure.
 * @param {string} folder
 * @param {Console} [log]
 * @returns {Promise<{ tree: string, headSha: string | null, capturedAt: number } | null>}
 */
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
    const h = String(stdout).trim();
    headSha = h || null;
  } catch {
    headSha = null;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorcats-git-'));
  const indexFile = path.join(tmp, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: f, env, encoding: 'utf8' });
    const { stdout: treeOut } = await execFileAsync('git', ['write-tree'], { cwd: f, env, encoding: 'utf8' });
    const tree = String(treeOut).trim();
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

/**
 * Restores the cat's folder to the git tree captured at spawn. Git-only; requires a prior snapshot.
 * Refuses if the cat is still running, already reverted, or missing snapshot.
 * @param {string} catId
 * @param {{ log?: Console }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, error: string, cancelled?: boolean }>}
 */
async function revertAgentChanges(catId, opts = {}) {
  const { log = console } = opts;
  const id = String(catId);
  const rec = conversations.get(id);
  if (!rec || !rec.snapshotTree) {
    return { ok: false, error: 'No git snapshot to revert to.' };
  }
  if (rec.reverted) {
    return { ok: false, error: 'Already reverted.' };
  }
  if (String(rec.runStatus || '').toLowerCase() === 'running') {
    return { ok: false, error: 'Agent is still running. Wait for it to finish, then try again.' };
  }
  const folder = rec.folder;
  if (!String(folder || '').trim()) {
    return { ok: false, error: 'Missing folder for this cat.' };
  }
  const tree = rec.snapshotTree;
  try {
    await execFileAsync('git', ['read-tree', '--reset', '-u', tree], {
      cwd: folder,
      encoding: 'utf8',
    });
    await execFileAsync('git', ['clean', '-fd'], { cwd: folder, encoding: 'utf8' });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log.warn('revertAgentChanges failed', e);
    rec.revertError = msg;
    onConversationPushed({ catId: id });
    return { ok: false, error: msg };
  }
  rec.reverted = true;
  rec.revertError = undefined;
  rec.items.push({
    kind: 'system',
    text: 'Changes reverted to the folder state at spawn.',
    at: now(),
  });
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
  }, 1000);
}

/**
 * Dispose Hermes process + clear active entry (does not touch conversation map).
 * @param {string} catId
 * @param {{ log?: Console }} [opts]
 */
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

function appendAssistantChunk(catId, chunk) {
  const text = String(chunk || '');
  if (!text) return;
  const rec = conversations.get(String(catId));
  if (!rec) return;

  const last = rec.items.length ? rec.items[rec.items.length - 1] : null;
  if (last && last.kind === 'assistant' && rec.activeAssistantBubble) {
    last.text = (last.text || '') + text;
    last.at = now();
    onConversationPushed({ catId: String(catId), streamBubble: leadAssistantBubbleText(last.text) });
    return;
  }

  const line = { kind: 'assistant', text, at: now() };
  rec.items.push(line);
  rec.activeAssistantBubble = true;
  onConversationPushed({ catId: String(catId), streamBubble: leadAssistantBubbleText(text) });
}

function replaceLastAssistantText(catId, text) {
  const rec = conversations.get(String(catId));
  if (!rec) return;
  const value = String(text || '');
  for (let i = rec.items.length - 1; i >= 0; i--) {
    if (rec.items[i] && rec.items[i].kind === 'assistant') {
      rec.items[i].text = value;
      rec.items[i].at = now();
      rec.activeAssistantBubble = false;
      onConversationPushed({ catId: String(catId), streamBubble: leadAssistantBubbleText(value) });
      return;
    }
  }
  if (value) {
    rec.items.push({ kind: 'assistant', text: value, at: now() });
  }
  rec.activeAssistantBubble = false;
  onConversationPushed({ catId: String(catId), streamBubble: leadAssistantBubbleText(value) });
}

function conversationHasAssistantText(rec) {
  if (!rec || !Array.isArray(rec.items)) return false;
  return rec.items.some((it) => it && it.kind === 'assistant' && String(it.text || '').length > 0);
}

/**
 * @param {string} catId
 * @param {{ runtime?: AgentRuntime, folder: string, prompt: string, cloudRepo?: CloudRepoConfig | null, snapshotTree?: string, headShaAtSnapshot?: string | null, snapshotCapturedAt?: number }} params
 */
function initConversationState(catId, { runtime, folder, prompt, cloudRepo, snapshotTree, headShaAtSnapshot, snapshotCapturedAt }) {
  const rt = normalizeRuntime(runtime);
  const repo = normalizeCloudRepoConfig(cloudRepo);
  conversations.set(catId, {
    runtime: rt,
    folder: String(folder || ''),
    prompt: String(prompt || ''),
    items: prompt ? [{ kind: 'user', text: String(prompt), at: now() }] : [],
    runStatus: 'running',
    activeAssistantBubble: false,
    snapshotTree: snapshotTree || undefined,
    headShaAtSnapshot: headShaAtSnapshot != null ? String(headShaAtSnapshot) : undefined,
    snapshotCapturedAt: snapshotCapturedAt != null ? snapshotCapturedAt : undefined,
    reverted: false,
    revertError: undefined,
    cloudRepoUrl: repo?.url,
    cloudStartingRef: repo?.startingRef,
    gitBranches: undefined,
  });
  onConversationPushed({ catId });
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
    cloudRepoUrl: c.cloudRepoUrl || null,
    cloudStartingRef: c.cloudStartingRef || null,
    gitBranches: Array.isArray(c.gitBranches)
      ? c.gitBranches.map((b) => ({
          repoUrl: b && b.repoUrl != null ? String(b.repoUrl) : '',
          branch: b && b.branch != null ? String(b.branch) : undefined,
          prUrl: b && b.prUrl != null ? String(b.prUrl) : undefined,
        }))
      : [],
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
    canRevert: !!c.snapshotTree,
    reverted: !!c.reverted,
  }));
}

function deleteConversationState(catId) {
  conversations.delete(String(catId));
}

/**
 * @param {string} catId
 * @param {{ getMainWindow?: () => import('electron').BrowserWindow | null, log?: Console }} opts
 */
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

const DEFAULT_AGENT_MODEL_ID = 'hermes-cli';
const CLI_BIN_ENV = 'CURSORCATS_HERMES_BIN';
const FALLBACK_EXECUTABLE_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  '/usr/bin',
  '/bin',
];
const JARVIS_HERMES_DIR = path.join(os.homedir(), 'Documents', 'jarvis');
const JARVIS_HERMES_HOME = path.join(JARVIS_HERMES_DIR, '.aura', 'hermes-home');

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

function defaultHermesCandidates() {
  return hermesCandidatesFromDir(JARVIS_HERMES_DIR);
}

function isPathInside(childPath, parentPath) {
  const child = path.resolve(String(childPath || ''));
  const parent = path.resolve(String(parentPath || ''));
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function directoryExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function getHermesHomeForCommand(command) {
  if (process.env.HERMES_HOME) return null;
  if (!directoryExists(JARVIS_HERMES_HOME)) return null;
  if (isPathInside(command, JARVIS_HERMES_DIR)) return JARVIS_HERMES_HOME;
  return null;
}

function getHermesEnvForCommand(command) {
  const hermesHome = getHermesHomeForCommand(command);
  return hermesHome ? { HERMES_HOME: hermesHome } : undefined;
}

function commandHasPathSeparator(command) {
  return String(command || '').includes('/') || String(command || '').includes('\\');
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
    if (path.basename(abs) === 'hermes') {
      const venvHermes = hermesCandidatesFromDir(path.dirname(abs)).find(executableExists);
      if (venvHermes) return venvHermes;
    }
    return executableExists(abs) ? abs : null;
  }

  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .concat(FALLBACK_EXECUTABLE_DIRS);
  const seen = new Set();
  for (const dir of dirs) {
    const resolvedDir = path.resolve(dir);
    if (seen.has(resolvedDir)) continue;
    seen.add(resolvedDir);
    for (const ext of extensions) {
      const candidate = path.join(resolvedDir, `${cmd}${ext}`);
      if (executableExists(candidate)) return candidate;
    }
  }
  if (cmd === 'hermes') {
    return defaultHermesCandidates().find(executableExists) || null;
  }
  return null;
}

function commandBaseName(command) {
  return path
    .basename(String(command || '').trim())
    .replace(/\.(exe|cmd|bat)$/i, '')
    .toLowerCase();
}

function extractHermesSessionId(text) {
  const match = String(text || '').match(/\bsession_id:\s*([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

function buildHermesArgs(prompt, sessionId) {
  const args = ['chat', '-Q', '--yolo', '--source', 'cursorcats'];
  const sid = String(sessionId || '').trim();
  if (sid) args.push('--resume', sid);
  args.push('-q', String(prompt || ''));
  return args;
}

function buildLocalRunPrompt(prompt, entry) {
  const userPrompt = String(prompt || '');
  const folder = String(entry && entry.folder ? entry.folder : '').trim();
  if (!folder) return userPrompt;
  return [
    'Cursor Cats run context:',
    `- The selected current folder/worktree is: ${folder}`,
    '- Interpret "this", "here", and "current folder" as that selected folder plus the live app state visible to the user.',
    '- Do not inspect, edit, patch, test, or optimize files outside that selected folder unless the user explicitly asks for another path.',
    '- Do not work on Jarvis, AURA, Hermes, or Cursor Cats internals unless that selected folder is one of those repositories.',
    '- Keep changes minimal and directly tied to the user prompt.',
    '',
    'User prompt:',
    userPrompt,
  ].join('\n');
}

function buildCodexArgs(prompt) {
  return [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '--color',
    'never',
    String(prompt || ''),
  ];
}

function buildNoCliFoundMessage() {
  return [
    'No local agent CLI was found.',
    `Cursor Cats tried \`hermes\`, the Jarvis Hermes install at ${JARVIS_HERMES_DIR}, then \`codex\` as a fallback.`,
    `Install Hermes so \`hermes\` is on PATH, or launch Cursor Cats with ${CLI_BIN_ENV}=/path/to/hermes.`,
    `If Hermes lives in a Jarvis checkout, you can launch with ${CLI_BIN_ENV}=/path/to/jarvis.`,
    `To use Codex instead, install the Codex CLI or launch with ${CLI_BIN_ENV}=codex.`,
  ].join('\n');
}

function getCliRunner() {
  const configured = String(process.env[CLI_BIN_ENV] || '').trim();
  if (configured) {
    const resolved = findExecutable(configured) || configured;
    const isCodex = commandBaseName(resolved) === 'codex';
    return {
      displayName: isCodex ? 'Codex' : 'Hermes',
      command: resolved,
      argsForPrompt: isCodex ? buildCodexArgs : buildHermesArgs,
      env: isCodex ? undefined : getHermesEnvForCommand(resolved),
      configured: true,
    };
  }

  const hermes = findExecutable('hermes');
  if (hermes) {
    return {
      displayName: 'Hermes',
      command: hermes,
      argsForPrompt: buildHermesArgs,
      env: getHermesEnvForCommand(hermes),
      configured: false,
    };
  }

  const codex = findExecutable('codex');
  if (codex) {
    return {
      displayName: 'Codex',
      command: codex,
      argsForPrompt: buildCodexArgs,
      configured: false,
      fallback: true,
    };
  }

  return {
    displayName: 'Local CLI',
    errorMessage: buildNoCliFoundMessage(),
  };
}

function formatLaunchError(error, runner) {
  const msg = (error && error.message) || String(error);
  if (error && error.code === 'ENOENT') {
    const configured = runner && runner.configured ? `${CLI_BIN_ENV} is set to ${runner.command}.` : '';
    const fallback =
      runner && runner.fallback
        ? '`hermes` was not found, so Cursor Cats tried the Codex CLI fallback.'
        : 'Cursor Cats could not find the configured CLI executable.';
    return [
      `${runner.displayName} executable was not found: ${runner.command}`,
      [configured, fallback].filter(Boolean).join(' '),
      `Install Hermes so \`hermes\` is on PATH, or launch with ${CLI_BIN_ENV}=/path/to/hermes.`,
      `If Hermes lives in a Jarvis checkout, launch with ${CLI_BIN_ENV}=/path/to/jarvis.`,
      `If you want to use Codex, launch with ${CLI_BIN_ENV}=codex.`,
    ].join('\n');
  }
  return msg;
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

function ensureHermesEntry(catId, target, modelId) {
  const id = String(catId);
  const normalizedTarget = normalizeAgentTarget(target);
  const modelIdStr = String(modelId || '').trim() || DEFAULT_AGENT_MODEL_ID;
  const existing = active.get(id);

  if (existing && sameAgentTarget(existing, normalizedTarget, modelIdStr)) {
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
    startedAt: undefined,
  };
  active.set(id, entry);
  return entry;
}

/**
 * @param {string} catId
 * @param {(payload: { catId: string, status: string, result?: string, durationMs?: number, finishBubbleLine?: string }) => void} notify
 * @param {Console} log
 * @param {string} prompt
 */
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
  entry.startedAt = now();
  entry.terminating = false;

  const runner = getCliRunner();
  const cwd = getHermesCwd(entry.folder);

  if (runner.errorMessage) {
    const rec = conversations.get(id);
    if (rec) {
      rec.items.push({ kind: 'error', text: runner.errorMessage, at: now() });
      rec.runStatus = 'error';
      rec.endResult = runner.errorMessage;
      rec.durationMs = 0;
      rec.activeAssistantBubble = false;
      onConversationPushed({ catId: id });
    }
    entry.busy = false;
    entry.runPromise = undefined;
    notify({
      catId: id,
      status: 'error',
      result: runner.errorMessage,
      durationMs: 0,
      finishBubbleLine: finishBubbleLineFromConversation(rec),
    });
    return Promise.resolve();
  }

  const command = runner.command;
  const recForSession = conversations.get(id);
  const sessionId = entry.hermesSessionId || recForSession?.hermesSessionId;
  const args = runner.argsForPrompt(buildLocalRunPrompt(prompt, entry), sessionId);

  const work = new Promise((resolve) => {
    let settled = false;
    let launchError = null;
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...(runner.env || {}),
      },
      windowsHide: true,
    });
    entry.process = child;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      const endedAt = now();
      const durationMs = entry.startedAt ? endedAt - entry.startedAt : undefined;
      const rec = conversations.get(id);
      const stdoutText = String(entry.stdout || '').trim();
      const stderrText = String(entry.stderr || '').trim();
      const launchErrorText = launchError ? formatLaunchError(launchError, runner) : '';
      const hermesSessionId = extractHermesSessionId(`${stderrText}\n${stdoutText}`);

      const status = launchError
        ? 'error'
        : entry.terminating
          ? 'cancelled'
          : Number(code) === 0
            ? 'completed'
            : 'error';
      const errorText = [stderrText, launchErrorText]
        .filter(Boolean)
        .join('\n') || (status === 'error' && !stdoutText ? `${runner.displayName} exited with no output.` : '');

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
          replaceLastAssistantText(id, `${runner.displayName} returned no output.`);
        }
        rec.runStatus = status;
        rec.endResult = launchErrorText || `exit ${code ?? 'unknown'}`;
        if (signal) rec.endResult += ` (${signal})`;
        rec.durationMs = durationMs;
        rec.activeAssistantBubble = false;
        onConversationPushed({ catId: id });
      }

      entry.process = null;
      entry.busy = false;
      entry.runPromise = undefined;

      notify({
        catId: id,
        status,
        result: undefined,
        durationMs,
        finishBubbleLine: finishBubbleLineFromConversation(rec),
      });
      resolve();
    };

    child.stdout.on('data', (data) => {
      const chunk = data.toString('utf8');
      entry.stdout += chunk;
      appendAssistantChunk(id, chunk);
    });
    child.stderr.on('data', (data) => {
      const chunk = data.toString('utf8');
      entry.stderr += chunk;
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

async function runAgentLifecycle({ catId, folder, prompt, model, runtime, cloudRepo, notify, log }) {
  const id = String(catId);
  const target = normalizeAgentTarget({ runtime, folder, cloudRepo });
  const snap = await captureGitSnapshotForFolder(String(target.folder), log);
  initConversationState(id, {
    runtime: target.runtime,
    folder: target.folder,
    prompt,
    cloudRepo: null,
    snapshotTree: snap?.tree,
    headShaAtSnapshot: snap?.headSha != null ? snap.headSha : undefined,
    snapshotCapturedAt: snap?.capturedAt,
  });

  ensureHermesEntry(id, target, model);
  void runOnHermes(id, notify, log, String(prompt));
}

/**
 * Starts an async Hermes CLI run for this cat. Does not block. Completion is
 * reported via `agent-finished` on the main window.
 */
function startAgentForCat({ catId, folder, prompt, model, runtime, cloudRepo }, { getMainWindow, log = console } = {}) {
  const notify = getNotify(getMainWindow);
  void runAgentLifecycle({
    catId: String(catId),
    folder,
    prompt,
    model,
    runtime,
    cloudRepo,
    notify,
    log,
  });
}

/**
 * @param {string} catId
 * @param {string} text
 * @param {{ getMainWindow?: () => import('electron').BrowserWindow | null, log?: Console }} opts
 */
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
  if (rec) {
    rec.items.push({ kind: 'user', text: t, at: now() });
    rec.runStatus = 'running';
    rec.endResult = undefined;
    rec.durationMs = undefined;
    rec.activeAssistantBubble = false;
    onConversationPushed({ catId: id });
  }

  notifyRestarted(getMainWindow, id);
  const notify = getNotify(getMainWindow);
  void runOnHermes(id, notify, log, t);
}

/** Best-effort cancel in-flight runs (e.g. app quit). */
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
  revertAgentChanges,
};
