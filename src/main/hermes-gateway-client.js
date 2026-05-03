'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getAgentUIConfigDir() {
  const configured = String(process.env.AGENT_UI_CONFIG_DIR || '').trim();
  const dir = configured ? path.resolve(configured) : path.join(os.homedir(), '.agent-ui');
  ensureDir(dir);
  return dir;
}

function defaultStatePath() {
  return path.join(getAgentUIConfigDir(), 'hermes-gateway.json');
}

function gatewayBaseUrlFromEnv() {
  const direct = String(process.env.AGENT_UI_HERMES_GATEWAY_URL || '').trim();
  if (direct) return direct.replace(/\/+$/, '');
  const host = String(process.env.LOCAL_DESKTOP_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const port = String(process.env.LOCAL_DESKTOP_PORT || '8766').trim() || '8766';
  return `http://${host}:${port}`;
}

function gatewayKeyFromEnv() {
  return String(process.env.AGENT_UI_HERMES_GATEWAY_KEY || process.env.LOCAL_DESKTOP_GATEWAY_KEY || '').trim();
}

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  const code = Number(status);
  return code === 429 || (code >= 500 && code <= 599);
}

function parseSseFrame(frame) {
  const event = { event: 'message', data: '', id: '' };
  for (const rawLine of String(frame || '').split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const idx = rawLine.indexOf(':');
    const field = idx >= 0 ? rawLine.slice(0, idx) : rawLine;
    let value = idx >= 0 ? rawLine.slice(idx + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event.event = value || 'message';
    if (field === 'id') event.id = value;
    if (field === 'data') event.data = event.data ? `${event.data}\n${value}` : value;
  }
  if (!event.data) return null;
  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch {
    payload = { data: event.data };
  }
  if (event.id && payload && typeof payload === 'object' && payload.seq == null) {
    const seq = Number(event.id);
    if (Number.isFinite(seq)) payload.seq = Math.trunc(seq);
  }
  if (payload && typeof payload === 'object' && !payload.type) payload.type = event.event;
  return payload;
}

class HermesGatewayClient {
  constructor(opts = {}) {
    this.baseUrl = String(opts.baseUrl || gatewayBaseUrlFromEnv()).replace(/\/+$/, '');
    this.key = String(opts.key || gatewayKeyFromEnv()).trim();
    this.statePath = opts.statePath || defaultStatePath();
    this.fetchImpl = opts.fetchImpl || global.fetch;
    this.log = opts.log || console;
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    this.onReplayExpired = typeof opts.onReplayExpired === 'function' ? opts.onReplayExpired : () => {};
    this.clientVersion = String(opts.clientVersion || 'unknown');
    this.state = {
      lastSeq: 0,
      conversations: {},
      ...readJsonFile(this.statePath, {}),
    };
    if (!this.state.conversations || typeof this.state.conversations !== 'object') {
      this.state.conversations = {};
    }
    this.abortController = null;
    this.streamPromise = null;
    this.running = false;
    this.reconnectTimer = null;
  }

  saveState() {
    writeJsonFile(this.statePath, this.state);
  }

  rememberConversation(catId, conversationId = catId) {
    const id = String(catId || '').trim();
    const cid = String(conversationId || id).trim();
    if (!id || !cid) return cid;
    this.state.conversations[id] = cid;
    this.saveState();
    return cid;
  }

  conversationIdFor(catId) {
    const id = String(catId || '').trim();
    return (id && this.state.conversations[id]) || id;
  }

  createMessageId(prefix = 'agent-ui') {
    return `${prefix}-${Date.now()}-${randomUUID()}`;
  }

  authHeaders(extra = {}) {
    if (!this.key) throw new Error('Missing LOCAL_DESKTOP_GATEWAY_KEY for Hermes gateway.');
    return {
      ...extra,
      authorization: `Bearer ${this.key}`,
    };
  }

  async health({ timeoutMs = 2500 } = {}) {
    if (!this.fetchImpl) throw new Error('fetch is not available.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: controller.signal });
      if (!res || !res.ok) throw new Error(`Gateway health failed: ${res ? res.status : 'no response'}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async postMessage({ conversationId, messageId, text, chatName, metadata = {}, retries = 1 }) {
    if (!this.fetchImpl) throw new Error('fetch is not available.');
    const payload = {
      conversation_id: String(conversationId || '').trim(),
      message_id: String(messageId || this.createMessageId('msg')).trim(),
      text: String(text || ''),
      chat_name: chatName ? String(chatName) : undefined,
      metadata: {
        client: 'agent-ui',
        client_version: this.clientVersion,
        ...metadata,
      },
    };
    const bodyText = JSON.stringify(payload);
    const attempts = Math.max(1, Math.trunc(Number(retries) || 0) + 1);
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/messages`, {
          method: 'POST',
          headers: this.authHeaders({ 'content-type': 'application/json' }),
          body: bodyText,
        });
        let body = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (res.ok) return body || { ok: true };
        const error = new Error((body && (body.message || body.error)) || `Gateway message failed: ${res.status}`);
        error.status = res.status;
        error.body = body;
        if (!isRetryableStatus(res.status) || attempt === attempts - 1) throw error;
        lastError = error;
      } catch (e) {
        if (e && e.status && !isRetryableStatus(e.status)) throw e;
        if (attempt === attempts - 1) throw e;
        lastError = e;
      }
      await sleep(Math.min(250, 50 * (attempt + 1)));
    }
    throw lastError || new Error('Gateway message failed.');
  }

  start() {
    if (!this.key) throw new Error('Missing LOCAL_DESKTOP_GATEWAY_KEY for Hermes gateway.');
    if (this.running) return;
    this.running = true;
    this.streamPromise = this.streamLoop();
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async streamLoop() {
    let delayMs = 500;
    while (this.running) {
      try {
        await this.openEventStream();
        delayMs = 500;
      } catch (e) {
        if (!this.running) return;
        if (e && e.status === 409 && e.code === 'replay_window_expired') {
          this.state.lastSeq = 0;
          this.saveState();
          this.onReplayExpired(e);
          delayMs = 100;
        } else {
          this.log.warn('[agent-ui] Hermes gateway SSE disconnected', e && e.message ? e.message : e);
        }
      }
      if (!this.running) return;
      await new Promise((resolve) => {
        this.reconnectTimer = setTimeout(resolve, delayMs);
      });
      this.reconnectTimer = null;
      delayMs = Math.min(5000, Math.round(delayMs * 1.6));
    }
  }

  async openEventStream() {
    if (!this.fetchImpl) throw new Error('fetch is not available.');
    const url = new URL(`${this.baseUrl}/events`);
    const lastSeq = Number(this.state.lastSeq || 0);
    if (Number.isFinite(lastSeq) && lastSeq > 0) url.searchParams.set('last_seq', String(Math.trunc(lastSeq)));
    this.abortController = new AbortController();
    const res = await this.fetchImpl(url.toString(), {
      headers: this.authHeaders(),
      signal: this.abortController.signal,
    });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      const error = new Error((body && body.message) || 'SSE replay window expired.');
      error.status = 409;
      error.code = body && body.error;
      throw error;
    }
    if (!res.ok) throw new Error(`Gateway event stream failed: ${res.status}`);
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('Gateway event stream is not readable.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (this.running) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseFrame(frame);
        if (event) this.handleEvent(event);
        idx = buffer.indexOf('\n\n');
      }
    }
  }

  handleEvent(event) {
    const seq = Number(event && event.seq);
    if (Number.isFinite(seq) && seq > Number(this.state.lastSeq || 0)) {
      this.state.lastSeq = Math.trunc(seq);
      this.saveState();
    }
    this.onEvent(event);
  }
}

module.exports = {
  HermesGatewayClient,
  defaultStatePath,
  gatewayBaseUrlFromEnv,
  gatewayKeyFromEnv,
  getAgentUIConfigDir,
  parseSseFrame,
};
