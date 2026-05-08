const { contextBridge, ipcRenderer } = require('electron');

import type { AgentUIPayload } from '../shared/contracts.ts';

const MAX_CAT_ID_LENGTH = 128;
const MAX_TEXT_CHARS = 200000;
const MAX_EVAL_PAYLOAD_BYTES = 65536;

type SafeCallback = (payload: unknown) => void;
type PayloadMapper = (payload: unknown) => unknown | typeof SKIP_PAYLOAD;

function text(value: any, maxChars = MAX_TEXT_CHARS) {
  const out = value == null ? '' : String(value);
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

function catId(value: any) {
  const id = String(value || '').trim();
  if (!id || id.length > MAX_CAT_ID_LENGTH) return '';
  return /^[A-Za-z0-9_.:-]+$/.test(id) ? id : '';
}

function number(value: any, maxAbs = 10000) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > maxAbs) return null;
  return n;
}

function payloadWithinLimit(payload: any) {
  try {
    return Buffer.byteLength(JSON.stringify(payload || {}), 'utf8') <= MAX_EVAL_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

const SKIP_PAYLOAD = Symbol('skip-payload');

function payloadObject(value: unknown): AgentUIPayload {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AgentUIPayload : {};
}

function onSafe(channel: string, callback: SafeCallback, mapPayload: PayloadMapper = (payload) => payload) {
  const listener = (_event: unknown, payload: unknown) => {
    try {
      const mappedPayload = mapPayload(payload);
      if (mappedPayload === SKIP_PAYLOAD) return;
      callback(mappedPayload);
    } catch {
      // ignore renderer callback errors
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('agentUI', {
  traceEvalEvent: (payload: any) => {
    if (payloadWithinLimit(payload)) ipcRenderer.send('eval-trace-event', payload);
  },
  reportEvalUiState: (surface: any, payload: any) => {
    const safePayload = { surface: text(surface, 64), payload };
    if (payloadWithinLimit(safePayload)) ipcRenderer.send('eval-ui-state', safePayload);
  },
  submitNewCat: (payload: AgentUIPayload = {}) => ipcRenderer.send('new-cat-submit', {
    modalContextId: catId(payload.modalContextId),
    prompt: text(payload.prompt),
  }),
  cancelNewCat: () => ipcRenderer.send('new-cat-cancel'),
  onVoiceInputStatus: (callback: SafeCallback) => onSafe('voice-input-status', callback, (payload: unknown = {}) => {
    if (!payload || typeof payload !== 'object') return SKIP_PAYLOAD;
    const safePayload = payloadObject(payload);
    return {
      modalContextId: catId(safePayload.modalContextId),
      state: text(safePayload.state, 64),
      transcript: text(safePayload.transcript),
      error: text(safePayload.error, 4096),
      provider: text(safePayload.provider, 128),
    };
  }),
  overlayReady: () => ipcRenderer.send('overlay-ready'),
  getPetCharacters: () => ipcRenderer.invoke('get-pet-characters'),
  showPetContextMenu: () => ipcRenderer.send('pet-context-menu'),
  startPetDrag: (payload: AgentUIPayload = {}) => {
    const pointerWindowX = number(payload.pointerWindowX);
    const pointerWindowY = number(payload.pointerWindowY);
    if (pointerWindowX == null || pointerWindowY == null) return;
    ipcRenderer.send('pet-drag-start', { pointerWindowX, pointerWindowY });
  },
  movePetDrag: () => ipcRenderer.send('pet-drag-move'),
  endPetDrag: () => ipcRenderer.send('pet-drag-end'),
  releasePetDrag: (payload: AgentUIPayload = {}) => {
    const velocityX = number(payload.velocityX, 5000);
    const velocityY = number(payload.velocityY, 5000);
    if (velocityX == null || velocityY == null) return;
    ipcRenderer.send('pet-drag-release', { velocityX, velocityY });
  },
  reportPetElementSize: (payload: any) => {
    if (payload && typeof payload === 'object') ipcRenderer.send('pet-element-size-changed', payload);
  },
  setPetPointerInteraction: (active: any) => ipcRenderer.send('pet-pointer-interaction-changed', { active: !!active }),
  onPetLayoutChanged: (callback: any) => onSafe('pet-layout-changed', callback),
  onPetCharacterChanged: (callback: any) => onSafe('pet-character-changed', callback),
  onSpawnCat: (callback: any) => onSafe('spawn-cat', callback),
  onAgentFinished: (callback: any) => onSafe('agent-finished', callback),
  onAgentStreamBubble: (callback: any) => onSafe('agent-stream-bubble', callback),
  openCatConversation: (value: any) => {
    const id = catId(value);
    if (id) ipcRenderer.send('open-cat-conversation', { catId: id });
  },
  getAgentConversation: (value: any) => ipcRenderer.invoke('get-agent-conversation', catId(value)),
  onConversationUpdated: (callback: any) => onSafe('conversation-updated', callback),
  closeConversationWindow: () => {
    ipcRenderer.send('close-conversation-window');
  },
  dismissCat: (value: any) => {
    const id = catId(value);
    if (id) ipcRenderer.send('dismiss-cat', { catId: id });
  },
  sendFollowup: (value: any, body: any) => {
    return ipcRenderer.invoke('agent-followup', { catId: catId(value), text: text(body) });
  },
  cancelAgent: (value: any) => {
    return ipcRenderer.invoke('agent-cancel', { catId: catId(value) });
  },
  openAgentAttachment: (url: any) => {
    return ipcRenderer.invoke('open-agent-attachment', { url: text(url, 4096) });
  },
  openExternalUrl: (url: any) => {
    return ipcRenderer.invoke('open-external-url', { url: text(url, 4096) });
  },
  copyText: (value: any) => {
    return ipcRenderer.invoke('clipboard-write-text', { text: text(value, 20000) });
  },
  getHermesAuthStatus: () => ipcRenderer.invoke('hermes-auth-status'),
  addHermesApiKey: (payload: AgentUIPayload = {}) => ipcRenderer.invoke('hermes-auth-add-api-key', {
    provider: text(payload.provider, 96),
    apiKey: text(payload.apiKey, 20000),
    label: text(payload.label, 80),
  }),
  saveHermesModel: (payload: AgentUIPayload = {}) => ipcRenderer.invoke('hermes-auth-save-model', {
    provider: text(payload.provider, 96),
    model: text(payload.model, 256),
  }),
  startHermesOAuth: (payload: AgentUIPayload = {}) => ipcRenderer.invoke('hermes-auth-oauth-start', {
    provider: text(payload.provider, 96),
    retry: !!payload.retry,
  }),
  sendHermesOAuthInput: (payload: AgentUIPayload = {}) => ipcRenderer.invoke('hermes-auth-oauth-input', {
    sessionId: text(payload.sessionId, 128),
    input: text(payload.input, 10000),
  }),
  cancelHermesOAuth: (payload: AgentUIPayload = {}) => ipcRenderer.invoke('hermes-auth-oauth-cancel', {
    sessionId: text(payload.sessionId, 128),
  }),
  finishHermesAuth: () => ipcRenderer.invoke('hermes-auth-finish'),
  dismissHermesAuth: () => ipcRenderer.invoke('hermes-auth-dismiss'),
  checkHermesAuthNow: () => ipcRenderer.invoke('hermes-auth-check-now'),
  closeHermesAuth: () => ipcRenderer.send('hermes-auth-close'),
  openHermesAuth: () => ipcRenderer.send('hermes-auth-open'),
  onHermesAuthEvent: (callback: any) => onSafe('hermes-auth-event', callback),
  onHermesAuthContext: (callback: any) => onSafe('hermes-auth-context', callback),
  onAgentRestarted: (callback: any) => onSafe('agent-restarted', callback),
  onRemoveCat: (callback: any) => onSafe('remove-cat', callback),
  reportCatCounts: (counts: any) => {
    ipcRenderer.send('cat-counts', counts);
  },
});
