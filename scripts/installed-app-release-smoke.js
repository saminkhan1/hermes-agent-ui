'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const defaultBundle = '/Applications/agent-UI Standalone.app';
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
    // Fall through to the historical executable name.
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

const evidence = {
  startedAt: new Date().toISOString(),
  appExecutable,
  runDir,
  configDir,
  hermesHome,
  defaultGatewayPort,
  blockDefaultPort,
  checks: {},
  files: {},
  errors: [],
};

let activeApp = null;
let activePort = '';
let portBlocker = null;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
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

function request(method, url, { headers = {}, body = '', timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode || 0, text, json });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`request timed out: ${url}`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
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
      HOME: process.env.HOME || os.userInfo().homedir,
    },
    stdio: ['ignore', out, out],
  });
  activeApp = { child, logFile, fd: out, label };
  evidence.files[`app-${label}.log`] = logFile;

  for (let i = 0; i < 80; i += 1) {
    if (fs.existsSync(portFile) && fs.statSync(portFile).size > 0) {
      activePort = fs.readFileSync(portFile, 'utf8').trim();
      try {
        const health = await request('GET', `http://${host}:${activePort}/health`, {
          headers: { authorization: `Bearer ${evalToken}` },
        });
        if (health.status === 200) {
          evidence.checks[`eval-${label}`] = { ok: true, port: activePort };
          return;
        }
      } catch {
        // keep waiting
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

async function waitConversation(catId, timeoutMs = 45000) {
  return await postJson('/wait', { catId, timeoutMs }, { timeoutMs: timeoutMs + 5000 });
}

async function conversation(catId) {
  return await getJson(`/conversation?catId=${encodeURIComponent(catId)}`);
}

async function runFirstLaunchChecks() {
  await startApp('first');

  const inputMode = saveJson('set-input-mode', await postJson('/set-input-mode', { mode: 'voice' }));
  assertCondition(inputMode && inputMode.inputMode === 'voice', 'input mode did not switch to voice');

  saveJson('start-background', await postJson('/start', {
    catId: 'bg-smoke',
    prompt: '/background Release background smoke from installed app.',
    closeModal: true,
  }));
  const background = saveJson('wait-background', await waitConversation('bg-smoke'));
  assertCondition(hasText(background.conversation, /Background task started/), 'background mode did not start');

  saveJson('start-followup', await postJson('/start', {
    catId: 'follow-smoke',
    prompt: 'Release followup smoke initial.',
    closeModal: true,
  }));
  saveJson('wait-followup-1', await waitConversation('follow-smoke'));
  saveJson('followup', await postJson('/followup', {
    catId: 'follow-smoke',
    text: 'Release follow-up smoke second.',
  }));
  saveJson('wait-followup-2', await waitConversation('follow-smoke'));
  const follow = saveJson('conversation-followup', await conversation('follow-smoke'));
  const followUsers = itemTexts(follow, 'user');
  assertCondition(follow.runStatus === 'completed', 'follow-up conversation did not complete');
  assertCondition(followUsers.includes('Release followup smoke initial.'), 'missing initial follow-up user item');
  assertCondition(followUsers.includes('Release follow-up smoke second.'), 'missing second follow-up user item');

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
  evidence.checks.firstLaunch = { ok: true };
  await stopApp();
}

async function runReopenChecks() {
  await startApp('second');
  saveJson('start-reopen', await postJson('/start', {
    catId: 'reopen-smoke',
    prompt: 'Release reopen smoke after app restart.',
    closeModal: true,
  }));
  const reopenedWait = saveJson('wait-reopen', await waitConversation('reopen-smoke'));
  const reopenedConversation = saveJson('conversation-reopen', await conversation('reopen-smoke'));
  saveJson('trace-second', await getJson('/trace'));

  assertCondition(reopenedWait && reopenedWait.conversation && reopenedWait.conversation.runStatus === 'completed', 'reopen wait did not complete');
  assertCondition(reopenedConversation && reopenedConversation.runStatus === 'completed', 'reopen conversation did not complete');
  assertNoErrorItems(reopenedWait.conversation, 'wait-reopen');
  assertNoErrorItems(reopenedConversation, 'conversation-reopen');
  evidence.checks.reopen = { ok: true };
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
  ensureDir(runDir);
  ensureDir(configDir);
  ensureDir(hermesHome);
  ensureDir(evalDir);
  if (!fs.existsSync(appExecutable)) {
    throw new Error(`installed app executable not found: ${appExecutable}`);
  }

  portBlocker = await createPortBlocker();
  evidence.portBlocker = portBlocker.server ? { active: true, port: portBlocker.port } : portBlocker;

  const sealBefore = saveJson('app-seal-before', appSealSnapshot('before'));
  await runFirstLaunchChecks();
  await runReopenChecks();
  const sealAfter = saveJson('app-seal-after', appSealSnapshot('after'));
  if (!sealBefore.skipped && !sealAfter.skipped) {
    assertCondition(sealBefore.sha256 === sealAfter.sha256, 'installed app bundle changed after launch');
    evidence.checks.appSeal = { ok: true, before: sealBefore.sha256, after: sealAfter.sha256 };
  }

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
