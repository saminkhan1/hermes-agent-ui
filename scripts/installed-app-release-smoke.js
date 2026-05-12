'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const {
  buildStageReportFromTraceFiles,
  discoverTraceFiles,
  markdownReport,
} = require('./eval-stage-report');

const defaultBundle = '/Applications/agent-UI for Hermes.app';
const appArg = String(process.argv[2] || process.env.AGENT_UI_INSTALLED_APP || defaultBundle);
const appPath = path.resolve(appArg);
function resolveAppExecutable(value) {
  if (!value.endsWith('.app')) return value;
  const macosDir = path.join(value, 'Contents', 'MacOS');
  try {
    const executable = fs.readdirSync(macosDir)
      .map((name) => path.join(macosDir, name))
      .find((file) => {
        try {
          return fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111);
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
const appExecutable = resolveAppExecutable(appPath);
const tmpRoot = fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir();
const runDir = process.env.AGENT_UI_INSTALLED_SMOKE_DIR
  ? path.resolve(process.env.AGENT_UI_INSTALLED_SMOKE_DIR)
  : fs.mkdtempSync(path.join(tmpRoot, 'agent-ui-installed-release-smoke-'));
const configDir = path.join(runDir, 'config');
const hermesHome = path.join(runDir, 'hermes-home');
const evalDir = path.join(runDir, 'eval');
const evalToken = crypto.randomBytes(24).toString('hex');
const host = '127.0.0.1';
const defaultGatewayPort = Number(process.env.AGENT_UI_INSTALLED_SMOKE_DEFAULT_PORT || 8766);
const blockDefaultPort = String(process.env.AGENT_UI_INSTALLED_SMOKE_BLOCK_DEFAULT_PORT || '1') !== '0';
const providerSmoke = String(process.env.AGENT_UI_INSTALLED_SMOKE_PROVIDER || '').trim().toLowerCase();
const lmStudioBaseUrl = String(
  process.env.AGENT_UI_LMSTUDIO_BASE_URL ||
  process.env.LM_BASE_URL ||
  'http://127.0.0.1:1234/v1'
).trim().replace(/\/+$/, '');
let lmStudioModel = String(process.env.AGENT_UI_LMSTUDIO_MODEL || '').trim();
const liveResponseSmoke = providerSmoke === 'lmstudio';
const conversationTimeoutMs = Number(
  process.env.AGENT_UI_INSTALLED_SMOKE_WAIT_MS ||
  (liveResponseSmoke ? 180000 : 45000)
);
const liveSentinels = {
  initial: 'AGENT_UI_LMSTUDIO_INITIAL_OK',
  followup: 'AGENT_UI_LMSTUDIO_FOLLOWUP_OK',
  reopen: 'AGENT_UI_LMSTUDIO_REOPEN_OK',
  postCancel: 'AGENT_UI_LMSTUDIO_POST_CANCEL_OK',
  concurrent: [
    'AGENT_UI_LMSTUDIO_CONCURRENT_1_OK',
    'AGENT_UI_LMSTUDIO_CONCURRENT_2_OK',
    'AGENT_UI_LMSTUDIO_CONCURRENT_3_OK',
  ],
};
const smokePhases = new Set(
  String(process.env.AGENT_UI_INSTALLED_SMOKE_PHASES || 'first,reopen')
    .split(',')
    .map((phase) => phase.trim().toLowerCase())
    .filter(Boolean)
);

const evidence = {
  startedAt: new Date().toISOString(),
  command: ['node', path.relative(process.cwd(), __filename), ...process.argv.slice(2)].join(' '),
  appPath,
  appExecutable,
  runDir,
  configDir,
  hermesHome,
  defaultGatewayPort,
  blockDefaultPort,
  phases: [...smokePhases],
  checks: {},
  files: {},
  errors: [],
};
if (providerSmoke) {
  evidence.providerSmoke = {
    provider: providerSmoke,
    baseUrl: providerSmoke === 'lmstudio' ? lmStudioBaseUrl : '',
    model: lmStudioModel || null,
    liveResponseSmoke,
  };
}

let activeApp = null;
let activePort = '';
let portBlocker = null;

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

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
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
    // The app creates the gateway env entries during startup.
  }
  return out;
}

function runCommand(command, args, opts = {}) {
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
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

function treeSha256(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const rel = path.relative(root, full);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        files.push({ rel, kind: 'symlink', target: fs.readlinkSync(full) });
      } else if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        files.push({
          rel,
          kind: 'file',
          mode: st.mode & 0o777,
          size: st.size,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
        });
      }
    }
  }
  walk(root);
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(files));
  return { sha256: hash.digest('hex'), fileCount: files.length };
}

function installedAppBundlePath() {
  return appPath.endsWith('.app') ? appPath : path.dirname(path.dirname(path.dirname(appExecutable)));
}

function appSealSnapshot(label) {
  const bundle = installedAppBundlePath();
  if (!bundle.endsWith('.app') || !fs.existsSync(bundle)) {
    return { label, skipped: true, reason: 'not an app bundle', bundle };
  }
  const tree = treeSha256(bundle);
  const codesign = runCommand('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { timeoutMs: 60000 });
  if (!codesign.ok) {
    throw new Error(`codesign verification failed ${label}: ${codesign.stderr || codesign.stdout}`);
  }
  return { label, bundle, ...tree, codesign };
}

async function request(method, url, { headers = {}, body = '', timeoutMs = 5000 } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body || undefined,
    signal: Number(timeoutMs) > 0 ? AbortSignal.timeout(Number(timeoutMs)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
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
    throw new Error(`LM Studio model discovery failed: ${res.status} ${res.text}`);
  }
  const entry = res.json.data.find((model) => {
    const id = String(model && model.id || '').trim();
    return id && !/embedding/i.test(id);
  });
  if (!entry || !entry.id) {
    throw new Error(`LM Studio did not report a usable chat model at ${lmStudioBaseUrl}/models`);
  }
  lmStudioModel = String(entry.id).trim();
  return lmStudioModel;
}

async function configureProviderSmoke() {
  if (!providerSmoke) return;
  if (providerSmoke !== 'lmstudio') {
    throw new Error(`Unsupported AGENT_UI_INSTALLED_SMOKE_PROVIDER=${providerSmoke}`);
  }

  const model = await discoverLmStudioModel();
  writeText(path.join(hermesHome, 'config.yaml'), [
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
  ].join('\n'));
  writeText(path.join(hermesHome, '.env'), [
    '# Generated by installed-app-release-smoke for local LM Studio testing.',
    `LM_BASE_URL=${lmStudioBaseUrl}`,
    '',
  ].join('\n'));
  evidence.providerSmoke = {
    provider: 'lmstudio',
    baseUrl: lmStudioBaseUrl,
    model,
    liveResponseSmoke: true,
  };
  evidence.files.providerConfig = path.join(hermesHome, 'config.yaml');
}

async function getJson(route) {
  const res = await request('GET', `http://${host}:${activePort}${route}`, {
    headers: { authorization: `Bearer ${evalToken}` },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GET ${route} failed: ${res.status} ${res.text}`);
  }
  return res.json;
}

async function postJson(route, payload, opts = {}) {
  const res = await request('POST', `http://${host}:${activePort}${route}`, {
    headers: {
      authorization: `Bearer ${evalToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
    timeoutMs: opts.timeoutMs || 5000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`POST ${route} failed: ${res.status} ${res.text}`);
  }
  return res.json;
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
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / 250) + 20);
  let attempts = 0;
  while (Date.now() - startedAt <= timeoutMs && attempts < maxAttempts) {
    attempts += 1;
    const logTail = activeApp && activeApp.logFile && fs.existsSync(activeApp.logFile)
      ? fs.readFileSync(activeApp.logFile, 'utf8').slice(-4000)
      : '';
    if (/Hermes executable is missing/i.test(logTail)) {
      throw new Error(`Hermes gateway prerequisite failed for ${label}\n--- app log ---\n${logTail}`);
    }
    if (await gatewayReadyProbe()) {
      evidence.checks[`gateway-${label}`] = { ok: true, waitedMs: Date.now() - startedAt, attempts };
      return;
    }
    if (Date.now() >= nextLogAt) {
      console.log(`[agent-ui] waiting for Hermes gateway readiness (${label})`);
      nextLogAt = Date.now() + 5000;
    }
    await sleep(250);
  }
  throw new Error(`Hermes gateway did not become ready for ${label} after ${Date.now() - startedAt}ms and ${attempts} probe(s)`);
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function itemTexts(conversation, kind) {
  return (conversation && conversation.items ? conversation.items : [])
    .filter((item) => !kind || item.kind === kind)
    .map((item) => String(item.text || ''));
}

function hasText(conversation, pattern) {
  return itemTexts(conversation).some((text) => pattern.test(text));
}

function assertNoErrorItems(conversation, label) {
  const errors = (conversation && conversation.items ? conversation.items : [])
    .filter((item) => item.kind === 'error');
  assertCondition(errors.length === 0, `${label} contains error items: ${JSON.stringify(errors)}`);
}

function assertAssistantResponse(conversation, label, sentinel = '') {
  assertNoErrorItems(conversation, label);
  const assistant = itemTexts(conversation, 'assistant').join('\n').trim();
  assertCondition(assistant.length > 0, `${label} did not receive an assistant response`);
  if (sentinel) {
    assertCondition(assistant.includes(sentinel), `${label} assistant response did not include ${sentinel}: ${assistant}`);
  }
}

function createPortBlocker() {
  return new Promise((resolve) => {
    if (!blockDefaultPort) {
      resolve({ active: false, reason: 'disabled' });
      return;
    }
    const server = net.createServer();
    server.once('error', (error) => {
      resolve({ active: false, reason: error && error.code ? error.code : String(error) });
    });
    server.listen({ host, port: defaultGatewayPort, exclusive: true }, () => {
      resolve({ active: true, port: defaultGatewayPort, server });
    });
  });
}

async function startApp(label) {
  const portFile = path.join(runDir, `eval-port-${label}.txt`);
  const logFile = path.join(runDir, `app-${label}.log`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(appExecutable, [], {
    env: {
      ...process.env,
      AGENT_UI_EVAL: '1',
      AGENT_UI_EVAL_RUN_ID: `installed-release-${label}`,
      AGENT_UI_EVAL_DIR: evalDir,
      AGENT_UI_EVAL_PORT_FILE: portFile,
      AGENT_UI_EVAL_TOKEN: evalToken,
      AGENT_UI_CONFIG_DIR: configDir,
      AGENT_UI_HERMES_HOME: hermesHome,
      LM_BASE_URL: lmStudioBaseUrl,
      HOME: process.env.HOME || os.userInfo().homedir,
    },
    stdio: ['ignore', out, out],
  });
  activeApp = { child, logFile, fd: out, label };
  evidence.files[`app-${label}.log`] = logFile;

  for (let i = 0; i < 80; i += 1) {
    if (fs.existsSync(portFile) && fs.statSync(portFile).size > 0) {
      activePort = fs.readFileSync(portFile, 'utf8').trim();
      let evalReady = false;
      try {
        const health = await request('GET', `http://${host}:${activePort}/health`, {
          headers: { authorization: `Bearer ${evalToken}` },
        });
        if (health.status === 200) {
          evalReady = true;
        }
      } catch {
        // keep waiting
      }
      if (evalReady) {
        evidence.checks[`eval-${label}`] = { ok: true, port: activePort };
        await waitForGatewayReady(label);
        return;
      }
    }
    await sleep(250);
  }

  const logTail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-4000) : '';
  throw new Error(`eval server did not start for ${label}\n--- app log ---\n${logTail}`);
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
      });
    } catch {
      // ignore shutdown transport errors; process kill below is the fallback.
    }
  }
  if (app && app.child && !app.child.killed) {
    try {
      app.child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  await sleep(1000);
  if (app && app.fd != null) {
    try {
      fs.closeSync(app.fd);
    } catch {
      // ignore
    }
  }
}

async function waitConversation(catId, timeoutMs = conversationTimeoutMs) {
  let elapsedMs = 0;
  const heartbeatMs = 20000;
  console.log(`[agent-ui] waiting for ${catId} conversation`);
  const interval = setInterval(() => {
    elapsedMs += heartbeatMs;
    console.log(`[agent-ui] still waiting for ${catId} conversation (${Math.round(elapsedMs / 1000)}s)`);
  }, heartbeatMs);
  try {
    return await postJson('/wait', { catId, timeoutMs }, { timeoutMs: timeoutMs + 5000 });
  } finally {
    clearInterval(interval);
  }
}

async function conversation(catId) {
  return await getJson(`/conversation?catId=${encodeURIComponent(catId)}`);
}

async function waitForOverlayNotificationCount(count, label, timeoutMs = 10000) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await getJson('/ui-targets');
    const notificationCount = Number(latest && latest.overlay && latest.overlay.notificationCount || 0);
    if (notificationCount >= count) return latest;
    await sleep(250);
  }
  saveJson(`ui-${label}-latest`, latest || {});
  throw new Error(`overlay did not report ${count} session(s) for ${label}: ${JSON.stringify(latest && latest.overlay)}`);
}

async function runFirstLaunchChecks() {
  await startApp('first');

  const inputMode = saveJson('set-input-mode', await postJson('/set-input-mode', { mode: 'voice' }));
  assertCondition(inputMode && inputMode.inputMode === 'voice', 'input mode did not switch to voice');

  saveJson('open-launcher', await postJson('/open-launcher', { source: 'installed-release-smoke' }));
  for (let i = 0; i < 40; i += 1) {
    const targets = await getJson('/ui-targets');
    if (targets && targets.modal && targets.modal.visible === true) {
      saveJson('ui-open-launcher', targets);
      break;
    }
    await sleep(100);
  }
  const launcherTargets = readJson(path.join(runDir, 'ui-open-launcher.json'));
  assertCondition(launcherTargets && launcherTargets.modal && launcherTargets.modal.visible === true, 'launcher modal was not visible');
  saveJson('close-launcher', await postJson('/close-modal', {}));

  saveJson('start-background', await postJson('/start', {
    catId: 'bg-smoke',
    prompt: '/background Release background smoke from installed app.',
    closeModal: true,
  }));
  const background = saveJson('wait-background', await waitConversation('bg-smoke'));
  assertCondition(hasText(background.conversation, /Background task started/), 'background mode did not start');

  const followInitialPrompt = liveResponseSmoke
    ? `Reply exactly: ${liveSentinels.initial}`
    : 'Release followup smoke initial.';
  const followupPrompt = liveResponseSmoke
    ? `Reply exactly: ${liveSentinels.followup}`
    : 'Release follow-up smoke second.';
  saveJson('start-followup', await postJson('/start', {
    catId: 'follow-smoke',
    prompt: followInitialPrompt,
    closeModal: true,
  }));
  const followInitial = saveJson('wait-followup-1', await waitConversation('follow-smoke'));
  if (liveResponseSmoke) {
    assertAssistantResponse(followInitial.conversation, 'wait-followup-1', liveSentinels.initial);
  }
  saveJson('followup', await postJson('/followup', {
    catId: 'follow-smoke',
    text: followupPrompt,
  }));
  saveJson('wait-followup-2', await waitConversation('follow-smoke'));
  const follow = saveJson('conversation-followup', await conversation('follow-smoke'));
  const followUsers = itemTexts(follow, 'user');
  assertCondition(follow.runStatus === 'completed', 'follow-up conversation did not complete');
  assertCondition(followUsers.includes(followInitialPrompt), 'missing initial follow-up user item');
  assertCondition(followUsers.includes(followupPrompt), 'missing second follow-up user item');
  if (liveResponseSmoke) {
    assertAssistantResponse(follow, 'conversation-followup', liveSentinels.followup);
  }

  saveJson('start-cancel', await postJson('/start', {
    catId: 'cancel-smoke',
    prompt: 'Release cancel smoke; this should accept a cancel command.',
    closeModal: true,
  }));
  await sleep(200);
  const cancel = saveJson('cancel', await postJson('/cancel', { catId: 'cancel-smoke' }));
  assertCondition(cancel && cancel.ok === true, `cancel endpoint failed: ${JSON.stringify(cancel)}`);
  try {
    saveJson('wait-cancel', await waitConversation('cancel-smoke'));
  } catch (error) {
    evidence.errors.push(`wait-cancel: ${error && error.message ? error.message : error}`);
  }
  const cancelConversation = saveJson('conversation-cancel', await conversation('cancel-smoke'));
  assertCondition(itemTexts(cancelConversation, 'user').includes('Cancel requested.'), 'cancel conversation lacks Cancel requested item');

  if (liveResponseSmoke) {
    saveJson('start-post-cancel', await postJson('/start', {
      catId: 'post-cancel-smoke',
      prompt: `Reply exactly: ${liveSentinels.postCancel}`,
      closeModal: true,
    }));
    const postCancel = saveJson('wait-post-cancel', await waitConversation('post-cancel-smoke'));
    assertCondition(postCancel && postCancel.conversation && postCancel.conversation.runStatus === 'completed', 'post-cancel recovery did not complete');
    assertAssistantResponse(postCancel.conversation, 'wait-post-cancel', liveSentinels.postCancel);
  }

  const opened = saveJson('open-conversation', await postJson('/open-conversation', { catId: 'follow-smoke' }));
  assertCondition(opened && opened.ok === true, 'open-conversation endpoint failed');
  await sleep(1000);
  const uiTargets = saveJson('ui-open-conversation', await getJson('/ui-targets'));
  assertCondition(uiTargets && uiTargets.conversation && uiTargets.conversation.visible === true, 'conversation window was not visible');
  assertCondition(uiTargets.conversation.followupRect, 'conversation follow-up input was not discoverable');

  const envFile = path.join(hermesHome, '.env');
  if (fs.existsSync(envFile)) {
    evidence.files.gatewayEnv = envFile;
    evidence.gatewayEnv = fs.readFileSync(envFile, 'utf8')
      .replace(/(LOCAL_DESKTOP_GATEWAY_KEY=).+/g, '$1<redacted>');
  }
  saveJson('trace-first', await getJson('/trace'));
  evidence.checks.firstLaunch = { ok: true };
  await stopApp();
}

async function runReopenChecks() {
  await startApp('second');
  const reopenPrompt = liveResponseSmoke
    ? `Reply exactly: ${liveSentinels.reopen}`
    : 'Release reopen smoke after app restart.';
  saveJson('start-reopen', await postJson('/start', {
    catId: 'reopen-smoke',
    prompt: reopenPrompt,
    closeModal: true,
  }));
  const reopenedWait = saveJson('wait-reopen', await waitConversation('reopen-smoke'));
  const reopenedConversation = saveJson('conversation-reopen', await conversation('reopen-smoke'));
  saveJson('trace-second', await getJson('/trace'));

  assertCondition(reopenedWait && reopenedWait.conversation && reopenedWait.conversation.runStatus === 'completed', 'reopen wait did not complete');
  assertCondition(reopenedConversation && reopenedConversation.runStatus === 'completed', 'reopen conversation did not complete');
  assertNoErrorItems(reopenedWait.conversation, 'wait-reopen');
  assertNoErrorItems(reopenedConversation, 'conversation-reopen');
  if (liveResponseSmoke) {
    assertAssistantResponse(reopenedConversation, 'conversation-reopen', liveSentinels.reopen);
  }
  evidence.checks.reopen = { ok: true };
  await stopApp();
}

function assistantText(conversation) {
  return itemTexts(conversation, 'assistant').join('\n').trim();
}

async function runConcurrencyChecks() {
  if (!liveResponseSmoke) {
    throw new Error('concurrency phase requires AGENT_UI_INSTALLED_SMOKE_PROVIDER=lmstudio');
  }
  await startApp('concurrency');
  const runs = liveSentinels.concurrent.map((sentinel, index) => ({
    catId: `concurrent-${index + 1}`,
    sentinel,
    prompt: `Reply exactly: ${sentinel}`,
  }));

  const startedAt = Date.now();
  const starts = await Promise.all(runs.map((run) => postJson('/start', {
    catId: run.catId,
    prompt: run.prompt,
    closeModal: true,
  })));
  saveJson('concurrency-starts', { startedAt, completedAt: Date.now(), starts });
  for (const [index, start] of starts.entries()) {
    assertCondition(start && start.ok === true, `concurrent start failed for ${runs[index].catId}: ${JSON.stringify(start)}`);
  }

  saveJson('ui-concurrency-started', await waitForOverlayNotificationCount(runs.length, 'concurrency-started'));

  const waits = await Promise.all(runs.map((run) => waitConversation(run.catId)));
  saveJson('concurrency-waits', { waits });
  const conversations = [];
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    const waited = waits[i];
    assertCondition(waited && waited.ok === true, `${run.catId} wait failed: ${JSON.stringify(waited)}`);
    assertCondition(waited.conversation && waited.conversation.runStatus === 'completed', `${run.catId} did not complete`);
    assertAssistantResponse(waited.conversation, run.catId, run.sentinel);
    const users = itemTexts(waited.conversation, 'user');
    assertCondition(users.includes(run.prompt), `${run.catId} missing its own user prompt`);
    const text = assistantText(waited.conversation);
    for (const other of runs) {
      if (other.catId === run.catId) continue;
      assertCondition(!text.includes(other.sentinel), `${run.catId} assistant output contains ${other.sentinel}`);
    }
    conversations.push(waited.conversation);
  }

  const gatewayConversationIds = conversations
    .map((conversation) => String(conversation.gatewayConversationId || '').trim())
    .filter(Boolean);
  assertCondition(new Set(gatewayConversationIds).size === runs.length, `concurrent gateway ids were not distinct: ${gatewayConversationIds.join(', ')}`);

  const listed = saveJson('concurrency-list', await getJson('/conversations'));
  const listedIds = new Set(((listed && listed.conversations) || []).map((item) => String(item.catId || '')));
  for (const run of runs) {
    assertCondition(listedIds.has(run.catId), `${run.catId} missing from conversation list`);
    saveJson(`conversation-${run.catId}`, await conversation(run.catId));
  }

  saveJson('trace-concurrency', await getJson('/trace'));
  evidence.checks.concurrency3 = { ok: true, count: runs.length };
  await stopApp();
}

async function cleanup() {
  await stopApp();
  if (portBlocker && portBlocker.server) {
    try {
      portBlocker.server.close();
    } catch {
      // ignore
    }
  }
}

(async () => {
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.mkdirSync(evalDir, { recursive: true });
  if (!fs.existsSync(appExecutable)) {
    throw new Error(`installed app executable not found: ${appExecutable}`);
  }
  await configureProviderSmoke();

  portBlocker = await createPortBlocker();
  evidence.portBlocker = portBlocker.server ? { active: true, port: portBlocker.port } : portBlocker;

  const sealBefore = saveJson('app-seal-before', appSealSnapshot('before'));
  if (smokePhases.has('first')) await runFirstLaunchChecks();
  if (smokePhases.has('reopen')) await runReopenChecks();
  if (smokePhases.has('concurrency')) await runConcurrencyChecks();
  const sealAfter = saveJson('app-seal-after', appSealSnapshot('after'));
  if (!sealBefore.skipped && !sealAfter.skipped) {
    assertCondition(sealBefore.sha256 === sealAfter.sha256, 'installed app bundle changed after launch');
    evidence.checks.appSeal = { ok: true, before: sealBefore.sha256, after: sealAfter.sha256 };
  }
  const traceFiles = discoverTraceFiles([evalDir]);
  const stageReport = buildStageReportFromTraceFiles(traceFiles, {
    minRuns: Number(process.env.AGENT_UI_STAGE_REPORT_MIN_RUNS || 5),
  });
  const stageReportJson = path.join(runDir, 'stage-report.json');
  const stageReportMarkdown = path.join(runDir, 'stage-report.md');
  writeJson(stageReportJson, stageReport);
  writeText(stageReportMarkdown, markdownReport(stageReport));
  evidence.files.stageReport = stageReportJson;
  evidence.files.stageReportMarkdown = stageReportMarkdown;
  evidence.checks.stageReport = {
    ok: true,
    runCount: stageReport.runCount,
    traceFiles: stageReport.traceFiles.length,
    findings: stageReport.findings.length,
  };

  evidence.finishedAt = new Date().toISOString();
  evidence.ok = true;
  writeJson(path.join(runDir, 'installed-release-smoke-summary.json'), evidence);
  console.log(`[agent-ui] installed app release smoke passed: ${runDir}`);
})().catch(async (error) => {
  evidence.finishedAt = new Date().toISOString();
  evidence.ok = false;
  evidence.errors.push(error && error.stack ? error.stack : String(error));
  try {
    writeJson(path.join(runDir, 'installed-release-smoke-summary.json'), evidence);
  } catch {
    // ignore final evidence write failures
  }
  await cleanup();
  console.error(`[agent-ui] installed app release smoke failed: ${error && error.message ? error.message : error}`);
  console.error(`[agent-ui] evidence: ${runDir}`);
  process.exitCode = 1;
}).finally(async () => {
  await cleanup();
});
