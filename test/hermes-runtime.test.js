'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  defaultHermesHome,
  ensureGatewayConfigFile,
  ensureGatewayEnvFile,
  gatewayAuthOk,
  gatewayReadyOk,
  resolveHermesCommand,
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

  assert.equal(defaultHermesHome(), path.join(os.userInfo().homedir, '.agent-ui', 'hermes-home'));
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

test('bundled Hermes launcher installs gateway and voice extras and repairs old venvs', () => {
  const bundler = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'bundle-hermes-runtime.js'), 'utf8');

  assert.match(bundler, /package_spec="\$SRC_DIR\[voice,messaging\]"/);
  assert.match(bundler, /EMBEDDED_VENV_DIR="\$ROOT_DIR\/venv"/);
  assert.match(bundler, /buildEmbeddedVenv\(\)/);
  assert.match(bundler, /runtime_deps_available\(\)/);
  assert.match(bundler, /"aiohttp", "yaml", "openai", "rich", "sounddevice", "numpy", "faster_whisper"/);
  assert.match(bundler, /elif ! runtime_deps_available; then/);
  assert.match(bundler, /PYTHONPATH="\$SRC_DIR/);
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
