'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const repoRoot = path.resolve(__dirname, '..');
const localBundle = path.join(repoRoot, 'dist', 'mac-arm64', 'agent-UI for Hermes.app');
const installedBundle = '/Applications/agent-UI for Hermes.app';
const appArg = String(
  process.argv[2] || process.env.AGENT_UI_INSTALLED_APP || (fs.existsSync(localBundle) ? localBundle : installedBundle),
);
const appPath = path.resolve(appArg);
const appBundle = appPath.endsWith('.app') ? appPath : path.dirname(path.dirname(path.dirname(appPath)));
const appExecutable = resolveAppExecutable(appPath);

const tmpRoot = fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir();
const runDir = process.env.AGENT_UI_INTERACTION_SMOKE_DIR
  ? path.resolve(process.env.AGENT_UI_INTERACTION_SMOKE_DIR)
  : fs.mkdtempSync(path.join(tmpRoot, 'agent-ui-interaction-lmstudio-'));
const configDir = path.join(runDir, 'config');
const hermesHome = path.join(runDir, 'hermes-home');
const evalDir = path.join(runDir, 'eval');
const screenshotsDir = path.join(runDir, 'screenshots');
const evalToken = crypto.randomBytes(24).toString('hex');
const host = '127.0.0.1';

const lmStudioBaseUrl = String(
  process.env.AGENT_UI_LMSTUDIO_BASE_URL || process.env.LM_BASE_URL || 'http://127.0.0.1:1234/v1',
)
  .trim()
  .replace(/\/+$/, '');
let lmStudioModel = String(process.env.AGENT_UI_LMSTUDIO_MODEL || 'google/gemma-4-26b-a4b').trim();

const sentinels = {
  initial: 'AGENT_UI_INTERACTION_INITIAL_OK',
  followup: 'AGENT_UI_INTERACTION_FOLLOWUP_OK',
};

const evidence = {
  startedAt: new Date().toISOString(),
  command: ['node', path.relative(process.cwd(), __filename), ...process.argv.slice(2)].join(' '),
  appPath,
  appBundle,
  appExecutable,
  runDir,
  configDir,
  hermesHome,
  evalDir,
  screenshotsDir,
  provider: {
    provider: 'lmstudio',
    baseUrl: lmStudioBaseUrl,
    model: lmStudioModel,
  },
  checks: {},
  files: {},
  errors: [],
};

let activeApp = null;
let activePort = '';
let clipboardBefore = null;

function fail(message) {
  throw new Error(message);
}

function assertCondition(condition, message) {
  if (!condition) fail(message);
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function saveJson(name, value) {
  const file = path.join(runDir, `${name}.json`);
  writeJson(file, value);
  evidence.files[name] = file;
  return value;
}

function resolveAppExecutable(value) {
  if (!value.endsWith('.app')) return value;
  const macosDir = path.join(value, 'Contents', 'MacOS');
  try {
    const executable = fs
      .readdirSync(macosDir)
      .map((name) => path.join(macosDir, name))
      .find((file) => {
        try {
          const stat = fs.statSync(file);
          return stat.isFile() && stat.mode & 0o111;
        } catch {
          return false;
        }
      });
    if (executable) return executable;
  } catch {
    // Fall through to the packaged executable name.
  }
  return path.join(macosDir, 'agent-UI');
}

function runCommand(command, args, opts = {}) {
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    input: opts.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: opts.timeoutMs || 30000,
  });
  return {
    command: [command, ...args].join(' '),
    ok: res.status === 0,
    status: res.status,
    signal: res.signal || '',
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || res.error || '').trim(),
  };
}

function appInfo() {
  const infoPlist = path.join(appBundle, 'Contents', 'Info.plist');
  const read = (key, defaultValue) => {
    const res = runCommand('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist], { timeoutMs: 5000 });
    return res.ok && res.stdout ? res.stdout : defaultValue;
  };
  return {
    bundleId: read('CFBundleIdentifier', 'ai.agent-ui.hermes'),
    processName: read('CFBundleName', path.basename(appBundle, '.app')),
  };
}

const appIdentity = appInfo();

async function request(method, url, { headers = {}, body = '', timeoutMs = 5000 } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body || undefined,
    signal: Number(timeoutMs) > 0 ? AbortSignal.timeout(Number(timeoutMs)) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function getJson(route) {
  const res = await request('GET', `http://${host}:${activePort}${route}`, {
    headers: { authorization: `Bearer ${evalToken}` },
  });
  if (res.status < 200 || res.status >= 300) {
    fail(`GET ${route} failed: ${res.status} ${res.text}`);
  }
  return res.json;
}

async function eventStreamOk(url, { headers = {}, timeoutMs = 1000 } = {}) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: Number(timeoutMs) > 0 ? AbortSignal.timeout(Number(timeoutMs)) : undefined,
    });
    const contentType = String(res.headers.get('content-type') || '');
    const ok = res.ok && /text\/event-stream/i.test(contentType);
    if (res.body) await res.body.cancel();
    return ok;
  } catch {
    return false;
  }
}

async function discoverLmStudioModel() {
  if (lmStudioModel) return lmStudioModel;
  const res = await request('GET', `${lmStudioBaseUrl}/models`, { timeoutMs: 5000 });
  if (res.status < 200 || res.status >= 300 || !res.json || !Array.isArray(res.json.data)) {
    fail(`LM Studio model discovery failed: ${res.status} ${res.text}`);
  }
  const entry = res.json.data.find((model) => {
    const id = String((model && model.id) || '').trim();
    return id && !/embedding/i.test(id);
  });
  if (!entry || !entry.id) fail(`LM Studio did not report a usable chat model at ${lmStudioBaseUrl}/models`);
  lmStudioModel = String(entry.id).trim();
  evidence.provider.model = lmStudioModel;
  return lmStudioModel;
}

async function configureLmStudioProvider() {
  const model = await discoverLmStudioModel();
  writeText(
    path.join(hermesHome, 'config.yaml'),
    [
      'model:',
      `  default: ${model}`,
      '  provider: lmstudio',
      `  base_url: ${lmStudioBaseUrl}`,
      '  api_mode: chat_completions',
      '  context_length: 64000',
      'agent:',
      '  max_turns: 4',
      '  reasoning_effort: low',
      'auxiliary:',
      '  compression:',
      '    context_length: 64000',
      'toolsets: []',
      'platforms:',
      '  local_desktop:',
      '    enabled: true',
      '',
    ].join('\n'),
  );
  writeText(
    path.join(hermesHome, '.env'),
    [
      '# Generated by interaction-lmstudio-smoke for isolated real Hermes + LM Studio testing.',
      `LM_BASE_URL=${lmStudioBaseUrl}`,
      '',
    ].join('\n'),
  );
  evidence.files.providerConfig = path.join(hermesHome, 'config.yaml');
}

function executableExists(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.mode & 0o111;
  } catch {
    return false;
  }
}

function directHermesRoot() {
  const home = os.userInfo().homedir || os.homedir();
  return path.join(home, 'Documents', 'hermes', 'hermes-agent');
}

function directHermesCandidates() {
  const root = directHermesRoot();
  return [path.join(root, 'venv', 'bin', 'hermes'), path.join(root, '.venv', 'bin', 'hermes')];
}

function assertRealHermesAvailable() {
  const root = directHermesRoot();
  const remote = runCommand('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeoutMs: 5000 });
  if (!remote.ok || remote.stdout !== 'https://github.com/NousResearch/hermes-agent.git') {
    fail(
      [
        'verify:interaction:lmstudio requires a direct NousResearch Hermes clone.',
        `Expected ${root} origin to be https://github.com/NousResearch/hermes-agent.git.`,
        `Found: ${remote.stdout || remote.stderr || 'missing git remote'}`,
      ].join('\n'),
    );
  }
  const candidates = directHermesCandidates();
  const found = candidates.map((candidate) => path.resolve(candidate)).find(executableExists);
  if (!found) {
    fail(
      [
        'Direct NousResearch Hermes executable is required for verify:interaction:lmstudio.',
        'Install Hermes into ~/Documents/hermes/hermes-agent/venv or ~/Documents/hermes/hermes-agent/.venv.',
        `Searched: ${candidates.join(', ')}`,
      ].join('\n'),
    );
  }
  evidence.realHermes = {
    command: found,
    remote: remote.stdout,
  };
}

function readEnvFile(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  } catch {
    // The app writes the gateway env during startup.
  }
  return out;
}

async function gatewayReadyProbe(timeoutMs = 1000) {
  const env = readEnvFile(path.join(hermesHome, '.env'));
  const port = String(env.LOCAL_DESKTOP_PORT || '').trim();
  const key = String(env.LOCAL_DESKTOP_GATEWAY_KEY || '').trim();
  if (!port || !key) return false;
  const gatewayHost = String(env.LOCAL_DESKTOP_HOST || host).trim() || host;
  const baseUrl = `http://${gatewayHost}:${port}`;
  try {
    const health = await request('GET', `${baseUrl}/health`, { timeoutMs });
    if (health.status < 200 || health.status >= 300) return false;
    const auth = await request('POST', `${baseUrl}/messages`, {
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: '{}',
      timeoutMs,
    });
    if (!(auth.status === 400 && auth.json && auth.json.error === 'missing_conversation_id')) return false;
    return await eventStreamOk(`${baseUrl}/events`, {
      headers: { authorization: `Bearer ${key}` },
      timeoutMs,
    });
  } catch {
    return false;
  }
}

async function waitForGatewayReady(label, timeoutMs = 45000) {
  const startedAt = Date.now();
  let nextLogAt = 0;
  while (Date.now() - startedAt <= timeoutMs) {
    const logTail =
      activeApp && activeApp.logFile && fs.existsSync(activeApp.logFile)
        ? fs.readFileSync(activeApp.logFile, 'utf8').slice(-4000)
        : '';
    if (/Hermes executable is missing/i.test(logTail)) {
      fail(`Hermes gateway prerequisite failed for ${label}\n--- app log ---\n${logTail}`);
    }
    if (await gatewayReadyProbe()) {
      evidence.checks[`gateway-${label}`] = { ok: true, waitedMs: Date.now() - startedAt };
      return;
    }
    if (Date.now() >= nextLogAt) {
      console.log(`[agent-ui] waiting for real Hermes gateway readiness (${label})`);
      nextLogAt = Date.now() + 5000;
    }
    await sleep(250);
  }
  fail(`Hermes gateway was not ready for ${label}`);
}

async function startApp(label) {
  const portFile = path.join(runDir, `eval-port-${label}.txt`);
  const logFile = path.join(runDir, `app-${label}.log`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(appExecutable, [], {
    env: {
      ...process.env,
      AGENT_UI_EVAL: '1',
      AGENT_UI_EVAL_RUN_ID: `interaction-${label}`,
      AGENT_UI_EVAL_DIR: evalDir,
      AGENT_UI_EVAL_PORT_FILE: portFile,
      AGENT_UI_EVAL_TOKEN: evalToken,
      AGENT_UI_CONFIG_DIR: configDir,
      AGENT_UI_HERMES_HOME: hermesHome,
      AGENT_UI_HERMES_BIN: evidence.realHermes.command,
      LM_BASE_URL: lmStudioBaseUrl,
      HOME: process.env.HOME || os.userInfo().homedir,
    },
    stdio: ['ignore', out, out],
  });
  activeApp = { child, logFile, fd: out, label };
  evidence.files[`app-${label}.log`] = logFile;

  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode != null) break;
    if (fs.existsSync(portFile) && fs.statSync(portFile).size > 0) {
      activePort = fs.readFileSync(portFile, 'utf8').trim();
      try {
        const health = await request('GET', `http://${host}:${activePort}/health`, {
          headers: { authorization: `Bearer ${evalToken}` },
        });
        if (health.status === 200) {
          evidence.checks[`eval-${label}`] = { ok: true, port: activePort };
          await waitForGatewayReady(label);
          return;
        }
      } catch {
        // keep waiting
      }
    }
    await sleep(250);
  }

  const logTail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-4000) : '';
  fail(`eval server did not start for ${label}\n--- app log ---\n${logTail}`);
}

async function stopApp() {
  const app = activeApp;
  const port = activePort;
  activeApp = null;
  activePort = '';
  if (port) {
    try {
      await request('POST', `http://${host}:${port}/shutdown`, {
        headers: { authorization: `Bearer ${evalToken}` },
        body: '{}',
        timeoutMs: 2000,
      });
    } catch {
      // Continue to process termination below.
    }
  }
  await sleep(1000);
  if (app && app.child && !app.child.killed) {
    try {
      app.child.kill('SIGTERM');
    } catch {
      // ignore cleanup failures
    }
  }
  if (app && app.fd != null) {
    try {
      fs.closeSync(app.fd);
    } catch {
      // ignore cleanup failures
    }
  }
}

function osaQuoted(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function appProcessBlock(body) {
  const lines = Array.isArray(body) ? body : String(body).split('\n');
  return [
    'tell application "System Events"',
    `  set targetProcesses to (application processes whose bundle identifier is ${osaQuoted(appIdentity.bundleId)})`,
    `  if (count of targetProcesses) is 0 then set targetProcesses to (application processes whose name is ${osaQuoted(appIdentity.processName)})`,
    '  if (count of targetProcesses) is 0 then error "agent-UI process not found for UI automation"',
    '  set targetProcess to item 1 of targetProcesses',
    '  tell targetProcess',
    ...lines.map((line) => `    ${line}`),
    '  end tell',
    'end tell',
  ].join('\n');
}

function runOsa(script, label = 'osascript', timeoutMs = 10000) {
  const res = runCommand('osascript', ['-e', script], { timeoutMs });
  if (!res.ok) {
    fail(`${label} failed. macOS Accessibility permission is required for UI automation.\n${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function assertAssistiveAccessReady() {
  const res = runCommand('osascript', ['-e', 'tell application "System Events" to get UI elements enabled'], {
    timeoutMs: 5000,
  });
  if (!res.ok || !/true/i.test(res.stdout)) {
    fail(
      [
        'macOS Accessibility permission is required for verify:interaction:lmstudio.',
        'Enable assistive access for the terminal/Codex host running this command, then rerun the gate.',
        res.stderr || res.stdout,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

function activateApp() {
  runOsa(appProcessBlock(['set frontmost to true']), 'activate agent-UI');
}

function clickMenuItem(menu, item) {
  runOsa(
    appProcessBlock([
      'set frontmost to true',
      'delay 0.1',
      `click menu item ${osaQuoted(item)} of menu ${osaQuoted(menu)} of menu bar 1`,
    ]),
    `click ${menu} > ${item}`,
  );
}

function pressShortcutC() {
  activateApp();
  runOsa(
    ['tell application "System Events"', '  keystroke "c" using {command down, shift down}', 'end tell'].join('\n'),
    'press Command-Shift-C',
  );
}

function pressKeyCode(code, modifiers = '') {
  activateApp();
  const suffix = modifiers ? ` using ${modifiers}` : '';
  runOsa(
    ['tell application "System Events"', `  key code ${Number(code)}${suffix}`, 'end tell'].join('\n'),
    `press key code ${code}`,
  );
}

function clickAtRect(rect, label, { xRatio = 0.5, yRatio = 0.5 } = {}) {
  assertCondition(rect && Number(rect.width) > 0 && Number(rect.height) > 0, `missing rect for ${label}`);
  const x = Math.round(Number(rect.left) + Number(rect.width) * xRatio);
  const y = Math.round(Number(rect.top) + Number(rect.height) * yRatio);
  const source = [
    'import ApplicationServices',
    'import Darwin',
    `let point = CGPoint(x: ${x}, y: ${y})`,
    'let source = CGEventSource(stateID: .hidSystemState)',
    'if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {',
    '  move.post(tap: .cghidEventTap)',
    '}',
    'usleep(100000)',
    'guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),',
    '      let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {',
    '  fputs("failed to create mouse events\\n", stderr)',
    '  exit(2)',
    '}',
    'down.post(tap: .cghidEventTap)',
    'usleep(25000)',
    'up.post(tap: .cghidEventTap)',
  ].join('\n');
  const res = runCommand('swift', ['-e', source], { timeoutMs: 30000 });
  if (!res.ok) {
    fail(
      `${label} CGEvent click failed. macOS Accessibility permission may be required for real mouse event automation.\n${res.stderr || res.stdout}`,
    );
  }
}

function captureClipboard() {
  const res = runCommand('pbpaste', [], { timeoutMs: 5000 });
  clipboardBefore = res.ok ? res.stdout : '';
}

function setClipboard(text) {
  const res = runCommand('pbcopy', [], { input: text, timeoutMs: 5000 });
  if (!res.ok) fail(`pbcopy failed: ${res.stderr || res.stdout}`);
}

function restoreClipboard() {
  if (clipboardBefore == null) return;
  runCommand('pbcopy', [], { input: clipboardBefore, timeoutMs: 5000 });
  clipboardBefore = null;
}

function pasteText(text) {
  setClipboard(text);
  clickMenuItem('Edit', 'Paste');
}

async function waitUntil(label, fn, timeoutMs = 15000, intervalMs = 150) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  fail(`timed out waiting for ${label}`);
}

async function uiTargets() {
  return getJson('/ui-targets');
}

async function listConversations() {
  const out = await getJson('/conversations');
  return Array.isArray(out && out.conversations) ? out.conversations : [];
}

async function conversation(catId) {
  return getJson(`/conversation?catId=${encodeURIComponent(catId)}`);
}

async function traceEvents() {
  const trace = await getJson('/trace');
  return Array.isArray(trace && trace.events) ? trace.events : [];
}

function gatewayPostEvents(events, catId) {
  return events.filter((event) => {
    if (event.type !== 'gateway_message_post_requested') return false;
    return !catId || String(event.catId || '') === String(catId);
  });
}

function itemTexts(conv, kind) {
  return (conv && Array.isArray(conv.items) ? conv.items : [])
    .filter((item) => !kind || item.kind === kind)
    .map((item) => String(item.text || ''));
}

function assertNoErrorItems(conv, label) {
  const errors = (conv && Array.isArray(conv.items) ? conv.items : []).filter((item) => item.kind === 'error');
  assertCondition(errors.length === 0, `${label} contains error items: ${JSON.stringify(errors)}`);
}

async function waitModalVisible(label) {
  const ui = await waitUntil(`modal visible: ${label}`, async () => {
    const targets = await uiTargets();
    return targets && targets.modal && targets.modal.visible ? targets : null;
  });
  assertCondition(ui.modal.promptRect, `${label}: modal prompt rect was missing`);
  assertCondition(
    ui.modal.activeElement && ui.modal.activeElement.id === 'prompt',
    `${label}: prompt did not have focus`,
  );
  return ui;
}

async function waitModalHidden(label) {
  return waitUntil(`modal hidden: ${label}`, async () => {
    const targets = await uiTargets();
    return targets && (!targets.modal || !targets.modal.visible) ? targets : null;
  });
}

async function waitPromptLength(length, label) {
  return waitUntil(`prompt length ${length}: ${label}`, async () => {
    const targets = await uiTargets();
    return targets.modal && targets.modal.promptValueLength === length ? targets : null;
  });
}

async function waitNewConversation(beforeIds, label) {
  return waitUntil(
    `new conversation: ${label}`,
    async () => {
      const list = await listConversations();
      const next = list.find((item) => !beforeIds.has(String(item.catId || '')));
      return next && next.catId ? String(next.catId) : null;
    },
    20000,
  );
}

async function waitAssistantSentinel(catId, sentinel, label, timeoutMs = 180000) {
  return waitUntil(
    `assistant sentinel ${sentinel}: ${label}`,
    async () => {
      const conv = await conversation(catId);
      const assistant = itemTexts(conv, 'assistant').join('\n');
      if (assistant.includes(sentinel) && String(conv.runStatus || '').toLowerCase() === 'completed') return conv;
      return null;
    },
    timeoutMs,
    500,
  );
}

async function waitGatewayPostCount(catId, count, label) {
  return waitUntil(
    `gateway post count ${count}: ${label}`,
    async () => {
      const posts = gatewayPostEvents(await traceEvents(), catId);
      return posts.length >= count ? posts : null;
    },
    30000,
    250,
  );
}

async function openConversationFromOverlay(catId, label) {
  const target = await waitUntil(
    `overlay row for ${catId}`,
    async () => {
      const ui = await uiTargets();
      const rows = ui && ui.overlay && Array.isArray(ui.overlay.rows) ? ui.overlay.rows : [];
      const row = rows.find((entry) => String(entry.catId || '') === String(catId));
      return row && (row.actionRect || row.rect) ? { ui, row } : null;
    },
    20000,
  );
  clickAtRect(target.row.actionRect || target.row.rect, `${label} overlay row`);
  return waitUntil(
    `conversation window for ${catId}`,
    async () => {
      const ui = await uiTargets();
      return ui && ui.conversation && ui.conversation.visible && String(ui.conversation.catId || '') === String(catId)
        ? ui
        : null;
    },
    10000,
  );
}

async function focusConversationFollowup(label) {
  const ui = await uiTargets();
  assertCondition(ui.conversation && ui.conversation.followupRect, `${label}: missing follow-up input rect`);
  clickAtRect(ui.conversation.followupRect, `${label} follow-up input`);
  return waitUntil(
    `${label}: follow-up input focused`,
    async () => {
      const next = await uiTargets();
      return next.conversation &&
        next.conversation.activeElement &&
        next.conversation.activeElement.id === 'followup-input'
        ? next
        : null;
    },
    5000,
  );
}

function screenshotRect(name, rect) {
  if (!rect || !Number.isFinite(Number(rect.width)) || !Number.isFinite(Number(rect.height))) return null;
  const x = Math.max(0, Math.round(Number(rect.x ?? rect.left ?? 0)));
  const y = Math.max(0, Math.round(Number(rect.y ?? rect.top ?? 0)));
  const w = Math.max(1, Math.round(Number(rect.width)));
  const h = Math.max(1, Math.round(Number(rect.height)));
  const file = path.join(screenshotsDir, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const res = runCommand('screencapture', ['-x', '-R', `${x},${y},${w},${h}`, file], { timeoutMs: 15000 });
  if (!res.ok) fail(`screenshot ${name} failed: ${res.stderr || res.stdout}`);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  assertCondition(size > 512, `screenshot ${name} was empty`);
  evidence.files[`screenshot-${name}`] = file;
  return file;
}

async function runMenuShortcutPromptFollowupJourney() {
  clickMenuItem('File', 'Use Text Input');

  const beforeIds = new Set((await listConversations()).map((entry) => String(entry.catId || '')));
  pressShortcutC();
  const modal = await waitModalVisible('shortcut new session');
  screenshotRect('new-session-modal', modal.modal.bounds);

  const prompt = `Reply exactly: ${sentinels.initial}`;
  clickAtRect(modal.modal.promptRect, 'new session prompt');
  pasteText(prompt);
  await waitPromptLength(prompt.length, 'initial prompt');
  pressKeyCode(36);
  await waitModalHidden('initial submit');

  const catId = await waitNewConversation(beforeIds, 'initial submit');
  const initialPosts = await waitGatewayPostCount(catId, 1, 'initial prompt');
  assertCondition(initialPosts[0].includeContext === true, 'initial prompt did not include Agent UI context');
  assertCondition(
    String(initialPosts[0].conversationId || '') === catId,
    'initial gateway conversation_id did not match the session',
  );

  const initial = await waitAssistantSentinel(catId, sentinels.initial, 'initial prompt');
  assertNoErrorItems(initial, 'initial conversation');
  assertCondition(itemTexts(initial, 'user').includes(prompt), 'initial user prompt was not preserved exactly');
  assertCondition(
    String(initial.gatewayConversationId || '') === catId,
    'initial conversation recorded the wrong gateway id',
  );

  const opened = await openConversationFromOverlay(catId, 'completed session');
  screenshotRect('conversation-initial', opened.conversation.bounds);
  await focusConversationFollowup('follow-up');

  const followup = `Reply exactly: ${sentinels.followup}`;
  pasteText(followup);
  await waitUntil(
    'follow-up text pasted',
    async () => {
      const ui = await uiTargets();
      return ui.conversation && ui.conversation.followupValueLength === followup.length ? ui : null;
    },
    5000,
  );
  pressKeyCode(36);

  const followupPosts = await waitGatewayPostCount(catId, 2, 'follow-up');
  const messageIds = followupPosts.map((post) => String(post.messageId || '')).filter(Boolean);
  assertCondition(
    new Set(messageIds).size === 2,
    `initial and follow-up reused gateway message ids: ${messageIds.join(', ')}`,
  );
  assertCondition(followupPosts[1].includeContext === false, 'follow-up unexpectedly included first-message context');
  assertCondition(
    followupPosts.every((post) => String(post.conversationId || '') === catId),
    'follow-up changed gateway conversation_id',
  );

  const finalConversation = await waitAssistantSentinel(catId, sentinels.followup, 'follow-up');
  assertNoErrorItems(finalConversation, 'follow-up conversation');
  assertCondition(
    itemTexts(finalConversation, 'user').includes(followup),
    'follow-up user text was not preserved exactly',
  );
  screenshotRect('conversation-followup', (await uiTargets()).conversation.bounds);

  evidence.checks.menuShortcutPromptFollowup = {
    ok: true,
    catId,
    gatewayConversationId: finalConversation.gatewayConversationId || null,
    gatewayPosts: followupPosts.length,
  };
}

async function cleanup() {
  restoreClipboard();
  await stopApp();
}

(async () => {
  if (process.platform !== 'darwin') fail('verify:interaction:lmstudio is macOS-only.');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.mkdirSync(evalDir, { recursive: true });
  fs.mkdirSync(screenshotsDir, { recursive: true });
  if (!fs.existsSync(appExecutable)) fail(`installed app executable not found: ${appExecutable}`);

  assertRealHermesAvailable();
  await configureLmStudioProvider();
  assertAssistiveAccessReady();
  captureClipboard();
  await startApp('ui');
  await runMenuShortcutPromptFollowupJourney();

  saveJson('trace', await getJson('/trace'));
  evidence.finishedAt = new Date().toISOString();
  evidence.ok = true;
  writeJson(path.join(runDir, 'interaction-lmstudio-summary.json'), evidence);
  console.log(`[agent-ui] interaction LM Studio smoke passed: ${runDir}`);
})()
  .catch(async (error) => {
    evidence.finishedAt = new Date().toISOString();
    evidence.ok = false;
    evidence.errors.push(error && error.stack ? error.stack : String(error));
    try {
      writeJson(path.join(runDir, 'interaction-lmstudio-summary.json'), evidence);
    } catch {
      // ignore final evidence write failures
    }
    await cleanup();
    console.error(`[agent-ui] interaction LM Studio smoke failed: ${error && error.message ? error.message : error}`);
    console.error(`[agent-ui] evidence: ${runDir}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
