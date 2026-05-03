'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agents = require('../src/main/agents');

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

function emptySseResponse() {
  return new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function setupGatewayEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-agents-'));
  process.env.AGENT_UI_CONFIG_DIR = dir;
  process.env.LOCAL_DESKTOP_GATEWAY_KEY = 'secret';
  process.env.AGENT_UI_HERMES_TRANSPORT = 'gateway';
  t.after(() => {
    agents.cancelAllAgents();
    agents._test.resetGatewayClientForTests();
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });
}

async function waitFor(condition, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition timed out');
}

test('gateway start posts tagged first prompt with stable conversation id', async (t) => {
  setupGatewayEnv(t);
  const posts = [];
  global.fetch = async (url, opts = {}) => {
    const textUrl = String(url);
    if (textUrl.endsWith('/events')) return emptySseResponse();
    if (textUrl.endsWith('/messages')) {
      posts.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true, accepted: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, latest_seq: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  agents.startAgentForCat({
    catId: 'cat-gateway-1',
    prompt: 'Summarize this page',
    runtime: 'local',
    pointerContext: { capturedAt: '2026-05-03T00:00:00.000Z', contextQuality: 'minimal' },
  }, { getMainWindow: () => null, log: { warn() {} } });

  await waitFor(() => posts.length === 1);
  assert.equal(posts[0].conversation_id, 'cat-gateway-1');
  assert.match(posts[0].text, /<user_message source="agent-ui">Summarize this page<\/user_message>/);
  assert.match(posts[0].text, /<aura_meta type="context_snapshot" version="1">/);

  const conversation = agents.getAgentConversation('cat-gateway-1');
  assert.equal(conversation.transport, 'gateway');
  assert.equal(conversation.gatewayConversationId, 'cat-gateway-1');
});

test('gateway follow-up is sent while session is running', async (t) => {
  setupGatewayEnv(t);
  const posts = [];
  global.fetch = async (url, opts = {}) => {
    const textUrl = String(url);
    if (textUrl.endsWith('/events')) return emptySseResponse();
    if (textUrl.endsWith('/messages')) {
      posts.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true, accepted: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, latest_seq: 0 }), { status: 200 });
  };

  agents.startAgentForCat({
    catId: 'cat-gateway-2',
    prompt: 'Initial',
    runtime: 'local',
    pointerContext: null,
  }, { getMainWindow: () => null, log: { warn() {} } });
  await waitFor(() => posts.length === 1);

  const before = agents.getAgentConversation('cat-gateway-2');
  assert.equal(before.runStatus, 'running');

  const result = await agents.sendFollowup('cat-gateway-2', 'plain follow up', {
    getMainWindow: () => null,
    log: { warn() {} },
  });

  assert.equal(result.ok, true);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].conversation_id, 'cat-gateway-2');
  assert.equal(posts[1].text, 'plain follow up');
});

test('multiple gateway pets use separate conversations', async (t) => {
  setupGatewayEnv(t);
  const posts = [];
  global.fetch = async (url, opts = {}) => {
    const textUrl = String(url);
    if (textUrl.endsWith('/events')) return emptySseResponse();
    if (textUrl.endsWith('/messages')) {
      posts.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true, accepted: true }), { status: 202 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  agents.startAgentForCat({ catId: 'pet-a', prompt: 'A', runtime: 'local', pointerContext: null }, { getMainWindow: () => null, log: { warn() {} } });
  agents.startAgentForCat({ catId: 'pet-b', prompt: 'B', runtime: 'local', pointerContext: null }, { getMainWindow: () => null, log: { warn() {} } });
  await waitFor(() => posts.length === 2);

  assert.deepEqual(new Set(posts.map((p) => p.conversation_id)), new Set(['pet-a', 'pet-b']));
});

test('gateway SSE events update local conversation state', async (t) => {
  setupGatewayEnv(t);
  global.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/events')) return emptySseResponse();
    if (String(url).endsWith('/messages')) return new Response(JSON.stringify({ ok: true }), { status: 202 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  agents.startAgentForCat({ catId: 'cat-events', prompt: 'Initial', runtime: 'local', pointerContext: null }, { getMainWindow: () => null, log: { warn() {} } });
  await waitFor(() => agents.getAgentConversation('cat-events').found);

  agents._test.handleGatewayEvent({
    seq: 1,
    type: 'message.created',
    conversation_id: 'cat-events',
    message_id: 'm1',
    text: 'First draft',
  });
  agents._test.handleGatewayEvent({
    seq: 2,
    type: 'message.updated',
    conversation_id: 'cat-events',
    message_id: 'm1',
    text: 'Final answer',
  });
  agents._test.handleGatewayEvent({
    seq: 3,
    type: 'typing.stopped',
    conversation_id: 'cat-events',
    outcome: 'success',
  });

  const conversation = agents.getAgentConversation('cat-events');
  assert.equal(conversation.runStatus, 'completed');
  assert.equal(conversation.items.at(-1).kind, 'assistant');
  assert.equal(conversation.items.at(-1).text, 'Final answer');
});

test('conversation window does not disable web security', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.equal(source.includes('webSecurity: false'), false);
});

test('electron build copies gateway client into main output', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron.vite.config.mjs'), 'utf8');
  assert.match(source, /hermes-gateway-client\.js/);
});
