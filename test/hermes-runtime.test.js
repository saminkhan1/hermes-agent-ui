'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const {
  defaultConnectorHermesCandidates,
} = require('../src/main/hermes-release');

const {
  defaultHermesHome,
  effectiveGatewayHermesHome,
  ensureGatewayConfigFile,
  ensureGatewayEnvFile,
  ensureGatewayProcess,
  gatewayAuthOk,
  gatewayArgsFor,
  gatewayEventsOk,
  gatewayReadyOk,
  gatewayStartupWaitBudgetMs,
  resolveHermesCommand,
  stopGatewayProcess,
} = require('../src/main/hermes-runtime');

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const originalCreateServer = net.createServer;

function mockCreateServer(t, isOccupied) {
  net.createServer = () => {
    const listeners = new Map();
    return {
      once(event, handler) {
        listeners.set(event, handler);
        return this;
      },
      off(event, handler) {
        if (listeners.get(event) === handler) listeners.delete(event);
        return this;
      },
      close() {
        return this;
      },
      listen(options, callback) {
        const port = Number(options && options.port) || 0;
        if (isOccupied(port)) {
          queueMicrotask(() => {
            const handler = listeners.get('error');
            if (handler) handler(new Error('occupied'));
          });
          return this;
        }
        queueMicrotask(() => {
          if (typeof callback === 'function') callback();
        });
        return this;
      },
    };
  };
  t.after(() => {
    net.createServer = originalCreateServer;
  });
}

function isolateEnv(t) {
  process.env = { ...originalEnv };
  delete process.env.AGENT_UI_CONFIG_DIR;
  delete process.env.AGENT_UI_HERMES_BIN;
  delete process.env.AGENT_UI_HERMES_HOME;
  delete process.env.AGENT_UI_HERMES_ENV_PATH;
  delete process.env.AGENT_UI_HERMES_GATEWAY_URL;
  delete process.env.AGENT_UI_RELEASE_MODE;
  delete process.env.AGENT_UI_RELEASE_FLAVOR;
  delete process.env.AGENT_UI_CONNECTOR_GATEWAY_RESTART_APPROVED;
  delete process.env.AGENT_UI_HERMES_GATEWAY_AUTOSTART;
  delete process.env.HERMES_HOME;
  delete process.env.LOCAL_DESKTOP_GATEWAY_KEY;
  delete process.env.LOCAL_DESKTOP_HOST;
  delete process.env.LOCAL_DESKTOP_PORT;
  delete process.env.LOCAL_DESKTOP_HOME_CHANNEL;
  delete process.env.LOCAL_DESKTOP_HOME_CHANNEL_NAME;
  t.after(() => {
    process.env = { ...originalEnv };
  });
}

test('defaultHermesHome uses the real user home instead of sandbox HOME', (t) => {
  isolateEnv(t);
  const poisonedHome = path.join(os.userInfo().homedir, 'Documents', 'hermes', '.aura', 'home');
  process.env.HOME = poisonedHome;
  process.env.HERMES_HOME = path.join(poisonedHome, 'hermes-home');

  assert.equal(defaultHermesHome(), path.join(os.userInfo().homedir, '.agent-ui', 'hermes-home'));
  assert.equal(effectiveGatewayHermesHome(), path.join(os.userInfo().homedir, '.agent-ui', 'hermes-home'));
});

test('ensureGatewayEnvFile creates a local desktop gateway env file with a stable secret', (t) => {
  isolateEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-env-'));
  process.env.AGENT_UI_CONFIG_DIR = dir;
  process.env.AGENT_UI_HERMES_HOME = path.join(dir, 'hermes-home');

  const first = ensureGatewayEnvFile();
  const second = ensureGatewayEnvFile();

  assert.equal(first.file, path.join(dir, 'hermes-home', '.env'));
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  assert.equal(first.env.LOCAL_DESKTOP_ALLOWED_USERS, 'local');
  assert.equal(first.env.LOCAL_DESKTOP_ALLOW_ALL_USERS, 'false');
  assert.equal(first.env.LOCAL_DESKTOP_HOST, '127.0.0.1');
  assert.equal(first.env.LOCAL_DESKTOP_PORT, '8766');
  assert.equal(first.env.LOCAL_DESKTOP_HOME_CHANNEL, 'agent-ui');
  assert.equal(first.env.LOCAL_DESKTOP_HOME_CHANNEL_NAME, 'Agent UI');
  assert.match(first.env.LOCAL_DESKTOP_GATEWAY_KEY, /^[a-f0-9]{64}$/);
  assert.equal(second.env.LOCAL_DESKTOP_GATEWAY_KEY, first.env.LOCAL_DESKTOP_GATEWAY_KEY);
});

test('ensureGatewayEnvFile can rotate the local desktop port without changing the secret', (t) => {
  isolateEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-env-'));
  process.env.AGENT_UI_CONFIG_DIR = dir;
  process.env.AGENT_UI_HERMES_HOME = path.join(dir, 'hermes-home');

  const first = ensureGatewayEnvFile();
  const second = ensureGatewayEnvFile({ LOCAL_DESKTOP_PORT: '8777' });

  assert.equal(second.env.LOCAL_DESKTOP_GATEWAY_KEY, first.env.LOCAL_DESKTOP_GATEWAY_KEY);
  assert.equal(second.env.LOCAL_DESKTOP_PORT, '8777');
  assert.match(fs.readFileSync(second.file, 'utf8'), /LOCAL_DESKTOP_PORT=8777/);
});

test('ensureGatewayEnvFile preserves existing Hermes env values', (t) => {
  isolateEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-env-'));
  const home = path.join(dir, 'hermes-home');
  const envPath = path.join(home, '.env');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(envPath, [
    '# Existing Hermes provider config',
    'OPENROUTER_API_KEY=sk-existing',
    'LOCAL_DESKTOP_PORT=8766',
    'LOCAL_DESKTOP_PORT=9999',
    'NOUS_API_KEY=portal-existing',
    '',
  ].join('\n'));
  process.env.AGENT_UI_CONFIG_DIR = dir;
  process.env.AGENT_UI_HERMES_HOME = home;

  const result = ensureGatewayEnvFile({ LOCAL_DESKTOP_PORT: '8788' });
  const body = fs.readFileSync(result.file, 'utf8');

  assert.match(body, /OPENROUTER_API_KEY=sk-existing/);
  assert.match(body, /NOUS_API_KEY=portal-existing/);
  assert.match(body, /LOCAL_DESKTOP_PORT=8788/);
  assert.match(body, /LOCAL_DESKTOP_HOME_CHANNEL=agent-ui/);
  assert.match(body, /LOCAL_DESKTOP_HOME_CHANNEL_NAME=Agent UI/);
  assert.equal((body.match(/LOCAL_DESKTOP_PORT=/g) || []).length, 1);
  assert.equal(fs.statSync(result.file).mode & 0o777, 0o600);
});

test('ensureGatewayEnvFile preserves an explicit local desktop home channel', (t) => {
  isolateEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-env-'));
  const home = path.join(dir, 'hermes-home');
  const envPath = path.join(home, '.env');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(envPath, [
    'LOCAL_DESKTOP_GATEWAY_KEY=existing-secret',
    'LOCAL_DESKTOP_HOME_CHANNEL=custom-home',
    'LOCAL_DESKTOP_HOME_CHANNEL_NAME=Custom Home',
    '',
  ].join('\n'));
  process.env.AGENT_UI_CONFIG_DIR = dir;
  process.env.AGENT_UI_HERMES_HOME = home;

  const result = ensureGatewayEnvFile();
  const body = fs.readFileSync(result.file, 'utf8');

  assert.equal(result.env.LOCAL_DESKTOP_HOME_CHANNEL, 'custom-home');
  assert.equal(result.env.LOCAL_DESKTOP_HOME_CHANNEL_NAME, 'Custom Home');
  assert.match(body, /LOCAL_DESKTOP_HOME_CHANNEL=custom-home/);
  assert.match(body, /LOCAL_DESKTOP_HOME_CHANNEL_NAME=Custom Home/);
});

test('connector mode uses default local Hermes home and remembers detected binary', (t) => {
  isolateEnv(t);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-connector-config-'));
  const hermesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-connector-hermes-'));
  const bin = path.join(hermesRoot, 'script', 'aura-hermes');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.AGENT_UI_CONFIG_DIR = configDir;
  process.env.AGENT_UI_RELEASE_MODE = 'connector';
  process.env.AGENT_UI_HERMES_BIN = bin;

  const resolved = resolveHermesCommand();

  assert.equal(defaultHermesHome(), path.join(os.userInfo().homedir, 'Documents', 'hermes', 'hermes-home'));
  assert.equal(resolved.command, bin);
  assert.equal(resolved.releaseMode, 'connector');
  assert.equal(resolved.configured, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'connector-runtime.json'), 'utf8')).hermesBin, bin);
});

test('connector discovery prefers Hermes venv over AURA wrapper', () => {
  const candidates = defaultConnectorHermesCandidates();
  const venv = candidates.findIndex((candidate) => candidate.endsWith(path.join('hermes-agent', 'venv', 'bin', 'hermes')));
  const wrapper = candidates.findIndex((candidate) => candidate.endsWith(path.join('script', 'aura-hermes')));

  assert.notEqual(venv, -1);
  assert.notEqual(wrapper, -1);
  assert.equal(venv < wrapper, true);
  assert.equal(candidates.some((candidate) => candidate.endsWith(path.join('.local', 'bin', 'hermes'))), false);
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
  const blockedPort = 8766;
  mockCreateServer(t, (port) => port === blockedPort);
  t.after(() => {
    stopGatewayProcess();
  });

  process.env.AGENT_UI_CONFIG_DIR = configDir;
  process.env.AGENT_UI_HERMES_HOME = homeDir;
  process.env.AGENT_UI_HERMES_BIN = path.join(configDir, 'missing-hermes');
  ensureGatewayEnvFile({ LOCAL_DESKTOP_PORT: String(blockedPort) });

  const result = await ensureGatewayProcess({ warn() {}, log() {} });
  const env = fs.readFileSync(path.join(homeDir, '.env'), 'utf8');

  assert.equal(result.ok, false);
  assert.match(result.error, /Hermes executable is missing/);
  assert.doesNotMatch(env, new RegExp(`LOCAL_DESKTOP_PORT=${blockedPort}\\b`));
  assert.match(env, /LOCAL_DESKTOP_PORT=\d+/);
  assert.notEqual(process.env.LOCAL_DESKTOP_PORT, String(blockedPort));
  assert.equal(process.env.AGENT_UI_HERMES_GATEWAY_URL, `http://127.0.0.1:${process.env.LOCAL_DESKTOP_PORT}`);
});

test('ensureGatewayProcess reconciles direct gateway URL with the Hermes env file', async (t) => {
  isolateEnv(t);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-url-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-home-'));
  mockCreateServer(t, () => false);
  t.after(() => {
    stopGatewayProcess();
  });

  const directPort = 8788;
  process.env.AGENT_UI_CONFIG_DIR = configDir;
  process.env.AGENT_UI_HERMES_HOME = homeDir;
  process.env.AGENT_UI_HERMES_BIN = path.join(configDir, 'missing-hermes');
  process.env.AGENT_UI_HERMES_GATEWAY_URL = `http://127.0.0.1:${directPort}/`;
  ensureGatewayEnvFile({ LOCAL_DESKTOP_PORT: '8766' });

  const result = await ensureGatewayProcess({ warn() {}, log() {} });
  const env = fs.readFileSync(path.join(homeDir, '.env'), 'utf8');

  assert.equal(result.ok, false);
  assert.match(result.error, /Hermes executable is missing/);
  assert.match(env, new RegExp(`LOCAL_DESKTOP_PORT=${directPort}\\b`));
  assert.equal(process.env.LOCAL_DESKTOP_PORT, String(directPort));
  assert.equal(process.env.AGENT_UI_HERMES_GATEWAY_URL, `http://127.0.0.1:${directPort}`);
});

test('ensureGatewayProcess does not report an unready child as ready', async (t) => {
  isolateEnv(t);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-stale-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-runtime-home-'));
  const bin = path.join(configDir, 'hermes');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    "trap 'exit 0' TERM INT",
    'while true; do sleep 0.1 & wait $!; done',
    '',
  ].join('\n'), { mode: 0o755 });
  process.env.AGENT_UI_CONFIG_DIR = configDir;
  process.env.AGENT_UI_HERMES_HOME = homeDir;
  process.env.AGENT_UI_HERMES_BIN = bin;
  global.fetch = async () => new Response(JSON.stringify({ ok: false }), { status: 503 });
  mockCreateServer(t, () => false);
  t.after(() => {
    stopGatewayProcess();
    global.fetch = originalFetch;
  });

  const log = { warn() {}, log() {} };
  const first = await ensureGatewayProcess(log, {
    readyAttempts: 2,
    readyIntervalMs: 5,
    readyRequestTimeoutMs: 5,
  });
  const second = await ensureGatewayProcess(log, {
    readyAttempts: 2,
    readyIntervalMs: 5,
    readyRequestTimeoutMs: 5,
  });

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.notEqual(second.starting, true);
});

test('gateway autostart uses replace mode for quit/reopen recovery', () => {
  assert.deepEqual(gatewayArgsFor(), ['gateway', 'run', '--replace']);
});

test('connector mode does not install or copy local desktop plugins', async (t) => {
  isolateEnv(t);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-connector-config-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-connector-home-'));
  const bin = path.join(configDir, 'hermes');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.AGENT_UI_CONFIG_DIR = configDir;
  process.env.AGENT_UI_RELEASE_MODE = 'connector';
  process.env.AGENT_UI_HERMES_HOME = homeDir;
  process.env.AGENT_UI_HERMES_BIN = bin;

  const result = await ensureGatewayProcess({ warn() {}, log() {} });

  assert.equal(result.ok, false);
  assert.equal(result.pendingRestart, true);
  assert.equal(fs.existsSync(path.join(homeDir, 'plugins')), false);
});

test('connector mode requires explicit gateway restart approval when Hermes is not ready', async (t) => {
  isolateEnv(t);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-connector-config-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-connector-home-'));
  const bin = path.join(configDir, 'hermes');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.AGENT_UI_CONFIG_DIR = configDir;
  process.env.AGENT_UI_RELEASE_MODE = 'connector';
  process.env.AGENT_UI_HERMES_HOME = homeDir;
  process.env.AGENT_UI_HERMES_BIN = bin;

  const result = await ensureGatewayProcess({ warn() {}, log() {} });

  assert.equal(result.ok, false);
  assert.equal(result.pendingRestart, true);
  assert.match(result.reason, /Hermes gateway restart is required/);
  assert.match(result.reason, /gateway run --replace/);
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

test('resolveHermesCommand does not fall back to PATH or local checkout Hermes', (t) => {
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

test('direct Hermes Python probes disable bytecode writes', () => {
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hermes-runtime.js'), 'utf8');

  assert.match(runtime, /function pythonNoBytecodeEnv/);
  assert.match(runtime, /PYTHONDONTWRITEBYTECODE: '1'/);
  assert.match(runtime, /execFileText\(python[\s\S]*env: pythonNoBytecodeEnv/);
  assert.match(runtime, /execFileTextWithJsonEvents\(runtime\.python[\s\S]*env: pythonNoBytecodeEnv/);
});

test('local desktop adapter closes overflowed SSE subscribers', () => {
  const adapter = fs.readFileSync(
    path.join(__dirname, '..', 'vendor', 'hermes-platforms', 'local_desktop', 'adapter.py'),
    'utf8'
  );

  assert.match(adapter, /except asyncio\.QueueFull:/);
  assert.match(adapter, /self\._subscribers\.discard\(queue\)/);
  assert.match(adapter, /def _close_overflowed_subscriber/);
  assert.match(adapter, /queue\.get_nowait\(\)/);
  assert.match(adapter, /queue\.put_nowait\(None\)/);
});

test('local desktop adapter treats SSE client disconnects as normal', () => {
  const adapter = fs.readFileSync(
    path.join(__dirname, '..', 'vendor', 'hermes-platforms', 'local_desktop', 'adapter.py'),
    'utf8'
  );

  assert.match(adapter, /from aiohttp import client_exceptions, web/);
  assert.match(adapter, /def _is_sse_disconnect/);
  assert.match(adapter, /client_exceptions\.ClientConnectionResetError/);
  assert.match(adapter, /SSE client disconnected/);
  assert.doesNotMatch(adapter, /except \(asyncio\.CancelledError, ConnectionResetError, BrokenPipeError\):/);
});

test('local desktop adapter follows Hermes plugin adapter registration hooks', () => {
  const adapter = fs.readFileSync(
    path.join(__dirname, '..', 'vendor', 'hermes-platforms', 'local_desktop', 'adapter.py'),
    'utf8'
  );
  const manifest = fs.readFileSync(
    path.join(__dirname, '..', 'vendor', 'hermes-platforms', 'local_desktop', 'plugin.yaml'),
    'utf8'
  );

  assert.match(adapter, /class LocalDesktopAdapter\(BasePlatformAdapter\):/);
  assert.match(adapter, /async def connect\(self\) -> bool:/);
  assert.match(adapter, /async def disconnect\(self\) -> None:/);
  assert.match(adapter, /async def send\(/);
  assert.match(adapter, /await self\.handle_message\(event\)/);
  assert.match(adapter, /def _env_enablement\(\) -> Optional\[Dict\[str, Any\]\]:/);
  assert.match(adapter, /except \(TypeError, ValueError\):\n\s+return None/);
  assert.match(adapter, /env_enablement_fn=_env_enablement/);
  assert.match(adapter, /cron_deliver_env_var="LOCAL_DESKTOP_HOME_CHANNEL"/);
  assert.match(adapter, /_supported_platform_kwargs/);

  assert.match(manifest, /label: Local Desktop/);
  assert.match(manifest, /requires_env:\n  - name: LOCAL_DESKTOP_GATEWAY_KEY/);
  assert.match(manifest, /optional_env:/);
  assert.match(manifest, /name: LOCAL_DESKTOP_USER_ID/);
  assert.match(manifest, /name: LOCAL_DESKTOP_HOME_CHANNEL/);
  assert.match(manifest, /name: LOCAL_DESKTOP_HOME_CHANNEL_NAME/);
  assert.match(manifest, /password: true/);
});

test('Hermes bundler overlays the app-owned local desktop platform', () => {
  const bundler = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'bundle-hermes-runtime.js'), 'utf8');
  const pluginDir = path.join(__dirname, '..', 'vendor', 'hermes-platforms', 'local_desktop');
  const manifest = fs.readFileSync(path.join(pluginDir, 'plugin.yaml'), 'utf8');
  const adapter = fs.readFileSync(path.join(pluginDir, 'adapter.py'), 'utf8');

  assert.match(manifest, /^kind: platform$/m);
  assert.match(manifest, /name: LOCAL_DESKTOP_GATEWAY_KEY/);
  assert.match(adapter, /name="local_desktop"/);
  assert.match(adapter, /LOCAL_DESKTOP_GATEWAY_KEY/);
  assert.match(bundler, /vendor', 'hermes-platforms'/);
  assert.match(bundler, /plugins', 'platforms', overlay\.name/);
  assert.match(bundler, /replaced-source/);
  assert.match(bundler, /hermesPlatformOverlays/);
});

test('Hermes bundler installs and enables the computer use tool overlay', () => {
  const bundler = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'bundle-hermes-runtime.js'), 'utf8');
  const toolShim = fs.readFileSync(
    path.join(__dirname, '..', 'vendor', 'hermes-tool-overlays', 'computer_use', 'tools', 'computer_use_tool.py'),
    'utf8'
  );
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'vendor', 'hermes-tool-overlays', 'computer_use', 'tools', 'computer_use', 'schema.py'),
    'utf8'
  );
  const backend = fs.readFileSync(
    path.join(__dirname, '..', 'vendor', 'hermes-tool-overlays', 'computer_use', 'tools', 'computer_use', 'cua_backend.py'),
    'utf8'
  );

  assert.match(toolShim, /registry\.register\(\n\s+name="computer_use"/);
  assert.match(toolShim, /toolset="computer_use"/);
  assert.match(schema, /"set_value"/);
  assert.match(schema, /"page"/);
  assert.match(schema, /window-local screenshot/);
  assert.match(backend, /cua-driver mcp/);
  assert.match(backend, /self\._session\.call_tool\("get_window_state"/);
  assert.match(backend, /self\._action\("set_value"/);
  assert.match(backend, /self\._action\("page"/);
  assert.match(bundler, /vendor', 'hermes-tool-overlays'/);
  assert.match(bundler, /copyVendoredToolOverlays/);
  assert.match(bundler, /patchHermesComputerUseToolset/);
  assert.match(bundler, /\[voice,messaging,mcp\]/);
  assert.match(bundler, /enabled_toolsets\.add\("computer_use"\)/);
  assert.match(bundler, /hermesToolOverlays/);
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
    if (String(url).endsWith('/events')) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': ready\n\n'));
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ ok: false, error: 'missing_conversation_id' }), { status: 400 });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  assert.equal(await gatewayAuthOk('http://127.0.0.1:8766', 'secret'), true);
  assert.equal(await gatewayEventsOk('http://127.0.0.1:8766', 'secret'), true);
  assert.equal(await gatewayReadyOk('http://127.0.0.1:8766', 'secret'), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.auth === 'Bearer secret' && call.body === '{}'), true);
  assert.equal(calls.some((call) => call.url.endsWith('/events') && call.auth === 'Bearer secret'), true);
});

test('gateway readiness rejects immediately closed event stream', async (t) => {
  isolateEnv(t);
  global.fetch = async (url) => {
    if (String(url).endsWith('/events')) {
      return new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  assert.equal(await gatewayEventsOk('http://127.0.0.1:8766', 'secret', 50), false);
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
  assert.equal(await gatewayEventsOk('http://127.0.0.1:8766', 'secret'), false);
  assert.equal(await gatewayReadyOk('http://127.0.0.1:8766', 'secret'), false);
});
