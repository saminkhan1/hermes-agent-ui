'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { parseEnv } = require('node:util');
const {
  buildStageReportFromTraceFiles,
  discoverTraceFiles,
  listFromCsv,
  markdownReport,
} = require('./eval-stage-report');

const defaultBundle = '/Applications/agent-UI for Hermes.app';
const appArg = String(
  process.argv.slice(2).find((arg) => arg !== '--') || process.env.AGENT_UI_INSTALLED_APP || defaultBundle,
);
const appPath = path.resolve(appArg);
function resolveAppExecutable(value) {
  if (!value.endsWith('.app')) return value;
  const macosDir = path.join(value, 'Contents', 'MacOS');
  try {
    const executable = fs
      .readdirSync(macosDir)
      .map((name) => path.join(macosDir, name))
      .find(executableFile);
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
const providerSmoke = String(process.env.AGENT_UI_INSTALLED_SMOKE_PROVIDER || '')
  .trim()
  .toLowerCase();
const lmStudioBaseUrl = String(
  process.env.AGENT_UI_LMSTUDIO_BASE_URL || process.env.LM_BASE_URL || 'http://127.0.0.1:1234/v1',
)
  .trim()
  .replace(/\/+$/, '');
let lmStudioModel = String(process.env.AGENT_UI_LMSTUDIO_MODEL || '').trim();
const liveResponseSmoke = providerSmoke === 'lmstudio';
const conversationTimeoutMs = Number(
  process.env.AGENT_UI_INSTALLED_SMOKE_WAIT_MS || (liveResponseSmoke ? 180000 : 45000),
);
const liveSentinels = {
  initial: 'AGENT_UI_LMSTUDIO_INITIAL_OK',
  followup: 'AGENT_UI_LMSTUDIO_FOLLOWUP_OK',
  voice: 'AGENT_UI_LMSTUDIO_VOICE_OK',
  reopen: 'AGENT_UI_LMSTUDIO_REOPEN_OK',
  postCancel: 'AGENT_UI_LMSTUDIO_POST_CANCEL_OK',
  concurrent: [
    'AGENT_UI_LMSTUDIO_CONCURRENT_1_OK',
    'AGENT_UI_LMSTUDIO_CONCURRENT_2_OK',
    'AGENT_UI_LMSTUDIO_CONCURRENT_3_OK',
  ],
};
const defaultSmokePhases = providerSmoke ? 'first,reopen' : 'onboarding';
const smokePhases = new Set(
  listFromCsv(process.env.AGENT_UI_INSTALLED_SMOKE_PHASES || defaultSmokePhases).map((phase) => phase.toLowerCase()),
);
const phaseRequiredStageIds = {
  first: [
    'app_ready_ms',
    'shortcut_to_modal_visible_ms',
    'modal_visible_ms',
    'submit_to_session_visible_ms',
    'gateway_ready_ms',
    'gateway_post_ms',
    'submit_to_gateway_accepted_ms',
    'first_gateway_event_ms',
    'voice_recording_ms',
    'voice_transcribing_ms',
    'voice_transcript_ms',
    'conversation_terminal_ms',
  ],
  reopen: [
    'app_ready_ms',
    'quit_reopen_hydration_ms',
    'submit_to_session_visible_ms',
    'gateway_ready_ms',
    'gateway_post_ms',
    'submit_to_gateway_accepted_ms',
    'first_gateway_event_ms',
    'conversation_terminal_ms',
  ],
  concurrency: [
    'app_ready_ms',
    'submit_to_session_visible_ms',
    'gateway_ready_ms',
    'gateway_post_ms',
    'submit_to_gateway_accepted_ms',
    'first_gateway_event_ms',
    'conversation_terminal_ms',
  ],
  onboarding: [
    'app_ready_ms',
    'submit_to_session_visible_ms',
    'gateway_ready_ms',
    'gateway_post_ms',
    'first_gateway_event_ms',
    'conversation_terminal_ms',
  ],
};
const defaultRequiredStageIds = defaultRequiredStageIdsForPhases(smokePhases);
const requiredStageIds = listFromCsv(process.env.AGENT_UI_REQUIRED_STAGE_IDS || defaultRequiredStageIds.join(','));

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
  requiredStageIds,
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

function defaultRequiredStageIdsForPhases(phases) {
  const ids = new Set();
  for (const phase of phases) {
    for (const id of phaseRequiredStageIds[phase] || []) ids.add(id);
  }
  return [...ids];
}

function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    // The app creates the gateway env entries during startup.
    return {};
  }
}

function runCommand(command, args, opts = {}) {
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs || 30000,
    env: opts.env || process.env,
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

function activeHermesHome() {
  return (activeApp && activeApp.hermesHome) || hermesHome;
}

function writeNoProviderConfig(home) {
  writeText(
    path.join(home, 'config.yaml'),
    [
      'agent:',
      '  max_turns: 2',
      '  reasoning_effort: low',
      'platforms:',
      '  local_desktop:',
      '    enabled: true',
      '',
    ].join('\n'),
  );
  writeText(path.join(home, '.env'), '# Generated by installed-app-release-smoke to verify no-provider onboarding.\n');
}

function executableFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
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
  const codesign = runCommand('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], {
    timeoutMs: 60000,
  });
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
  let json;
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
    const id = String((model && model.id) || '').trim();
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
      'platforms:',
      '  local_desktop:',
      '    enabled: true',
      '',
    ].join('\n'),
  );
  writeText(
    path.join(hermesHome, '.env'),
    [
      '# Generated by installed-app-release-smoke for local LM Studio testing.',
      `LM_BASE_URL=${lmStudioBaseUrl}`,
      '',
    ].join('\n'),
  );
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
  const env = readEnvFile(path.join(activeHermesHome(), '.env'));
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
    const logTail =
      activeApp && activeApp.logFile && fs.existsSync(activeApp.logFile)
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
  throw new Error(
    `Hermes gateway did not become ready for ${label} after ${Date.now() - startedAt}ms and ${attempts} probe(s)`,
  );
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
  const errors = (conversation && conversation.items ? conversation.items : []).filter((item) => item.kind === 'error');
  assertCondition(errors.length === 0, `${label} contains error items: ${JSON.stringify(errors)}`);
}

function assertAssistantResponse(conversation, label, sentinel = '') {
  assertNoErrorItems(conversation, label);
  const assistant = itemTexts(conversation, 'assistant').join('\n').trim();
  assertCondition(assistant.length > 0, `${label} did not receive an assistant response`);
  if (sentinel) {
    assertCondition(
      assistant.includes(sentinel),
      `${label} assistant response did not include ${sentinel}: ${assistant}`,
    );
  }
}

function assertActionableProviderSetup(conversation, label) {
  const combined = itemTexts(conversation).join('\n').toLowerCase();
  assertCondition(
    /provider|auth|api key|hermes model|no inference provider|model/.test(combined),
    `${label} did not expose an actionable provider setup/auth message: ${combined}`,
  );
}

function hasActionableProviderSetupText(value) {
  return /provider|auth|api key|hermes model|no inference provider|model/i.test(String(value || ''));
}

function expectedHermesLogLine(line, opts = {}) {
  return (
    /Shutdown context: signal=SIGTERM/.test(line) ||
    /Title generation failed: Request timed out/.test(line) ||
    (opts.allowNoProvider === true && /No inference provider configured/.test(line))
  );
}

function unexpectedHermesLogLines(home, opts = {}) {
  const logsDir = path.join(home, 'logs');
  const findings = [];
  if (!fs.existsSync(logsDir)) return findings;
  for (const file of fs.readdirSync(logsDir).sort()) {
    if (!file.endsWith('.log')) continue;
    const full = path.join(logsDir, file);
    const text = fs.readFileSync(full, 'utf8');
    for (const [idx, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      if (!/(ERROR|WARNING|Traceback|OperationalError|returned error|command not found|unavailable)/.test(line))
        continue;
      if (expectedHermesLogLine(line, opts)) continue;
      findings.push({ file: full, line: idx + 1, text: line.slice(0, 1000) });
    }
  }
  return findings;
}

function assertHermesLogsClean(home = hermesHome, opts = {}) {
  const findings = unexpectedHermesLogLines(home, opts);
  if (!findings.length) {
    evidence.checks.hermesLogs = { ok: true, home };
    return;
  }
  saveJson('unexpected-hermes-logs', { home, findings });
  throw new Error(
    `Hermes logs contain unexpected release-blocking warnings/errors: ${findings[0].file}:${findings[0].line}`,
  );
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

async function startApp(label, opts = {}) {
  const appHermesHome = opts.hermesHome ? path.resolve(String(opts.hermesHome)) : hermesHome;
  fs.mkdirSync(appHermesHome, { recursive: true });
  const portFile = path.join(runDir, `eval-port-${label}.txt`);
  const evalConfigFile = path.join(runDir, 'agent-ui-eval-config.json');
  const bootFile = path.join(runDir, `eval-boot-${label}.jsonl`);
  const logFile = path.join(runDir, `app-${label}.log`);
  const evalTranscript = opts.evalTranscript == null ? '' : String(opts.evalTranscript);
  const extraEnv = { LM_BASE_URL: lmStudioBaseUrl, ...(opts.env || {}) };
  const evalEnv = {
    AGENT_UI_EVAL: '1',
    AGENT_UI_EVAL_RUN_ID: `installed-release-${label}`,
    AGENT_UI_EVAL_DIR: evalDir,
    AGENT_UI_EVAL_PORT_FILE: portFile,
    AGENT_UI_EVAL_TOKEN: evalToken,
    AGENT_UI_EVAL_BOOT_FILE: bootFile,
    AGENT_UI_CONFIG_DIR: configDir,
    AGENT_UI_HERMES_HOME: appHermesHome,
    AGENT_UI_EVAL_TRANSCRIPT: evalTranscript,
    ...extraEnv,
  };
  writeJson(evalConfigFile, evalEnv);
  evidence.files[`eval-config-${label}.json`] = evalConfigFile;
  evidence.files[`eval-boot-${label}.jsonl`] = bootFile;
  const out = fs.openSync(logFile, 'a');
  const child = spawn(appExecutable, [`--agent-ui-eval-config=${evalConfigFile}`], {
    cwd: runDir,
    env: {
      ...process.env,
      ...evalEnv,
      HOME: process.env.HOME || os.userInfo().homedir,
    },
    stdio: ['ignore', out, out],
  });
  activeApp = { child, logFile, fd: out, label, hermesHome: appHermesHome };
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

async function waitConversation(conversationId, timeoutMs = conversationTimeoutMs) {
  let elapsedMs = 0;
  const heartbeatMs = 20000;
  console.log(`[agent-ui] waiting for ${conversationId} conversation`);
  const interval = setInterval(() => {
    elapsedMs += heartbeatMs;
    console.log(`[agent-ui] still waiting for ${conversationId} conversation (${Math.round(elapsedMs / 1000)}s)`);
  }, heartbeatMs);
  try {
    return await postJson('/wait', { conversationId, timeoutMs }, { timeoutMs: timeoutMs + 5000 });
  } finally {
    clearInterval(interval);
  }
}

async function conversation(conversationId) {
  return await getJson(`/conversation?conversationId=${encodeURIComponent(conversationId)}`);
}

async function listConversations() {
  const out = await getJson('/conversations');
  return Array.isArray(out && out.conversations) ? out.conversations : [];
}

async function waitNewConversation(beforeIds, label, timeoutMs = 15000) {
  const startedAt = Date.now();
  let latest = [];
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await listConversations();
    const created = latest.find((entry) => !beforeIds.has(String(entry.conversationId || '')));
    if (created && created.conversationId) return String(created.conversationId);
    await sleep(250);
  }
  saveJson(`conversations-${label}-latest`, { conversations: latest });
  throw new Error(`timed out waiting for new conversation after ${label}`);
}

async function waitForOverlayNotificationCount(count, label, timeoutMs = 10000) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await getJson('/ui-targets');
    const notificationCount = Number((latest && latest.overlay && latest.overlay.notificationCount) || 0);
    if (notificationCount >= count) return latest;
    await sleep(250);
  }
  saveJson(`ui-${label}-latest`, latest || {});
  throw new Error(
    `overlay did not report ${count} session(s) for ${label}: ${JSON.stringify(latest && latest.overlay)}`,
  );
}

async function waitForUiTarget(label, predicate, timeoutMs = 10000) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await getJson('/ui-targets');
    if (predicate(latest)) return latest;
    await sleep(250);
  }
  saveJson(`ui-${label}-latest`, latest || {});
  throw new Error(`timed out waiting for ${label}`);
}

async function runFirstLaunchChecks() {
  const voicePrompt = liveResponseSmoke
    ? `Reply exactly: ${liveSentinels.voice}`
    : 'Release deterministic voice smoke from installed app.';
  await startApp('first', { evalTranscript: voicePrompt });

  const inputMode = saveJson('set-input-mode', await postJson('/set-input-mode', { mode: 'voice' }));
  assertCondition(inputMode && inputMode.inputMode === 'voice', 'input mode did not switch to voice');

  saveJson('open-launcher', await postJson('/open-launcher', { source: 'installed-release-smoke' }));
  saveJson(
    'ui-open-launcher',
    await waitForUiTarget('open-launcher', (targets) => targets && targets.modal && targets.modal.visible === true),
  );
  const voiceReadyTargets = saveJson(
    'ui-voice-transcript-ready',
    await waitForUiTarget(
      'voice-transcript-ready',
      (targets) =>
        targets &&
        targets.modal &&
        targets.modal.visible === true &&
        targets.modal.promptValuePreview === voicePrompt &&
        targets.modal.activeElement &&
        targets.modal.activeElement.id === 'prompt',
      10000,
    ),
  );
  assertCondition(
    String(voiceReadyTargets.modal.visibleTextPreview || '').includes('Review transcript'),
    'voice transcript was not visibly editable before submit',
  );

  const beforeVoiceIds = new Set((await listConversations()).map((entry) => String(entry.conversationId || '')));
  const submittedVoice = saveJson('submit-voice-modal', await postJson('/submit-modal', {}));
  assertCondition(
    submittedVoice && submittedVoice.ok === true,
    `voice modal submit failed: ${JSON.stringify(submittedVoice)}`,
  );
  const voiceConversationId = saveJson('voice-conversation-id', {
    conversationId: await waitNewConversation(beforeVoiceIds, 'voice-submit'),
  }).conversationId;
  const voice = saveJson('wait-voice', await waitConversation(voiceConversationId));
  assertCondition(
    voice && voice.conversation && voice.conversation.runStatus === 'completed',
    'voice smoke did not complete',
  );
  assertCondition(
    itemTexts(voice.conversation, 'user').includes(voicePrompt),
    'voice modal submit did not preserve the transcript prompt',
  );
  if (liveResponseSmoke) {
    assertAssistantResponse(voice.conversation, 'wait-voice', liveSentinels.voice);
  }

  saveJson(
    'start-background',
    await postJson('/start', {
      conversationId: 'bg-smoke',
      prompt: '/background Release background smoke from installed app.',
      closeModal: true,
    }),
  );
  const background = saveJson('wait-background', await waitConversation('bg-smoke'));
  assertCondition(
    background && background.conversation && background.conversation.runStatus === 'completed',
    'background mode did not reach a terminal acknowledgement',
  );
  assertNoErrorItems(background.conversation, 'wait-background');
  assertCondition(hasText(background.conversation, /Background task started/), 'background mode did not start');

  const followInitialPrompt = liveResponseSmoke
    ? `Reply exactly: ${liveSentinels.initial}`
    : 'Release followup smoke initial.';
  const followupPrompt = liveResponseSmoke
    ? `Reply exactly: ${liveSentinels.followup}`
    : 'Release follow-up smoke second.';
  saveJson(
    'start-followup',
    await postJson('/start', {
      conversationId: 'follow-smoke',
      prompt: followInitialPrompt,
      closeModal: true,
    }),
  );
  const followInitial = saveJson('wait-followup-1', await waitConversation('follow-smoke'));
  if (liveResponseSmoke) {
    assertAssistantResponse(followInitial.conversation, 'wait-followup-1', liveSentinels.initial);
  }
  saveJson(
    'followup',
    await postJson('/followup', {
      conversationId: 'follow-smoke',
      text: followupPrompt,
    }),
  );
  saveJson('wait-followup-2', await waitConversation('follow-smoke'));
  const follow = saveJson('conversation-followup', await conversation('follow-smoke'));
  const followUsers = itemTexts(follow, 'user');
  assertCondition(follow.runStatus === 'completed', 'follow-up conversation did not complete');
  assertCondition(followUsers.includes(followInitialPrompt), 'missing initial follow-up user item');
  assertCondition(followUsers.includes(followupPrompt), 'missing second follow-up user item');
  if (liveResponseSmoke) {
    assertAssistantResponse(follow, 'conversation-followup', liveSentinels.followup);
  }

  saveJson(
    'start-cancel',
    await postJson('/start', {
      conversationId: 'cancel-smoke',
      prompt: 'Release cancel smoke; this should accept a cancel command.',
      closeModal: true,
    }),
  );
  await sleep(200);
  const cancel = saveJson('cancel', await postJson('/cancel', { conversationId: 'cancel-smoke' }));
  assertCondition(cancel && cancel.ok === true, `cancel endpoint failed: ${JSON.stringify(cancel)}`);
  try {
    saveJson('wait-cancel', await waitConversation('cancel-smoke'));
  } catch (error) {
    evidence.errors.push(`wait-cancel: ${error && error.message ? error.message : error}`);
  }
  const cancelConversation = saveJson('conversation-cancel', await conversation('cancel-smoke'));
  assertCondition(
    itemTexts(cancelConversation, 'user').includes('Cancel requested.'),
    'cancel conversation lacks Cancel requested item',
  );

  if (liveResponseSmoke) {
    saveJson(
      'start-post-cancel',
      await postJson('/start', {
        conversationId: 'post-cancel-smoke',
        prompt: `Reply exactly: ${liveSentinels.postCancel}`,
        closeModal: true,
      }),
    );
    const postCancel = saveJson('wait-post-cancel', await waitConversation('post-cancel-smoke'));
    assertCondition(
      postCancel && postCancel.conversation && postCancel.conversation.runStatus === 'completed',
      'post-cancel recovery did not complete',
    );
    assertAssistantResponse(postCancel.conversation, 'wait-post-cancel', liveSentinels.postCancel);
  }

  const opened = saveJson(
    'open-conversation',
    await postJson('/open-conversation', { conversationId: 'follow-smoke' }),
  );
  assertCondition(opened && opened.ok === true, 'open-conversation endpoint failed');
  await sleep(1000);
  const uiTargets = saveJson('ui-open-conversation', await getJson('/ui-targets'));
  assertCondition(
    uiTargets && uiTargets.conversation && uiTargets.conversation.visible === true,
    'conversation window was not visible',
  );
  assertCondition(uiTargets.conversation.followupRect, 'conversation follow-up input was not discoverable');

  const envFile = path.join(hermesHome, '.env');
  if (fs.existsSync(envFile)) {
    evidence.files.gatewayEnv = envFile;
    evidence.gatewayEnv = fs.readFileSync(envFile, 'utf8').replace(/(LOCAL_DESKTOP_GATEWAY_KEY=).+/g, '$1<redacted>');
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
  saveJson(
    'start-reopen',
    await postJson('/start', {
      conversationId: 'reopen-smoke',
      prompt: reopenPrompt,
      closeModal: true,
    }),
  );
  const reopenedWait = saveJson('wait-reopen', await waitConversation('reopen-smoke'));
  const reopenedConversation = saveJson('conversation-reopen', await conversation('reopen-smoke'));
  saveJson('trace-second', await getJson('/trace'));

  assertCondition(
    reopenedWait && reopenedWait.conversation && reopenedWait.conversation.runStatus === 'completed',
    'reopen wait did not complete',
  );
  assertCondition(
    reopenedConversation && reopenedConversation.runStatus === 'completed',
    'reopen conversation did not complete',
  );
  assertNoErrorItems(reopenedWait.conversation, 'wait-reopen');
  assertNoErrorItems(reopenedConversation, 'conversation-reopen');
  if (liveResponseSmoke) {
    assertAssistantResponse(reopenedConversation, 'conversation-reopen', liveSentinels.reopen);
  }
  evidence.checks.reopen = { ok: true };
  await stopApp();
}

async function runOnboardingChecks() {
  const onboardingHome = path.join(runDir, 'hermes-home-no-provider');
  const onboardingPrompt = 'Release onboarding smoke should show actionable Hermes provider setup.';
  writeNoProviderConfig(onboardingHome);
  evidence.files.noProviderConfig = path.join(onboardingHome, 'config.yaml');
  await startApp('onboarding', { hermesHome: onboardingHome, env: { LM_BASE_URL: '' } });
  saveJson(
    'start-onboarding',
    await postJson('/start', {
      conversationId: 'onboarding-smoke',
      prompt: onboardingPrompt,
      closeModal: true,
    }),
  );
  const onboarding = saveJson('wait-onboarding', await waitConversation('onboarding-smoke', 90000));
  const conversationSnapshot = onboarding && onboarding.conversation ? onboarding.conversation : null;
  assertCondition(conversationSnapshot, 'onboarding conversation was missing');
  assertCondition(
    itemTexts(conversationSnapshot, 'user').includes(onboardingPrompt),
    'onboarding task was not preserved',
  );
  assertActionableProviderSetup(conversationSnapshot, 'wait-onboarding');
  saveJson(
    'open-onboarding-conversation',
    await postJson('/open-conversation', { conversationId: 'onboarding-smoke' }),
  );
  saveJson(
    'ui-onboarding-actionable',
    await waitForUiTarget(
      'onboarding-actionable-state',
      (targets) =>
        targets &&
        ((targets.auth && targets.auth.visible === true) ||
          (targets.conversation &&
            targets.conversation.visible === true &&
            hasActionableProviderSetupText(targets.conversation.visibleTextPreview))),
      15000,
    ),
  );
  saveJson('trace-onboarding', await getJson('/trace'));
  const latestTargets = saveJson('ui-onboarding-final', await getJson('/ui-targets'));
  await stopApp();
  assertHermesLogsClean(onboardingHome, { allowNoProvider: true });
  evidence.checks.onboarding = {
    ok: true,
    status: String(conversationSnapshot.runStatus || ''),
    hermesLogsClean: true,
    authWindowVisible: !!(latestTargets && latestTargets.auth && latestTargets.auth.visible === true),
    actionableNoProviderVisible: !!(
      latestTargets &&
      latestTargets.conversation &&
      latestTargets.conversation.visible === true &&
      hasActionableProviderSetupText(latestTargets.conversation.visibleTextPreview)
    ),
  };
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
    conversationId: `concurrent-${index + 1}`,
    sentinel,
    prompt: `Reply exactly: ${sentinel}`,
  }));

  const startedAt = Date.now();
  const starts = await Promise.all(
    runs.map((run) =>
      postJson('/start', {
        conversationId: run.conversationId,
        prompt: run.prompt,
        closeModal: true,
      }),
    ),
  );
  saveJson('concurrency-starts', { startedAt, completedAt: Date.now(), starts });
  for (const [index, start] of starts.entries()) {
    assertCondition(
      start && start.ok === true,
      `concurrent start failed for ${runs[index].conversationId}: ${JSON.stringify(start)}`,
    );
  }

  saveJson('ui-concurrency-started', await waitForOverlayNotificationCount(runs.length, 'concurrency-started'));

  const waits = await Promise.all(runs.map((run) => waitConversation(run.conversationId)));
  saveJson('concurrency-waits', { waits });
  const conversations = [];
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    const waited = waits[i];
    assertCondition(waited && waited.ok === true, `${run.conversationId} wait failed: ${JSON.stringify(waited)}`);
    assertCondition(
      waited.conversation && waited.conversation.runStatus === 'completed',
      `${run.conversationId} did not complete`,
    );
    assertAssistantResponse(waited.conversation, run.conversationId, run.sentinel);
    const users = itemTexts(waited.conversation, 'user');
    assertCondition(users.includes(run.prompt), `${run.conversationId} missing its own user prompt`);
    const text = assistantText(waited.conversation);
    for (const other of runs) {
      if (other.conversationId === run.conversationId) continue;
      assertCondition(
        !text.includes(other.sentinel),
        `${run.conversationId} assistant output contains ${other.sentinel}`,
      );
    }
    conversations.push(waited.conversation);
  }

  const gatewayConversationIds = conversations
    .map((conversation) => String(conversation.gatewayConversationId || '').trim())
    .filter(Boolean);
  assertCondition(
    new Set(gatewayConversationIds).size === runs.length,
    `concurrent gateway ids were not distinct: ${gatewayConversationIds.join(', ')}`,
  );

  const listed = saveJson('concurrency-list', await getJson('/conversations'));
  const listedIds = new Set(((listed && listed.conversations) || []).map((item) => String(item.conversationId || '')));
  for (const run of runs) {
    assertCondition(listedIds.has(run.conversationId), `${run.conversationId} missing from conversation list`);
    saveJson(`conversation-${run.conversationId}`, await conversation(run.conversationId));
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
  if (smokePhases.has('onboarding')) await runOnboardingChecks();
  const sealAfter = saveJson('app-seal-after', appSealSnapshot('after'));
  if (!sealBefore.skipped && !sealAfter.skipped) {
    assertCondition(sealBefore.sha256 === sealAfter.sha256, 'installed app bundle changed after launch');
    evidence.checks.appSeal = { ok: true, before: sealBefore.sha256, after: sealAfter.sha256 };
  }
  const traceFiles = discoverTraceFiles([evalDir]);
  const stageReport = buildStageReportFromTraceFiles(traceFiles, {
    minRuns: Number(process.env.AGENT_UI_STAGE_REPORT_MIN_RUNS || 5),
    requiredStageIds,
  });
  const stageReportJson = path.join(runDir, 'stage-report.json');
  const stageReportMarkdown = path.join(runDir, 'stage-report.md');
  writeJson(stageReportJson, stageReport);
  writeText(stageReportMarkdown, markdownReport(stageReport));
  evidence.files.stageReport = stageReportJson;
  evidence.files.stageReportMarkdown = stageReportMarkdown;
  evidence.checks.stageReport = {
    ok: stageReport.ok,
    runCount: stageReport.runCount,
    traceFiles: stageReport.traceFiles.length,
    findings: stageReport.findings.length,
    errors: stageReport.findings.filter((finding) => finding.severity === 'error').length,
  };
  assertCondition(stageReport.ok, `stage report has required coverage gaps; see ${stageReportMarkdown}`);
  assertHermesLogsClean(hermesHome);

  evidence.finishedAt = new Date().toISOString();
  evidence.ok = true;
  writeJson(path.join(runDir, 'installed-release-smoke-summary.json'), evidence);
  console.log(`[agent-ui] installed app release smoke passed: ${runDir}`);
})()
  .catch(async (error) => {
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
  })
  .finally(async () => {
    await cleanup();
  });
