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

function sseResponse(frames) {
  const body = frames.join('\n\n') + '\n\n';
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function setupGatewayEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-agents-'));
  process.env.AGENT_UI_CONFIG_DIR = dir;
  process.env.AGENT_UI_HERMES_HOME = path.join(dir, 'hermes-home');
  process.env.LOCAL_DESKTOP_GATEWAY_KEY = 'secret';
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
      const body = JSON.parse(opts.body);
      if (!body.conversation_id) {
        return new Response(JSON.stringify({ ok: false, error: 'missing_conversation_id' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      posts.push(body);
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
      const body = JSON.parse(opts.body);
      if (!body.conversation_id) {
        return new Response(JSON.stringify({ ok: false, error: 'missing_conversation_id' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      posts.push(body);
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

test('first gateway client resets replay cursor when no conversations were hydrated', async (t) => {
  setupGatewayEnv(t);
  const statePath = path.join(process.env.AGENT_UI_CONFIG_DIR, 'hermes-gateway.json');
  fs.writeFileSync(statePath, JSON.stringify({ lastSeq: 55 }), 'utf8');
  const eventUrls = [];
  const posts = [];
  global.fetch = async (url, opts = {}) => {
    const textUrl = String(url);
    if (textUrl.includes('/events')) {
      eventUrls.push(textUrl);
      return emptySseResponse();
    }
    if (textUrl.endsWith('/messages')) {
      const body = JSON.parse(opts.body);
      if (!body.conversation_id) {
        return new Response(JSON.stringify({ ok: false, error: 'missing_conversation_id' }), { status: 400 });
      }
      posts.push(body);
      return new Response(JSON.stringify({ ok: true, accepted: true }), { status: 202 });
    }
    return new Response(JSON.stringify({ ok: true, latest_seq: 55 }), { status: 200 });
  };

  agents.startAgentForCat({
    catId: 'cat-replay-reset',
    prompt: 'New prompt',
    runtime: 'local',
    pointerContext: null,
  }, { getMainWindow: () => null, log: { warn() {} } });

  await waitFor(() => posts.length === 1 && eventUrls.length > 0);
  assert.equal(eventUrls.some((url) => url.includes('last_seq=')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), { lastSeq: 0 });
});

test('gateway hydration replays retained conversations after restart', async (t) => {
  setupGatewayEnv(t);
  const statePath = path.join(process.env.AGENT_UI_CONFIG_DIR, 'hermes-gateway.json');
  fs.writeFileSync(statePath, JSON.stringify({ lastSeq: 88 }), 'utf8');
  const eventUrls = [];
  const pushed = [];
  agents.setOnConversationPushed(({ catId }) => pushed.push(String(catId)));
  global.fetch = async (url, opts = {}) => {
    const textUrl = String(url);
    if (textUrl.includes('/events')) {
      eventUrls.push(textUrl);
      return sseResponse([
        'id: 89\nevent: message.created\ndata: {"conversation_id":"cat-rehydrated","message_id":"m1","text":"Restored answer"}',
        'id: 90\nevent: typing.stopped\ndata: {"conversation_id":"cat-rehydrated","outcome":"success"}',
      ]);
    }
    if (textUrl.endsWith('/messages')) {
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (!body.conversation_id) {
        return new Response(JSON.stringify({ ok: false, error: 'missing_conversation_id' }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, accepted: true }), { status: 202 });
    }
    return new Response(JSON.stringify({ ok: true, latest_seq: 90 }), { status: 200 });
  };

  const result = await agents.hydrateGatewayConversations({
    getMainWindow: () => null,
    log: { warn() {} },
  });

  assert.equal(result.ok, true);
  assert.equal(result.resetLastSeq, true);
  await waitFor(() => agents.getAgentConversation('cat-rehydrated').found);
  const conversation = agents.getAgentConversation('cat-rehydrated');
  assert.equal(eventUrls.some((url) => url.includes('last_seq=')), false);
  assert.equal(conversation.runStatus, 'completed');
  assert.equal(conversation.items[0].text, 'Restored answer');
  assert.equal(pushed.includes('cat-rehydrated'), true);
});

test('gateway cancel sends Hermes stop command while session is running', async (t) => {
  setupGatewayEnv(t);
  const posts = [];
  global.fetch = async (url, opts = {}) => {
    const textUrl = String(url);
    if (textUrl.endsWith('/events')) return emptySseResponse();
    if (textUrl.endsWith('/messages')) {
      const body = JSON.parse(opts.body);
      if (!body.conversation_id) {
        return new Response(JSON.stringify({ ok: false, error: 'missing_conversation_id' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      posts.push(body);
      return new Response(JSON.stringify({ ok: true, accepted: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, latest_seq: 0 }), { status: 200 });
  };

  agents.startAgentForCat({
    catId: 'cat-cancel',
    prompt: 'Initial',
    runtime: 'local',
    pointerContext: null,
  }, { getMainWindow: () => null, log: { warn() {} } });
  await waitFor(() => posts.length === 1);

  const result = await agents.cancelAgent('cat-cancel', {
    getMainWindow: () => null,
    log: { warn() {} },
  });

  assert.equal(result.ok, true);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].conversation_id, 'cat-cancel');
  assert.equal(posts[1].text, '/stop');
  assert.equal(posts[1].metadata.include_context, false);

  const conversation = agents.getAgentConversation('cat-cancel');
  assert.equal(conversation.items.some((item) => item.kind === 'user' && item.text === 'Cancel requested.'), true);
});

test('gateway first-message slash commands pass through without context wrapper', async (t) => {
  setupGatewayEnv(t);
  const posts = [];
  global.fetch = async (url, opts = {}) => {
    const textUrl = String(url);
    if (textUrl.endsWith('/events')) return emptySseResponse();
    if (textUrl.endsWith('/messages')) {
      const body = JSON.parse(opts.body);
      if (!body.conversation_id) {
        return new Response(JSON.stringify({ ok: false, error: 'missing_conversation_id' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      posts.push(body);
      return new Response(JSON.stringify({ ok: true, accepted: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, latest_seq: 0 }), { status: 200 });
  };

  agents.startAgentForCat({
    catId: 'cat-command',
    prompt: '/background Check all services',
    runtime: 'local',
    pointerContext: { capturedAt: '2026-05-03T00:00:00.000Z', contextQuality: 'minimal' },
  }, { getMainWindow: () => null, log: { warn() {} } });

  await waitFor(() => posts.length === 1);
  assert.equal(posts[0].conversation_id, 'cat-command');
  assert.equal(posts[0].text, '/background Check all services');
  assert.equal(posts[0].metadata.include_context, false);
});

test('multiple gateway pets use separate conversations', async (t) => {
  setupGatewayEnv(t);
  const posts = [];
  global.fetch = async (url, opts = {}) => {
    const textUrl = String(url);
    if (textUrl.endsWith('/events')) return emptySseResponse();
    if (textUrl.endsWith('/messages')) {
      const body = JSON.parse(opts.body);
      if (!body.conversation_id) {
        return new Response(JSON.stringify({ ok: false, error: 'missing_conversation_id' }), { status: 400 });
      }
      posts.push(body);
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
    if (String(url).endsWith('/messages')) {
      const body = JSON.parse(opts.body);
      if (!body.conversation_id) {
        return new Response(JSON.stringify({ ok: false, error: 'missing_conversation_id' }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }
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

test('gateway attachment events hydrate as structured safe descriptors', (t) => {
  setupGatewayEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-attachment-'));
  const imagePath = path.join(dir, 'result.png');
  fs.writeFileSync(imagePath, 'png-ish', 'utf8');

  agents._test.handleGatewayEvent({
    seq: 11,
    type: 'attachment.created',
    conversation_id: 'cat-attachment',
    message_id: 'att-1',
    attachment_type: 'image',
    ref: imagePath,
    caption: 'Generated chart',
    reply_to: 'm1',
    metadata: { tool: 'image' },
    created_at: 1760000000,
  });

  const conversation = agents.getAgentConversation('cat-attachment');
  assert.equal(conversation.found, true);
  assert.equal(conversation.transport, 'gateway');
  assert.equal(conversation.items.length, 1);
  assert.equal(conversation.items[0].kind, 'attachment');
  assert.equal(conversation.items[0].attachmentType, 'image');
  assert.equal(conversation.items[0].caption, 'Generated chart');
  assert.equal(conversation.items[0].ref, imagePath);
  assert.equal(conversation.items[0].replyTo, 'm1');
  assert.equal(conversation.items[0].metadata.tool, 'image');
  assert.equal(conversation.items[0].messageId, 'att-1');
  assert.equal(conversation.items[0].seq, 11);
  assert.equal(conversation.items[0].attachment.status, 'ready');
  assert.equal(conversation.items[0].attachment.source, 'local');
  assert.match(conversation.items[0].attachment.url, /^agent-ui-attachment:\/\/file\//);

  agents._test.handleGatewayEvent({
    seq: 12,
    type: 'message.deleted',
    conversation_id: 'cat-attachment',
    message_id: 'att-1',
  });

  assert.equal(agents.getAgentConversation('cat-attachment').items.length, 0);
});

test('gateway replayed message events hydrate unknown conversations in memory', (t) => {
  setupGatewayEnv(t);
  agents._test.handleGatewayEvent({
    seq: 20,
    type: 'message.created',
    conversation_id: 'cat-replay',
    message_id: 'm-replay',
    text: 'Replayed answer',
    metadata: { replay: true },
  });

  const conversation = agents.getAgentConversation('cat-replay');
  assert.equal(conversation.found, true);
  assert.equal(conversation.items[0].kind, 'assistant');
  assert.equal(conversation.items[0].text, 'Replayed answer');
  assert.equal(conversation.items[0].messageId, 'm-replay');
  assert.equal(conversation.items[0].metadata.replay, true);
});

test('gateway typing events expose typing state without forcing terminal status', (t) => {
  setupGatewayEnv(t);
  agents._test.handleGatewayEvent({
    seq: 30,
    type: 'typing.started',
    conversation_id: 'cat-typing',
    message_id: 'inbound-1',
    metadata: { phase: 'thinking' },
  });

  let conversation = agents.getAgentConversation('cat-typing');
  assert.equal(conversation.found, true);
  assert.equal(conversation.runStatus, 'running');
  assert.equal(conversation.typing.active, true);
  assert.equal(conversation.typing.messageId, 'inbound-1');
  assert.equal(conversation.typing.metadata.phase, 'thinking');

  agents._test.handleGatewayEvent({
    seq: 31,
    type: 'typing.stopped',
    conversation_id: 'cat-typing',
    transient: true,
  });

  conversation = agents.getAgentConversation('cat-typing');
  assert.equal(conversation.runStatus, 'running');
  assert.equal(conversation.typing.active, false);
});

test('conversation window does not disable web security', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.equal(source.includes('webSecurity: false'), false);
});

test('electron build copies gateway client into main output', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron.vite.config.mjs'), 'utf8');
  assert.match(source, /hermes-gateway-client\.js/);
  assert.match(source, /hermes-release\.js/);
  assert.match(source, /hermes-attachments\.js/);
  assert.match(source, /hermes-auth\.js/);
  assert.match(source, /window-lifecycle\.js/);
});
