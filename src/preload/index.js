const { contextBridge, ipcRenderer } = require('electron');

const MAX_CAT_ID_LENGTH = 128;
const MAX_TEXT_CHARS = 200000;
const MAX_EVAL_PAYLOAD_BYTES = 65536;

function text(value, maxChars = MAX_TEXT_CHARS) {
  const out = value == null ? '' : String(value);
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

function catId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > MAX_CAT_ID_LENGTH) return '';
  return /^[A-Za-z0-9_.:-]+$/.test(id) ? id : '';
}

function number(value, maxAbs = 10000) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > maxAbs) return null;
  return n;
}

function payloadWithinLimit(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload || {}), 'utf8') <= MAX_EVAL_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

const SKIP_PAYLOAD = Symbol('skip-payload');

function onSafe(channel, callback, mapPayload = (payload) => payload) {
  const listener = (_event, payload) => {
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
  traceEvalEvent: (payload) => {
    if (payloadWithinLimit(payload)) ipcRenderer.send('eval-trace-event', payload);
  },
  reportEvalUiState: (surface, payload) => {
    const safePayload = { surface: text(surface, 64), payload };
    if (payloadWithinLimit(safePayload)) ipcRenderer.send('eval-ui-state', safePayload);
  },
  submitNewCat: (payload = {}) => ipcRenderer.send('new-cat-submit', {
    modalContextId: catId(payload.modalContextId),
    prompt: text(payload.prompt),
    runtime: 'local',
  }),
  cancelNewCat: () => ipcRenderer.send('new-cat-cancel'),
  onVoiceInputStatus: (callback) => onSafe('voice-input-status', callback, (payload = {}) => {
    if (!payload || typeof payload !== 'object') return SKIP_PAYLOAD;
    return {
      modalContextId: catId(payload.modalContextId),
      state: text(payload.state, 64),
      transcript: text(payload.transcript),
      error: text(payload.error, 4096),
      provider: text(payload.provider, 128),
    };
  }),
  overlayReady: () => ipcRenderer.send('overlay-ready'),
  togglePetOverlay: () => ipcRenderer.send('pet-overlay-toggle'),
  getPetCharacters: () => ipcRenderer.invoke('get-pet-characters'),
  refreshPetCharacters: () => ipcRenderer.send('pet-characters-refresh'),
  showPetContextMenu: () => ipcRenderer.send('pet-context-menu'),
  startPetDrag: (payload = {}) => {
    const pointerWindowX = number(payload.pointerWindowX);
    const pointerWindowY = number(payload.pointerWindowY);
    if (pointerWindowX == null || pointerWindowY == null) return;
    ipcRenderer.send('pet-drag-start', { pointerWindowX, pointerWindowY });
  },
  movePetDrag: () => ipcRenderer.send('pet-drag-move'),
  endPetDrag: () => ipcRenderer.send('pet-drag-end'),
  releasePetDrag: (payload = {}) => {
    const velocityX = number(payload.velocityX, 5000);
    const velocityY = number(payload.velocityY, 5000);
    if (velocityX == null || velocityY == null) return;
    ipcRenderer.send('pet-drag-release', { velocityX, velocityY });
  },
  reportPetElementSize: (payload) => {
    if (payload && typeof payload === 'object') ipcRenderer.send('pet-element-size-changed', payload);
  },
  setPetPointerInteraction: (active) => ipcRenderer.send('pet-pointer-interaction-changed', { active: !!active }),
  onPetLayoutChanged: (callback) => onSafe('pet-layout-changed', callback),
  onPetCharacterChanged: (callback) => onSafe('pet-character-changed', callback),
  onSpawnCat: (callback) => onSafe('spawn-cat', callback),
  onAgentFinished: (callback) => onSafe('agent-finished', callback),
  onAgentStreamBubble: (callback) => onSafe('agent-stream-bubble', callback),
  openCatConversation: (value) => {
    const id = catId(value);
    if (id) ipcRenderer.send('open-cat-conversation', { catId: id });
  },
  getAgentConversation: (value) => ipcRenderer.invoke('get-agent-conversation', catId(value)),
  onConversationUpdated: (callback) => onSafe('conversation-updated', callback),
  closeConversationWindow: () => {
    ipcRenderer.send('close-conversation-window');
  },
  dismissCat: (value) => {
    const id = catId(value);
    if (id) ipcRenderer.send('dismiss-cat', { catId: id });
  },
  sendFollowup: (value, body) => {
    return ipcRenderer.invoke('agent-followup', { catId: catId(value), text: text(body) });
  },
  cancelAgent: (value) => {
    return ipcRenderer.invoke('agent-cancel', { catId: catId(value) });
  },
  openAgentAttachment: (url) => {
    return ipcRenderer.invoke('open-agent-attachment', { url: text(url, 4096) });
  },
  openExternalUrl: (url) => {
    return ipcRenderer.invoke('open-external-url', { url: text(url, 4096) });
  },
  copyText: (value) => {
    return ipcRenderer.invoke('clipboard-write-text', { text: text(value, 20000) });
  },
  getHermesAuthStatus: () => ipcRenderer.invoke('hermes-auth-status'),
  addHermesApiKey: (payload = {}) => ipcRenderer.invoke('hermes-auth-add-api-key', {
    provider: text(payload.provider, 96),
    apiKey: text(payload.apiKey, 20000),
    label: text(payload.label, 80),
  }),
  saveHermesModel: (payload = {}) => ipcRenderer.invoke('hermes-auth-save-model', {
    provider: text(payload.provider, 96),
    model: text(payload.model, 256),
  }),
  startHermesOAuth: (payload = {}) => ipcRenderer.invoke('hermes-auth-oauth-start', {
    provider: text(payload.provider, 96),
    retry: !!payload.retry,
  }),
  sendHermesOAuthInput: (payload = {}) => ipcRenderer.invoke('hermes-auth-oauth-input', {
    sessionId: text(payload.sessionId, 128),
    input: text(payload.input, 10000),
  }),
  cancelHermesOAuth: (payload = {}) => ipcRenderer.invoke('hermes-auth-oauth-cancel', {
    sessionId: text(payload.sessionId, 128),
  }),
  finishHermesAuth: () => ipcRenderer.invoke('hermes-auth-finish'),
  dismissHermesAuth: () => ipcRenderer.invoke('hermes-auth-dismiss'),
  checkHermesAuthNow: () => ipcRenderer.invoke('hermes-auth-check-now'),
  closeHermesAuth: () => ipcRenderer.send('hermes-auth-close'),
  openHermesAuth: () => ipcRenderer.send('hermes-auth-open'),
  onHermesAuthEvent: (callback) => onSafe('hermes-auth-event', callback),
  onHermesAuthContext: (callback) => onSafe('hermes-auth-context', callback),
  onAgentRestarted: (callback) => onSafe('agent-restarted', callback),
  onRemoveCat: (callback) => onSafe('remove-cat', callback),
  reportCatCounts: (counts) => {
    ipcRenderer.send('cat-counts', counts);
  },
});
