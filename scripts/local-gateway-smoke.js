'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const appPath = path.resolve(process.argv[2] || path.join(repoRoot, 'dist', 'mac-arm64', 'agent-UI Standalone.app'));
const port = Number(process.env.LOCAL_DESKTOP_PORT || process.argv[3] || 8766);
const host = '127.0.0.1';
const hermes = path.join(appPath, 'Contents', 'Resources', 'hermes-runtime', 'bin', 'hermes');

function fail(message) {
  console.error(`[agent-ui] ${message}`);
  process.exit(1);
}

function request(method, url, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout: 1500 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
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

function portAvailable() {
  return new Promise((resolve) => {
    const server = net.createServer();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { server.close(); } catch {}
      resolve(ok);
    };
    server.once('error', () => finish(false));
    server.listen({ host, port, exclusive: true }, () => finish(true));
  });
}

async function waitForGateway(baseUrl, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await request('GET', `${baseUrl}/health`);
      if (res.status === 200) return res;
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`gateway did not answer /health at ${baseUrl}`);
}

(async () => {
  if (!fs.existsSync(hermes)) fail(`Bundled Hermes launcher missing: ${hermes}`);
  if (!await portAvailable()) fail(`Port ${host}:${port} is already in use; rerun with a free LOCAL_DESKTOP_PORT for this smoke.`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-gateway-smoke-'));
  const fakeBin = path.join(tmp, 'fakebin');
  const fakeHome = path.join(tmp, 'home');
  const hermesHome = path.join(tmp, 'hermes-home');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'hermes'), '#!/bin/sh\necho fake hermes >&2\nexit 86\n', { mode: 0o755 });
  fs.writeFileSync(path.join(hermesHome, 'config.yaml'), [
    'platforms:',
    '  local_desktop:',
    '    enabled: true',
    '',
  ].join('\n'));

  const env = {
    ...process.env,
    HOME: fakeHome,
    HERMES_HOME: hermesHome,
    PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PYTHONPATH: path.join(tmp, 'poisoned-pythonpath'),
    LOCAL_DESKTOP_GATEWAY_KEY: 'agent-ui-smoke-secret',
    LOCAL_DESKTOP_ALLOWED_USERS: 'local',
    LOCAL_DESKTOP_ALLOW_ALL_USERS: 'false',
    LOCAL_DESKTOP_HOST: host,
    LOCAL_DESKTOP_PORT: String(port),
  };

  const version = spawnSync(hermes, ['version'], { encoding: 'utf8', env });
  if (version.status !== 0) fail(`Hermes version failed:\n${version.stderr || version.stdout}`);
  if (!/Hermes Agent v0\.12\.0 \(2026\.4\.30\)/.test(version.stdout)) fail(`Unexpected Hermes version:\n${version.stdout}`);
  if (!version.stdout.includes(path.join(appPath, 'Contents', 'Resources', 'hermes-runtime', 'hermes-agent'))) {
    fail(`Hermes did not report bundled project path:\n${version.stdout}`);
  }

  const logFile = path.join(tmp, 'gateway.log');
  const log = fs.openSync(logFile, 'a');
  const child = spawn(hermes, ['gateway', 'run'], {
    cwd: path.dirname(path.dirname(hermes)),
    env,
    stdio: ['ignore', log, log],
  });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { child.kill('SIGTERM'); } catch {}
    try { fs.closeSync(log); } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    const baseUrl = `http://${host}:${port}`;
    await waitForGateway(baseUrl);
    const schemaProbe = await request('POST', `${baseUrl}/messages`, {
      headers: {
        authorization: 'Bearer agent-ui-smoke-secret',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    if (
      schemaProbe.status !== 400 ||
      !schemaProbe.json ||
      schemaProbe.json.error !== 'missing_conversation_id'
    ) {
      fail(`Gateway auth/schema probe failed: ${schemaProbe.status} ${schemaProbe.text}`);
    }
    console.log(`[agent-ui] bundled Hermes gateway smoke passed at ${baseUrl}`);
  } catch (error) {
    const logs = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    fail(`${error && error.message ? error.message : error}\n--- gateway log ---\n${logs.slice(-4000)}`);
  } finally {
    cleanup();
  }
})();
