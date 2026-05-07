'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('stream');

const { startAgentUIEvalServer, _test } = require('../src/main/eval-server');

const originalEnv = { ...process.env };

function invokeEvalRoute(method, url, payload, handlers, headers = { authorization: 'Bearer test-token' }) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? '' : JSON.stringify(payload);
    const req = Readable.from(body ? [body] : []);
    req.method = method;
    req.url = url;
    req.headers = headers;

    const chunks = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    res.writeHead = (statusCode, headers) => {
      res.statusCode = statusCode;
      res.headers = headers;
      return res;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        json: text ? JSON.parse(text) : null,
      });
      return res;
    };

    _test.handleEvalRequest(req, res, handlers).catch(reject);
  });
}

test('eval server is disabled outside AGENT_UI_EVAL', () => {
  process.env = { ...originalEnv };
  delete process.env.AGENT_UI_EVAL;

  assert.equal(startAgentUIEvalServer({}), null);

  process.env = { ...originalEnv };
});

test('eval server requires an explicit token', () => {
  process.env = {
    ...originalEnv,
    AGENT_UI_EVAL: '1',
  };

  assert.equal(startAgentUIEvalServer({}, { warn() {} }), null);

  process.env = { ...originalEnv };
});

test('eval server exposes release smoke control endpoints', async (t) => {
  const calls = [];
  process.env = {
    ...originalEnv,
    AGENT_UI_EVAL: '1',
    AGENT_UI_EVAL_TOKEN: 'test-token',
  };
  t.after(() => {
    process.env = { ...originalEnv };
  });

  const handlers = {
    getConversation: async (catId) => ({ ok: true, catId }),
    listConversations: async () => ({ ok: true, conversations: [] }),
    getUiTargets: async () => ({ ok: true, modal: {} }),
    start: async (payload) => { calls.push(['start', payload]); return { ok: true, catId: payload.catId }; },
    followup: async (payload) => { calls.push(['followup', payload]); return { ok: true }; },
    cancel: async (payload) => { calls.push(['cancel', payload]); return { ok: true }; },
    openConversation: async (payload) => { calls.push(['openConversation', payload]); return { ok: true }; },
    setInputMode: async (payload) => { calls.push(['setInputMode', payload]); return { ok: true, inputMode: payload.mode }; },
    wait: async (payload) => { calls.push(['wait', payload]); return { ok: true }; },
    getTrace: async () => ({ ok: true, events: [] }),
    closeModal: async () => ({ ok: true }),
    dismiss: async (payload) => { calls.push(['dismiss', payload]); return { ok: true }; },
    shutdown: () => {},
  };

  assert.deepEqual((await invokeEvalRoute('GET', '/health', null, handlers, {})).json, { ok: false, error: 'unauthorized' });
  assert.deepEqual((await invokeEvalRoute('GET', '/health', null, handlers)).json, { ok: true, app: 'agent-UI', eval: true });
  assert.deepEqual((await invokeEvalRoute('POST', '/start', { catId: 'cat-1', prompt: 'hello' }, handlers)).json, { ok: true, catId: 'cat-1' });
  assert.deepEqual((await invokeEvalRoute('POST', '/followup', { catId: 'cat-1', text: 'next' }, handlers)).json, { ok: true });
  assert.deepEqual((await invokeEvalRoute('POST', '/cancel', { catId: 'cat-1' }, handlers)).json, { ok: true });
  assert.deepEqual((await invokeEvalRoute('POST', '/open-conversation', { catId: 'cat-1' }, handlers)).json, { ok: true });
  assert.deepEqual((await invokeEvalRoute('POST', '/set-input-mode', { mode: 'voice' }, handlers)).json, { ok: true, inputMode: 'voice' });
  assert.deepEqual((await invokeEvalRoute('POST', '/wait', { catId: 'cat-1' }, handlers)).json, { ok: true });
  assert.deepEqual((await invokeEvalRoute('POST', '/dismiss', { catId: 'cat-1' }, handlers)).json, { ok: true });

  assert.deepEqual(calls.map(([name]) => name), [
    'start',
    'followup',
    'cancel',
    'openConversation',
    'setInputMode',
    'wait',
    'dismiss',
  ]);
});
