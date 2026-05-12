'use strict';

import type {
  JsonObject,
  LocalDesktopErrorResponse,
  LocalDesktopGatewayEvent,
  LocalDesktopHealthResponse,
  LocalDesktopInboundMessage,
  LocalDesktopMessageAcceptedResponse,
} from '../shared/contracts.ts';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { setTimeout: delay } = require('timers/promises');
const {
  defaultGatewayEnvPathForMode,
  getAgentUIConfigDir,
  realUserHomeDir,
} = require('./hermes-release');

const DEFAULT_POST_TIMEOUT_MS = 15000;

type GatewayFetch = typeof fetch;
type GatewayLog = Pick<Console, 'warn'>;
type GatewayClientOptions = {
  baseUrl?: string;
  key?: string;
  statePath?: string;
  fetchImpl?: GatewayFetch;
  log?: GatewayLog;
  onEvent?: (event: JsonObject) => void;
  onConnectionChange?: (state: JsonObject) => void;
  onReplayExpired?: (error: Error) => void;
  clientVersion?: string;
  postTimeoutMs?: number;
  stateSaveDebounceMs?: number;
  sseDisconnectLogThrottleMs?: number;
  resetLastSeq?: boolean;
};
type GatewayState = {
  lastSeq: number;
};
type PostMessageInput = {
  conversationId?: unknown;
  messageId?: unknown;
  text?: unknown;
  chatName?: unknown;
  metadata?: JsonObject;
  retries?: number;
  timeoutMs?: number;
};
type HealthOptions = {
  timeoutMs?: number;
};
type GatewayError = Error & {
  cause?: unknown;
  code?: string;
  status?: number;
  body?: unknown;
};

function defaultStatePath() {
  return path.join(getAgentUIConfigDir(), 'hermes-gateway.json');
}

function defaultGatewayEnvPath() {
  return defaultGatewayEnvPathForMode();
}

function unquoteEnvValue(value: any) {
  const text = String(value || '').trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseGatewayEnvText(text = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    out[match[1]] = unquoteEnvValue(match[2]);
  }
  return out;
}

function readGatewayEnvFile(file = defaultGatewayEnvPath()): Record<string, string> {
  try {
    if (!fs.existsSync(file)) return {};
    return parseGatewayEnvText(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function gatewayEnvValue(name: any) {
  const direct = String(process.env[name] || '').trim();
  if (direct) return direct;
  return String(readGatewayEnvFile()[name] || '').trim();
}

function gatewayBaseUrlFromEnv() {
  const direct = gatewayEnvValue('AGENT_UI_HERMES_GATEWAY_URL');
  if (direct) return direct.replace(/\/+$/, '');
  const host = gatewayEnvValue('LOCAL_DESKTOP_HOST') || '127.0.0.1';
  const port = gatewayEnvValue('LOCAL_DESKTOP_PORT') || '8766';
  return `http://${host}:${port}`;
}

function gatewayKeyFromEnv() {
  return gatewayEnvValue('AGENT_UI_HERMES_GATEWAY_KEY') || gatewayEnvValue('LOCAL_DESKTOP_GATEWAY_KEY');
}

function readJsonFile(file: any, fallback: any) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: any, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function isRetryableStatus(status: any) {
  const code = Number(status);
  return code === 429 || (code >= 500 && code <= 599);
}

function gatewayConnectionErrorMessage(error: any, baseUrl: any) {
  const raw = error && error.message ? error.message : String(error || 'disconnected');
  const cause = error && error.cause && error.cause.message ? ` (${error.cause.message})` : '';
  return `${raw}${cause}. Check that Hermes gateway is running at ${baseUrl}.`;
}

function gatewayConnectionError(error: any, baseUrl: any) {
  const wrapped: GatewayError = new Error(gatewayConnectionErrorMessage(error, baseUrl));
  wrapped.cause = error;
  return wrapped;
}

function parseSseFrame(frame: any): LocalDesktopGatewayEvent | JsonObject | null {
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
  let payload: JsonObject;
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
  baseUrl: string;
  key: string;
  statePath: string;
  fetchImpl?: GatewayFetch;
  log: GatewayLog;
  onEvent: (event: JsonObject) => void;
  onConnectionChange: (state: JsonObject) => void;
  onReplayExpired: (error: Error) => void;
  clientVersion: string;
  postTimeoutMs: number;
  stateSaveDebounceMs: number;
  sseDisconnectLogThrottleMs: number;
  state: GatewayState;
  abortController: AbortController | null;
  streamPromise: Promise<void> | null;
  running: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  stateSaveTimer: ReturnType<typeof setTimeout> | null;
  stateDirty: boolean;
  lastSseDisconnectLogAt: number;
  lastSseDisconnectLogKey: string;

  constructor(opts: GatewayClientOptions = {}) {
    this.baseUrl = String(opts.baseUrl || gatewayBaseUrlFromEnv()).replace(/\/+$/, '');
    this.key = String(opts.key || gatewayKeyFromEnv()).trim();
    this.statePath = opts.statePath || defaultStatePath();
    this.fetchImpl = opts.fetchImpl || global.fetch;
    this.log = opts.log || console;
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    this.onConnectionChange = typeof opts.onConnectionChange === 'function' ? opts.onConnectionChange : () => {};
    this.onReplayExpired = typeof opts.onReplayExpired === 'function' ? opts.onReplayExpired : () => {};
    this.clientVersion = String(opts.clientVersion || 'unknown');
    this.postTimeoutMs = Math.max(0, Math.trunc(Number(opts.postTimeoutMs) || DEFAULT_POST_TIMEOUT_MS));
    this.stateSaveDebounceMs = Math.max(0, Math.trunc(Number(opts.stateSaveDebounceMs) || 250));
    this.sseDisconnectLogThrottleMs = Math.max(0, Math.trunc(Number(opts.sseDisconnectLogThrottleMs) || 30000));
    const savedState = readJsonFile(this.statePath, {});
    const savedLastSeq = Number(savedState && savedState.lastSeq);
    const resetLastSeq = !!opts.resetLastSeq;
    const hasStaleStateKeys = !!(savedState && typeof savedState === 'object' &&
      Object.keys(savedState).some((key) => key !== 'lastSeq'));
    this.state = {
      lastSeq: !resetLastSeq && Number.isFinite(savedLastSeq) && savedLastSeq > 0 ? Math.trunc(savedLastSeq) : 0,
    };
    this.abortController = null;
    this.streamPromise = null;
    this.running = false;
    this.reconnectTimer = null;
    this.stateSaveTimer = null;
    this.stateDirty = false;
    this.lastSseDisconnectLogAt = 0;
    this.lastSseDisconnectLogKey = '';
    if (hasStaleStateKeys || (resetLastSeq && Number.isFinite(savedLastSeq) && savedLastSeq > 0)) this.saveState();
  }

  saveState() {
    if (this.stateSaveTimer) {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = null;
    }
    this.stateDirty = false;
    writeJsonFile(this.statePath, this.state);
  }

  scheduleStateSave() {
    this.stateDirty = true;
    if (this.stateSaveDebounceMs === 0) {
      this.saveState();
      return;
    }
    if (this.stateSaveTimer) return;
    this.stateSaveTimer = setTimeout(() => {
      this.stateSaveTimer = null;
      if (this.stateDirty) this.saveState();
    }, this.stateSaveDebounceMs);
  }

  flushState() {
    if (this.stateDirty || this.stateSaveTimer) this.saveState();
  }

  logSseDisconnect(error: any) {
    const message = gatewayConnectionErrorMessage(error, this.baseUrl);
    const now = Date.now();
    if (
      this.sseDisconnectLogThrottleMs > 0 &&
      this.lastSseDisconnectLogKey === message &&
      now - this.lastSseDisconnectLogAt < this.sseDisconnectLogThrottleMs
    ) {
      return;
    }
    this.lastSseDisconnectLogKey = message;
    this.lastSseDisconnectLogAt = now;
    this.log.warn('[agent-ui] Hermes gateway SSE disconnected:', message);
  }

  reportConnection(state: string, error: any = null) {
    try {
      this.onConnectionChange({
        state,
        baseUrl: this.baseUrl,
        error: error && error.message ? error.message : (error ? String(error) : ''),
      });
    } catch {
      // Status callbacks must never break the reconnect loop.
    }
  }

  createMessageId(prefix = 'agent-ui') {
    return `${prefix}-${Date.now()}-${randomUUID()}`;
  }

  authHeaders(extra: Record<string, string> = {}) {
    if (!this.key) throw new Error('Missing LOCAL_DESKTOP_GATEWAY_KEY for Hermes gateway. Set LOCAL_DESKTOP_GATEWAY_KEY, AGENT_UI_HERMES_GATEWAY_KEY, or create the active Hermes .env file.');
    return {
      ...extra,
      authorization: `Bearer ${this.key}`,
    };
  }

  async health({ timeoutMs = 2500 }: HealthOptions = {}): Promise<LocalDesktopHealthResponse> {
    if (!this.fetchImpl) throw new Error('fetch is not available.');
    const res = await this.fetchImpl(`${this.baseUrl}/health`, {
      signal: Number(timeoutMs) > 0 ? AbortSignal.timeout(Number(timeoutMs)) : undefined,
    });
    if (!res || !res.ok) throw new Error(`Gateway health failed: ${res ? res.status : 'no response'}`);
    return await res.json() as LocalDesktopHealthResponse;
  }

  async postMessage({ conversationId, messageId, text, chatName, metadata = {}, retries = 1, timeoutMs = this.postTimeoutMs }: PostMessageInput): Promise<LocalDesktopMessageAcceptedResponse | JsonObject> {
    if (!this.fetchImpl) throw new Error('fetch is not available.');
    const payload: LocalDesktopInboundMessage = {
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
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/messages`, {
          method: 'POST',
          headers: this.authHeaders({ 'content-type': 'application/json' }),
          body: bodyText,
          signal: Number(timeoutMs) > 0 ? AbortSignal.timeout(Number(timeoutMs)) : undefined,
        });
        let body: (LocalDesktopMessageAcceptedResponse | LocalDesktopErrorResponse | JsonObject | null) = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (res.ok) return body || { ok: true };
        const errorText = body && 'message' in body
          ? body.message
          : body && 'error' in body
            ? body.error
            : '';
        const error: GatewayError = new Error(errorText ? String(errorText) : `Gateway message failed: ${res.status}`);
        error.status = res.status;
        error.body = body;
        if (!isRetryableStatus(res.status) || attempt === attempts - 1) throw error;
        lastError = error;
      } catch (e: any) {
        if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
          const timeoutError: GatewayError = new Error(`Gateway message timed out after ${Number(timeoutMs)}ms`);
          timeoutError.code = 'ETIMEDOUT';
          e = timeoutError;
        }
        if (e && e.status && !isRetryableStatus(e.status)) throw e;
        const actionable = e && e.status ? e : gatewayConnectionError(e, this.baseUrl);
        if (attempt === attempts - 1) throw actionable;
        lastError = actionable;
      }
      await delay(Math.min(250, 50 * (attempt + 1)));
    }
    throw lastError || new Error('Gateway message failed.');
  }

  start() {
    if (!this.key) throw new Error('Missing LOCAL_DESKTOP_GATEWAY_KEY for Hermes gateway. Set LOCAL_DESKTOP_GATEWAY_KEY, AGENT_UI_HERMES_GATEWAY_KEY, or create the active Hermes .env file.');
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
    this.flushState();
  }

  async streamLoop() {
    let delayMs = 500;
    while (this.running) {
      try {
        await this.openEventStream();
        delayMs = 500;
      } catch (e: any) {
        if (!this.running) return;
        if (e && e.status === 409 && e.code === 'replay_window_expired') {
          this.state.lastSeq = 0;
          this.saveState();
          this.onReplayExpired(e);
          delayMs = 100;
        } else {
          this.logSseDisconnect(e);
          this.reportConnection('disconnected', e);
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
      const error: GatewayError = new Error((body && body.message) || 'SSE replay window expired.');
      error.status = 409;
      error.code = body && body.error;
      throw error;
    }
    if (!res.ok) throw new Error(`Gateway event stream failed: ${res.status}`);
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('Gateway event stream is not readable.');
    }
    this.reportConnection('connected');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamEnded = false;
    while (this.running) {
      const { value, done } = await reader.read();
      if (done) {
        streamEnded = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let frameBoundary = /\r\n\r\n|\n\n/.exec(buffer);
      while (frameBoundary) {
        const frame = buffer.slice(0, frameBoundary.index);
        buffer = buffer.slice(frameBoundary.index + frameBoundary[0].length);
        const event = parseSseFrame(frame);
        if (event) this.handleEvent(event);
        frameBoundary = /\r\n\r\n|\n\n/.exec(buffer);
      }
    }
    if (streamEnded && this.running) {
      throw new Error('Gateway event stream closed.');
    }
  }

  handleEvent(event: JsonObject) {
    const seq = Number(event && event.seq);
    if (Number.isFinite(seq)) {
      const nextSeq = Math.trunc(seq);
      const currentSeq = Number(this.state.lastSeq || 0);
      if (nextSeq <= currentSeq) return;
      this.onEvent(event);
      this.state.lastSeq = nextSeq;
      this.scheduleStateSave();
      return;
    }
    this.onEvent(event);
  }
}

module.exports = {
  HermesGatewayClient,
  defaultStatePath,
  defaultGatewayEnvPath,
  gatewayBaseUrlFromEnv,
  gatewayKeyFromEnv,
  getAgentUIConfigDir,
  parseSseFrame,
  parseGatewayEnvText,
  realUserHomeDir,
  readGatewayEnvFile,
};
