'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const {
  defaultHermesHome,
  effectiveGatewayHermesHome,
  ensureGatewayConfigFile,
  ensureGatewayEnvFile,
  ensureGatewayProcess,
  gatewayAuthOk,
  gatewayArgsFor,
  gatewayReadyOk,
  gatewayStartupWaitBudgetMs,
  resolveHermesCommand,
  stopGatewayProcess,
} = require('../src/main/hermes-runtime');

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

function isolateEnv(t) {
  process.env = { ...originalEnv };
  delete process.env.AGENT_UI_CONFIG_DIR;
  delete process.env.AGENT_UI_HERMES_BIN;
  delete process.env.AGENT_UI_HERMES_HOME;
  delete process.env.HERMES_HOME;
  delete process.env.LOCAL_DESKTOP_GATEWAY_KEY;
  delete process.env.LOCAL_DESKTOP_HOST;
  delete process.env.LOCAL_DESKTOP_PORT;
  t.after(() => {
    process.env = { ...originalEnv };
  });
}

test('defaultHermesHome uses the real user home instead of sandbox HOME', (t) => {
  isolateEnv(t);
  const poisonedHome = path.join(os.userInfo().homedir, 'Documents', 'jarvis', '.aura', 'home');
  process.env.HOME = poisonedHome;
  process.env.HERMES_HOME = path.join(poisonedHome, 'hermes-home');

  assert.equal(defaultHermesHome(), path.join(os.userInfo().homedir, '.agent-ui', 'hermes-home'));
  assert.equal(effectiveGatewayHermesHome(), path.join(os.userInfo().homedir, '.agent-ui', 'hermes-home'));
});

test('ensureGatewayEnvFile creates a local desktop gateway env file with a stable secret', (t) => {
  isolateEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-env-'));
  process.env.AGENT_UI_CONFIG_DIR = dir;

  const first = ensureGatewayEnvFile();
  const second = ensureGatewayEnvFile();

  assert.equal(first.file, path.join(dir, 'local-desktop-gateway.env'));
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  assert.equal(first.env.LOCAL_DESKTOP_ALLOWED_USERS, 'local');
  assert.equal(first.env.LOCAL_DESKTOP_ALLOW_ALL_USERS, 'false');
  assert.equal(first.env.LOCAL_DESKTOP_HOST, '127.0.0.1');
  assert.equal(first.env.LOCAL_DESKTOP_PORT, '8766');
  assert.match(first.env.LOCAL_DESKTOP_GATEWAY_KEY, /^[a-f0-9]{64}$/);
  assert.equal(second.env.LOCAL_DESKTOP_GATEWAY_KEY, first.env.LOCAL_DESKTOP_GATEWAY_KEY);
});

test('ensureGatewayEnvFile can rotate the local desktop port without changing the secret', (t) => {
  isolateEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-env-'));
  process.env.AGENT_UI_CONFIG_DIR = dir;

  const first = ensureGatewayEnvFile();
  const second = ensureGatewayEnvFile({ LOCAL_DESKTOP_PORT: '8777' });

  assert.equal(second.env.LOCAL_DESKTOP_GATEWAY_KEY, first.env.LOCAL_DESKTOP_GATEWAY_KEY);
  assert.equal(second.env.LOCAL_DESKTOP_PORT, '8777');
  assert.match(fs.readFileSync(second.file, 'utf8'), /LOCAL_DESKTOP_PORT=8777/);
});

test('ensureGatewayConfigFile creates local desktop platform config', (t) => {
  isolateEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-home-'));

  const result = ensureGatewayConfigFile(dir);
  const body = fs.readFileSync(result.file, 'utf8');

  assert.equal(result.file, path.join(dir, 'config.yaml'));
  assert.equal(result.changed, true);
  assert.equal(fs.statSync(result.file).mode & 0o777, 0o600);
  assert.match(body, /^platforms:/m);
  assert.match(body, /local_desktop:\n    enabled: true/);
});

test('ensureGatewayConfigFile preserves existing platforms while enabling local desktop', (t) => {
  isolateEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-home-'));
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(configPath, [
    'model:',
    '  default: openai-codex/gpt-5.4',
    'platforms:',
    '  telegram:',
    '    enabled: true',
    '    extra:',
    '      reply_prefix: "Hermes:"',
    'display:',
    '  busy_input_mode: steer',
    '',
  ].join('\n'), 'utf8');

  ensureGatewayConfigFile(dir);
  const body = fs.readFileSync(configPath, 'utf8');

  assert.match(body, /model:\n  default: openai-codex\/gpt-5\.4/);
  assert.match(body, /platforms:\n  telegram:\n    enabled: true\n    extra:\n      reply_prefix: "Hermes:"\n  local_desktop:\n    enabled: true\n/);
  assert.match(body, /display:\n  busy_input_mode: steer/);
});

test('ensureGatewayConfigFile re-enables an existing local desktop block', (t) => {
  isolateEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-home-'));
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(configPath, [
    'platforms:',
    '  local_desktop:',
    '    enabled: false',
    '    extra:',
    '      outbox_retention_days: 3',
    '',
  ].join('\n'), 'utf8');

  ensureGatewayConfigFile(dir);
  const body = fs.readFileSync(configPath, 'utf8');

  assert.match(body, /local_desktop:\n    enabled: true\n    extra:\n      outbox_retention_days: 3/);
});

test('ensureGatewayProcess rotates the gateway port when the preferred port is occupied', async (t) => {
  isolateEnv(t);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-port-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-home-'));
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve));
  t.after(() => {
    stopGatewayProcess();
    blocker.close();
  });

  const blockedPort = blocker.address().port;
  process.env.AGENT_UI_CONFIG_DIR = configDir;
  process.env.AGENT_UI_HERMES_HOME = homeDir;
  process.env.AGENT_UI_HERMES_BIN = path.join(configDir, 'missing-hermes');
  ensureGatewayEnvFile({ LOCAL_DESKTOP_PORT: String(blockedPort) });

  const result = await ensureGatewayProcess({ warn() {}, log() {} });
  const env = fs.readFileSync(path.join(configDir, 'local-desktop-gateway.env'), 'utf8');

  assert.equal(result.ok, false);
  assert.match(result.error, /Hermes executable is missing/);
  assert.doesNotMatch(env, new RegExp(`LOCAL_DESKTOP_PORT=${blockedPort}\\b`));
  assert.match(env, /LOCAL_DESKTOP_PORT=\d+/);
});

test('gateway autostart uses replace mode for quit/reopen recovery', () => {
  assert.deepEqual(gatewayArgsFor('/path/to/hermes'), ['gateway', 'run', '--replace']);
});

test('gateway autostart wait covers Hermes replace takeover window', () => {
  assert.ok(gatewayStartupWaitBudgetMs() >= 20_000);
});

test('resolveHermesCommand prefers explicit override', (t) => {
  isolateEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-hermes-bin-'));
  const bin = path.join(dir, 'hermes');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.AGENT_UI_HERMES_BIN = bin;

  const resolved = resolveHermesCommand();

  assert.equal(resolved.command, bin);
  assert.equal(resolved.configured, true);
});

test('resolveHermesCommand does not fall back to PATH or Jarvis Hermes', (t) => {
  isolateEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-fake-path-'));
  const fakeHermes = path.join(dir, 'hermes');
  fs.writeFileSync(fakeHermes, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  process.env.PATH = dir;

  const resolved = resolveHermesCommand();

  assert.notEqual(resolved.command, fakeHermes);
  assert.equal(resolved.configured, false);
  if (resolved.command) {
    assert.match(resolved.command, /build\/hermes-runtime\/bin\/hermes$|Resources\/hermes-runtime\/bin\/hermes$/);
  }
});

test('bundled Hermes launcher uses only prebuilt runtime artifacts', () => {
  const bundler = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'bundle-hermes-runtime.js'), 'utf8');

  assert.match(bundler, /buildEmbeddedPython\(\)/);
  assert.match(bundler, /uv', \['pip', 'install'/);
  assert.match(bundler, /python\/bin\/python3/);
  assert.match(bundler, /"aiohttp", "yaml", "openai", "rich", "sounddevice", "numpy", "faster_whisper"/);
  assert.match(bundler, /embeddedVoiceRuntimeInfo/);
  assert.match(bundler, /libportaudio\.dylib/);
  assert.match(bundler, /AGENT_UI_BUNDLED_PYTHON_ROOT/);
  assert.doesNotMatch(bundler, /USER_VENV_DIR/);
  assert.doesNotMatch(bundler, /HERMES_RUNTIME_VENV/);
  assert.doesNotMatch(bundler, /command -v uv/);
  assert.doesNotMatch(bundler, /\/usr\/bin\/python3 -m venv/);
  assert.doesNotMatch(bundler, /pip install "\$package_spec"/);
  assert.match(bundler, /PYTHONDONTWRITEBYTECODE=1/);
  assert.match(bundler, /PYTHONPATH="\$SRC_DIR"/);
});

test('Hermes bundler overlays the app-owned local desktop platform', () => {
  const bundler = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'bundle-hermes-runtime.js'), 'utf8');
  const pluginDir = path.join(__dirname, '..', 'vendor', 'hermes-platforms', 'local_desktop');
  const manifest = fs.readFileSync(path.join(pluginDir, 'plugin.yaml'), 'utf8');
  const adapter = fs.readFileSync(path.join(pluginDir, 'adapter.py'), 'utf8');

  assert.match(manifest, /^kind: platform$/m);
  assert.match(adapter, /name="local_desktop"/);
  assert.match(adapter, /LOCAL_DESKTOP_GATEWAY_KEY/);
  assert.match(bundler, /vendor', 'hermes-platforms'/);
  assert.match(bundler, /plugins', 'platforms', overlay\.name/);
  assert.match(bundler, /hermesPlatformOverlays/);
});

test('gateway readiness requires authenticated local desktop message access', async (t) => {
  isolateEnv(t);
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({
      url: String(url),
      method: opts.method || 'GET',
      auth: opts.headers && opts.headers.authorization,
      body: opts.body,
    });
    if (String(url).endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: 'missing_conversation_id' }), { status: 400 });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  assert.equal(await gatewayAuthOk('http://127.0.0.1:8766', 'secret'), true);
  assert.equal(await gatewayReadyOk('http://127.0.0.1:8766', 'secret'), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.auth === 'Bearer secret' && call.body === '{}'), true);
});

test('gateway readiness rejects unauthenticated local desktop message access', async (t) => {
  isolateEnv(t);
  global.fetch = async (url) => {
    if (String(url).endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  assert.equal(await gatewayAuthOk('http://127.0.0.1:8766', 'secret'), false);
  assert.equal(await gatewayReadyOk('http://127.0.0.1:8766', 'secret'), false);
});
