'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  HermesGatewayClient,
  parseSseFrame,
} = require('../src/main/hermes-gateway-client');

function tempStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-gateway-')), 'state.json');
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

test('conversation id and last sequence persist across client instances', () => {
  const statePath = tempStatePath();
  const first = new HermesGatewayClient({ key: 'secret', statePath, fetchImpl: async () => {} });
  first.rememberConversation('cat-1', 'cat-1');
  first.handleEvent({ seq: 7, type: 'message.created', conversation_id: 'cat-1' });

  const second = new HermesGatewayClient({ key: 'secret', statePath, fetchImpl: async () => {} });
  assert.equal(second.conversationIdFor('cat-1'), 'cat-1');
  assert.equal(second.state.lastSeq, 7);
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
