'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  defaultGatewayEnvPath,
  getAgentUIConfigDir,
  HermesGatewayClient,
  gatewayBaseUrlFromEnv,
  gatewayKeyFromEnv,
  parseSseFrame,
  readGatewayEnvFile,
} = require('../src/main/hermes-gateway-client');

function tempStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-gateway-')), 'state.json');
}

async function waitFor(condition, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition timed out');
}

const originalEnv = { ...process.env };

function isolateEnv(t) {
  process.env = { ...originalEnv };
  delete process.env.AGENT_UI_HERMES_GATEWAY_KEY;
  delete process.env.LOCAL_DESKTOP_GATEWAY_KEY;
  delete process.env.AGENT_UI_HERMES_GATEWAY_URL;
  delete process.env.LOCAL_DESKTOP_HOST;
  delete process.env.LOCAL_DESKTOP_PORT;
  delete process.env.AGENT_UI_CONFIG_DIR;
  delete process.env.AGENT_UI_HERMES_HOME;
  delete process.env.AGENT_UI_HERMES_ENV_PATH;
  delete process.env.AGENT_UI_RELEASE_MODE;
  delete process.env.AGENT_UI_RELEASE_FLAVOR;
  t.after(() => {
    process.env = { ...originalEnv };
  });
}

test('parseSseFrame parses event id, type, and JSON data', () => {
  const event = parseSseFrame([
    'id: 42',
    'event: message.created',
    'data: {"conversation_id":"cat-1","text":"done"}',
  ].join('\n'));

  assert.equal(event.seq, 42);
  assert.equal(event.type, 'message.created');
  assert.equal(event.conversation_id, 'cat-1');
  assert.equal(event.text, 'done');
});

test('postMessage sends authenticated local_desktop payload', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    return new Response(JSON.stringify({ ok: true, accepted: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new HermesGatewayClient({
    baseUrl: 'http://127.0.0.1:8766',
    key: 'secret',
    statePath: tempStatePath(),
    fetchImpl,
    clientVersion: '1.2.3',
  });

  await client.postMessage({
    conversationId: 'cat-1',
    messageId: 'msg-1',
    text: 'hello',
    chatName: 'Test',
    metadata: { workflow: 'pet' },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8766/messages');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer secret');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.conversation_id, 'cat-1');
  assert.equal(body.message_id, 'msg-1');
  assert.equal(body.text, 'hello');
  assert.equal(body.metadata.client, 'agent-ui');
  assert.equal(body.metadata.client_version, '1.2.3');
  assert.equal(body.metadata.workflow, 'pet');
});

test('postMessage retries retryable failures with the same idempotency payload', async () => {
  const calls = [];
  const fetchImpl = async (_url, opts = {}) => {
    calls.push(JSON.parse(opts.body));
    if (calls.length === 1) {
      return new Response(JSON.stringify({ ok: false, error: 'temporary' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, accepted: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new HermesGatewayClient({
    baseUrl: 'http://127.0.0.1:8766',
    key: 'secret',
    statePath: tempStatePath(),
    fetchImpl,
  });

  await client.postMessage({
    conversationId: 'cat-1',
    messageId: 'msg-1',
    text: 'hello',
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[1].message_id, 'msg-1');
});

test('postMessage reports gateway transport failures with the target URL', async () => {
  const error = new TypeError('fetch failed');
  error.cause = new Error('connect ECONNREFUSED 127.0.0.1:8766');
  const client = new HermesGatewayClient({
    baseUrl: 'http://127.0.0.1:8766',
    key: 'secret',
    statePath: tempStatePath(),
    fetchImpl: async () => { throw error; },
  });

  await assert.rejects(
    client.postMessage({
      conversationId: 'cat-1',
      messageId: 'msg-1',
      text: 'hello',
      retries: 0,
    }),
    /fetch failed \(connect ECONNREFUSED 127\.0\.0\.1:8766\)\. Check that Hermes gateway is running at http:\/\/127\.0\.0\.1:8766\./
  );
});

test('postMessage times out stalled gateway writes', async () => {
  const client = new HermesGatewayClient({
    baseUrl: 'http://127.0.0.1:8766',
    key: 'secret',
    statePath: tempStatePath(),
    fetchImpl: async () => new Promise(() => {}),
    postTimeoutMs: 20,
  });

  await assert.rejects(
    client.postMessage({
      conversationId: 'cat-timeout',
      messageId: 'msg-timeout',
      text: 'hello',
      retries: 0,
    }),
    /Check that Hermes gateway is running at http:\/\/127\.0\.0\.1:8766\./
  );
});

test('gateway config falls back to local desktop env file', (t) => {
  isolateEnv(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-gateway-env-'));
  process.env.AGENT_UI_HERMES_HOME = home;
  fs.writeFileSync(path.join(home, '.env'), [
    'export LOCAL_DESKTOP_GATEWAY_KEY="file-secret"',
    'LOCAL_DESKTOP_HOST=127.0.0.2',
    'LOCAL_DESKTOP_PORT=9911',
    '',
  ].join('\n'), 'utf8');

  assert.equal(gatewayKeyFromEnv(), 'file-secret');
  assert.equal(gatewayBaseUrlFromEnv(), 'http://127.0.0.2:9911');
  assert.equal(readGatewayEnvFile().LOCAL_DESKTOP_GATEWAY_KEY, 'file-secret');
});

test('default gateway config ignores Hermes-owned HOME override', (t) => {
  isolateEnv(t);
  const poisonedHome = path.join(os.userInfo().homedir, 'Documents', 'hermes', '.aura', 'home');
  process.env.HOME = poisonedHome;
  const expectedDir = path.join(os.userInfo().homedir, '.agent-ui');

  assert.equal(getAgentUIConfigDir(), expectedDir);
  assert.equal(defaultGatewayEnvPath(), path.join(expectedDir, 'hermes-home', '.env'));
});

test('explicit gateway env overrides local desktop env file', (t) => {
  isolateEnv(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-gateway-env-'));
  process.env.AGENT_UI_HERMES_HOME = home;
  process.env.AGENT_UI_HERMES_GATEWAY_KEY = 'direct-secret';
  process.env.AGENT_UI_HERMES_GATEWAY_URL = 'http://127.0.0.9:7777/';
  fs.writeFileSync(path.join(home, '.env'), [
    'LOCAL_DESKTOP_GATEWAY_KEY=file-secret',
    'LOCAL_DESKTOP_HOST=127.0.0.2',
    'LOCAL_DESKTOP_PORT=9911',
    '',
  ].join('\n'), 'utf8');

  assert.equal(gatewayKeyFromEnv(), 'direct-secret');
  assert.equal(gatewayBaseUrlFromEnv(), 'http://127.0.0.9:7777');
});

test('SSE disconnect logging is actionable and throttled', () => {
  const warnings = [];
  const client = new HermesGatewayClient({
    baseUrl: 'http://127.0.0.1:8766',
    key: 'secret',
    statePath: tempStatePath(),
    fetchImpl: async () => {},
    log: { warn: (...args) => warnings.push(args.join(' ')) },
    sseDisconnectLogThrottleMs: 30000,
  });
  const error = new TypeError('fetch failed');
  error.cause = new Error('connect ECONNREFUSED 127.0.0.1:8766');

  client.logSseDisconnect(error);
  client.logSseDisconnect(error);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fetch failed/);
  assert.match(warnings[0], /127\.0\.0\.1:8766/);
  assert.match(warnings[0], /Hermes gateway is running/);
});

test('last sequence persists across client instances without conversation content', () => {
  const statePath = tempStatePath();
  const first = new HermesGatewayClient({ key: 'secret', statePath, fetchImpl: async () => {} });
  first.handleEvent({ seq: 7, type: 'message.created', conversation_id: 'cat-1' });
  first.flushState();
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), { lastSeq: 7 });

  const second = new HermesGatewayClient({ key: 'secret', statePath, fetchImpl: async () => {} });
  assert.equal(second.state.lastSeq, 7);
  assert.equal(Object.prototype.hasOwnProperty.call(second.state, 'conversations'), false);
});

test('duplicate and stale SSE sequences are ignored', () => {
  const statePath = tempStatePath();
  const seen = [];
  const client = new HermesGatewayClient({
    key: 'secret',
    statePath,
    fetchImpl: async () => {},
    onEvent: (event) => seen.push(event),
  });

  client.handleEvent({ seq: 7, type: 'attachment.created', conversation_id: 'cat-1' });
  client.handleEvent({ seq: 7, type: 'attachment.created', conversation_id: 'cat-1' });
  client.handleEvent({ seq: 6, type: 'message.created', conversation_id: 'cat-1' });
  client.handleEvent({ type: 'typing.started', conversation_id: 'cat-1' });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].seq, 7);
  assert.equal(seen[1].type, 'typing.started');
});

test('last sequence can be reset when local conversations are not hydrated', () => {
  const statePath = tempStatePath();
  fs.writeFileSync(statePath, JSON.stringify({ lastSeq: 31 }), 'utf8');

  const client = new HermesGatewayClient({
    key: 'secret',
    statePath,
    fetchImpl: async () => {},
    resetLastSeq: true,
  });

  assert.equal(client.state.lastSeq, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), { lastSeq: 0 });
});

test('stale gateway state conversation maps are scrubbed on load', () => {
  const statePath = tempStatePath();
  fs.writeFileSync(statePath, JSON.stringify({
    lastSeq: 9,
    conversations: { 'cat-1': 'cat-1' },
    other: true,
  }), 'utf8');

  const client = new HermesGatewayClient({ key: 'secret', statePath, fetchImpl: async () => {} });

  assert.deepEqual(client.state, { lastSeq: 9 });
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), { lastSeq: 9 });
});

test('last sequence persistence is debounced and flushes on stop', () => {
  const statePath = tempStatePath();
  const client = new HermesGatewayClient({
    key: 'secret',
    statePath,
    fetchImpl: async () => {},
    stateSaveDebounceMs: 10000,
  });

  client.handleEvent({ seq: 1, type: 'message.created', conversation_id: 'cat-1' });
  client.handleEvent({ seq: 2, type: 'message.updated', conversation_id: 'cat-1' });

  assert.equal(fs.existsSync(statePath), false);
  client.stop();

  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(persisted.lastSeq, 2);
});

test('replay-window 409 clears last sequence and reports expiration', async () => {
  const statePath = tempStatePath();
  let expired = false;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: 'replay_window_expired' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const client = new HermesGatewayClient({
    baseUrl: 'http://127.0.0.1:8766',
    key: 'secret',
    statePath,
    fetchImpl,
    onReplayExpired: () => { expired = true; },
    log: { warn() {} },
  });
  client.state.lastSeq = 12;
  client.saveState();

  client.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  client.stop();

  assert.equal(expired, true);
  assert.equal(client.state.lastSeq, 0);
});

test('clean event stream EOF reports disconnected', async () => {
  const states = [];
  const fetchImpl = async () => new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  const client = new HermesGatewayClient({
    baseUrl: 'http://127.0.0.1:8766',
    key: 'secret',
    statePath: tempStatePath(),
    fetchImpl,
    onConnectionChange: (state) => states.push(state.state),
    log: { warn() {} },
  });

  client.start();
  try {
    await waitFor(() => states.includes('disconnected'));
  } finally {
    client.stop();
  }

  assert.deepEqual(states.slice(0, 2), ['connected', 'disconnected']);
});
