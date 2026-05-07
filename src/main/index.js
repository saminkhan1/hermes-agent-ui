const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  clipboard,
  screen,
  shell,
  protocol,
  net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fileURLToPath, pathToFileURL } = require('url');
const { randomUUID, createHash } = require('crypto');
const { execFile } = require('child_process');
const {
  recordTrace,
  getTrace,
  runDir: evalRunDir,
  runId: evalRunId,
  enabled: evalTraceEnabled,
} = require('./eval-trace');
const {
  startAgentForCat,
  cancelAllAgents,
  getAgentConversation,
  listAgentConversations,
  hydrateGatewayConversations,
  setOnConversationPushed,
  setOnAuthRequired,
  cancelAgent,
  dismissAgent,
  sendFollowup,
  getAgentArtifacts,
} = require('./agents');
const { startAgentUIEvalServer } = require('./eval-server');
const {
  PET_DEFAULT_MASCOT_SIZE,
  PET_DEFAULT_TRAY_SIZE,
  PET_WINDOW_HEIGHT,
  PET_WINDOW_WIDTH,
  computePetLayout,
  defaultPetAnchor: defaultPetAnchorForDisplay,
  pointForRectCenter,
} = require('./pet-layout');
const petAssets = require('./pet-assets');
const hermesAttachments = require('./hermes-attachments');
const hermesAuth = require('./hermes-auth');
const { captureAndTranscribeVoice } = require('./hermes-runtime');
const { clearCurrentWindow, focusWindow, isCurrentWindow, isLiveWindow, runForCurrentWindow } = require('./window-lifecycle');

const IS_MAC = process.platform === 'darwin';
const MAC_FULL_SCREEN_WORKSPACE_OPTIONS = {
  visibleOnFullScreen: true,
  skipTransformProcessType: true,
};
const PET_OVERLAY_WINDOW_LEVEL = 'floating';
const FOCUSED_OVERLAY_WINDOW_LEVEL = 'modal-panel';
const CUSTOM_PET_PREFIX = petAssets.CUSTOM_PET_PREFIX;
const PET_DRAG_DISPLAY_HYSTERESIS = 24;
const PET_MOMENTUM_INTERVAL_MS = 16;
const PET_MOMENTUM_DECAY = 0.88;
const PET_MOMENTUM_STOP_SPEED = 65;
const PET_MOMENTUM_MAX_DURATION_MS = 900;
const FALLBACK_PET_CHARACTER_ID = `${CUSTOM_PET_PREFIX}goblin`;
const PET_ASSET_SCHEME = petAssets.PET_ASSET_SCHEME;
const ATTACHMENT_SCHEME = hermesAttachments.ATTACHMENT_SCHEME;
const MAX_CAT_ID_LENGTH = 128;
const MAX_PROMPT_CHARS = 200000;
const MAX_EVAL_PAYLOAD_BYTES = 65536;
const MAX_DRAG_COORDINATE = 10000;
const MAX_REPORTED_ELEMENT_SIZE = 2000;
const ACTIVE_WINDOW_CACHE_INTERVAL_MS = 3000;
const ACTIVE_WINDOW_CACHE_DURATION_MS = 15000;
const INPUT_MODE_TEXT = 'text';
const INPUT_MODE_VOICE = 'voice';
const AUTH_MONITOR_INTERVAL_MS = 2500;
const AUTH_STALE_MS = 25000;

protocol.registerSchemesAsPrivileged([
  {
    scheme: PET_ASSET_SCHEME,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
  {
    scheme: ATTACHMENT_SCHEME,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
]);

let getWindowsModulePromise = null;

function loadGetWindowsModule() {
  if (!getWindowsModulePromise) {
    getWindowsModulePromise = import('get-windows').catch((err) => {
      getWindowsModulePromise = null;
      throw err;
    });
  }
  return getWindowsModulePromise;
}

/**
 * Root of the installed package (`package.json`, `assets/`, `out/`).
 * Do not use `app.getAppPath()` for files here: when Electron is started with an explicit
 * main module (e.g. `npx …` / `electron out/main/index.js`), it returns `out/main/`, not
 * the package root, so `assets/` would not be found.
 */
function getPackageRoot() {
  return path.resolve(__dirname, '..', '..');
}

function getCodexHomeDir() {
  const configured = String(process.env.CODEX_HOME || '').trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function primaryCodexPetsDir() {
  const dir = path.join(getCodexHomeDir(), 'pets');
  ensureDir(dir);
  return dir;
}

function loadPetCharacterOptions() {
  return petAssets.loadPetCharacterOptions({
    codexHome: getCodexHomeDir(),
    packageRoot: getPackageRoot(),
  });
}

function petCharactersPayload() {
  return petAssets.petCharactersPayload({
    options: petCharacterOptions,
    selectedId: selectedPetCharacterId,
  });
}

function findPetCharacter(id) {
  const value = String(id || '').trim();
  return petCharacterOptions.find((pet) => pet.id === value) || null;
}

function installPetAssetProtocol() {
  protocol.handle(PET_ASSET_SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'sprite') return new Response('not found', { status: 404 });
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const pet = findPetCharacter(id);
      if (!pet || !pet.spritesheetPath) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(pet.spritesheetPath).toString());
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

function installAttachmentProtocol() {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    try {
      const resolved = hermesAttachments.resolveAttachmentRequest(request.url);
      if (!resolved || !resolved.file) return new Response('not found', { status: 404 });
      const upstream = await net.fetch(pathToFileURL(resolved.file).toString());
      const headers = new Headers(upstream.headers);
      if (resolved.mimeType) headers.set('content-type', resolved.mimeType);
      headers.set('cache-control', 'no-store');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

function execFileText(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 5000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

let mainWindow;
let modalWindow;
let conversationWindow;
let authWindow;
let activeConversationCatId = null;
/** Square conversation panel — content dimensions (px). */
const CONVERSATION_WINDOW_SIDE = 800;
/** When true, the overlay is accepting mouse (cursor over a cat). */
let mainWindowMouseable = false;
let tray;
let closeEvalServer = null;
/** Latest overlay session counts from renderer (dock / tray menu). */
let catCounts = { active: 0, inReview: 0 };
let overlayReady = false;
const pendingSpawnCats = [];
let activeModalContextId = null;
const modalContexts = new Map();
let pendingAuthRun = null;
let authMonitorTimer = null;
let authFlow = idleAuthFlow();
const ignoredAuthSessionIds = new Set();
const evalUiSnapshots = new Map();
let lastExternalWindowSnapshot = null;
let activeWindowCacheTimer = null;
let activeWindowCacheStopTimer = null;
let petOverlayOpenRequested = false;
let petWindowMovePersistTimer = null;
let applyingPetWindowBounds = false;
let petPointerInteractive = false;
let petAnchor = null;
let petDragState = null;
let petLayout = null;
let petMascotSize = { ...PET_DEFAULT_MASCOT_SIZE };
let petMomentumTimer = null;
let petTraySize = null;
let petPlacement = 'top-end';
let petCharacterOptions = [];
let selectedPetCharacterId = FALLBACK_PET_CHARACTER_ID;
let selectedInputMode = INPUT_MODE_TEXT;

hermesAuth.onSessionEvent((payload) => {
  handleHermesAuthSessionEvent(payload);
});

setOnAuthRequired((payload = {}) => {
  const catId = normalizeCatId(payload.catId);
  const prompt = boundedText(payload.prompt || '');
  if (!catId || !prompt.trim()) return;
  openHermesAuthWindow({
    pendingRun: {
      catId,
      prompt,
      runtime: 'local',
      modalContextId: '',
      launchContext: payload.launchContext || null,
    },
    reason: payload.reason || 'gateway-auth-error',
  });
});

function idleAuthFlow() {
  return {
    sessionId: '',
    provider: '',
    state: 'idle',
    latestUrl: '',
    userCode: '',
    lastError: '',
    hidden: false,
    startedAt: 0,
    lastEventAt: 0,
  };
}

function authFlowIsRecoverable() {
  return !!pendingAuthRun || !!authFlow.sessionId || authFlow.state !== 'idle';
}

function authFlowIsWaiting() {
  return !!authFlow.sessionId && (authFlow.state === 'waiting' || authFlow.state === 'stale');
}

function authContextPayload(reason = '') {
  return {
    hasPendingRun: !!pendingAuthRun,
    reason: String(reason || ''),
    authFlow: { ...authFlow },
  };
}

function sendHermesAuthContext(reason = '') {
  if (!authWindow || authWindow.isDestroyed()) return;
  authWindow.webContents.send('hermes-auth-context', authContextPayload(reason));
}

function sendHermesAuthEvent(payload = {}) {
  if (!authWindow || authWindow.isDestroyed()) return;
  authWindow.webContents.send('hermes-auth-event', {
    ...payload,
    authFlow: { ...authFlow },
    hasPendingRun: !!pendingAuthRun,
  });
}

function stopAuthMonitor() {
  if (authMonitorTimer) clearInterval(authMonitorTimer);
  authMonitorTimer = null;
}

function startAuthMonitor() {
  stopAuthMonitor();
  authMonitorTimer = setInterval(() => {
    void checkHermesAuthFlow('poll');
  }, AUTH_MONITOR_INTERVAL_MS);
  void checkHermesAuthFlow('start');
}

function authStatusHasProvider(status = {}, provider = '') {
  const target = String(provider || '').trim();
  const providers = Array.isArray(status.providers) ? status.providers : [];
  if (!target) return providers.length > 0;
  return providers.some((entry) => String(entry?.slug || entry?.id || '').trim() === target);
}

function markAuthFlow(state, patch = {}) {
  authFlow = {
    ...authFlow,
    ...patch,
    state,
    lastEventAt: Date.now(),
  };
  rebuildAppMenus();
  sendHermesAuthContext(`auth-${state}`);
}

function resetAuthFlow({ clearPending = false } = {}) {
  stopAuthMonitor();
  authFlow = idleAuthFlow();
  if (clearPending) pendingAuthRun = null;
  rebuildAppMenus();
  sendHermesAuthContext('auth-reset');
}

function showHermesAuthWindowForState(reason = '') {
  authFlow.hidden = false;
  if (authWindow && !authWindow.isDestroyed()) {
    focusWindow(authWindow);
    sendHermesAuthContext(reason);
    return authWindow;
  }
  return openHermesAuthWindow({ reason });
}

function dismissHermesAuthWindow() {
  if (!authWindow || authWindow.isDestroyed()) return { ok: true, dismissed: false };
  if (!authFlowIsRecoverable()) {
    authWindow.close();
    return { ok: true, dismissed: false };
  }
  authFlow.hidden = true;
  authWindow.hide();
  rebuildAppMenus();
  return { ok: true, dismissed: true, authFlow: { ...authFlow } };
}

async function checkHermesAuthFlow(reason = 'check') {
  if (!authFlowIsWaiting()) return authContextPayload(reason);
  const sessionAtStart = authFlow.sessionId;
  try {
    const status = await hermesAuth.getAuthStatus();
    if (sessionAtStart !== authFlow.sessionId) return authContextPayload(reason);
    if (authStatusHasProvider(status, authFlow.provider)) {
      stopAuthMonitor();
      markAuthFlow('success', { hidden: false, lastError: '' });
      showHermesAuthWindowForState('auth-success');
      return authContextPayload('auth-success');
    }
    const ageMs = Date.now() - (authFlow.startedAt || authFlow.lastEventAt || Date.now());
    if (authFlow.state === 'waiting' && ageMs >= AUTH_STALE_MS) {
      markAuthFlow('stale', {
        hidden: false,
        lastError: 'Still waiting for browser sign-in.',
      });
      showHermesAuthWindowForState('auth-stale');
    }
  } catch (error) {
    if (sessionAtStart !== authFlow.sessionId) return authContextPayload(reason);
    stopAuthMonitor();
    markAuthFlow('failed', {
      hidden: false,
      lastError: error && error.message ? error.message : String(error),
    });
    showHermesAuthWindowForState('auth-status-failed');
  }
  return authContextPayload(reason);
}

function startHermesOAuthFlow(payload = {}) {
  const retry = !!payload.retry;
  if (retry && authFlow.sessionId) {
    ignoredAuthSessionIds.add(authFlow.sessionId);
    hermesAuth.cancelOAuthSession({ sessionId: authFlow.sessionId });
  }
  const result = hermesAuth.startOAuthSession(payload);
  if (!result || result.ok === false) return result;
  const now = Date.now();
  authFlow = {
    ...idleAuthFlow(),
    sessionId: String(result.sessionId || ''),
    provider: String(result.provider || payload.provider || ''),
    state: 'waiting',
    hidden: false,
    startedAt: now,
    lastEventAt: now,
  };
  rebuildAppMenus();
  startAuthMonitor();
  sendHermesAuthContext('auth-started');
  return { ...result, authFlow: { ...authFlow }, hasPendingRun: !!pendingAuthRun };
}

function cancelHermesOAuthFlow(payload = {}, { clearPending = true } = {}) {
  const sessionId = String(payload.sessionId || authFlow.sessionId || '').trim();
  if (sessionId) {
    ignoredAuthSessionIds.add(sessionId);
    hermesAuth.cancelOAuthSession({ sessionId });
  }
  resetAuthFlow({ clearPending });
  return { ok: true };
}

function handleHermesAuthSessionEvent(payload = {}) {
  const sessionId = String(payload.sessionId || '').trim();
  if (sessionId && ignoredAuthSessionIds.has(sessionId)) {
    if (payload.type === 'exit' || payload.type === 'error') ignoredAuthSessionIds.delete(sessionId);
    return;
  }
  if (sessionId && authFlow.sessionId && sessionId !== authFlow.sessionId) return;
  if ((payload.type === 'exit' || payload.type === 'error') && authFlow.state === 'success') {
    sendHermesAuthEvent(payload);
    return;
  }

  if (payload.type === 'output') {
    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    authFlow = {
      ...authFlow,
      sessionId: sessionId || authFlow.sessionId,
      provider: String(payload.provider || authFlow.provider || ''),
      latestUrl: urls.length ? String(urls[urls.length - 1] || '') : authFlow.latestUrl,
      userCode: payload.userCode ? String(payload.userCode || '') : authFlow.userCode,
      state: authFlow.state === 'idle' ? 'waiting' : authFlow.state,
      lastEventAt: Date.now(),
    };
    sendHermesAuthEvent(payload);
    sendHermesAuthContext('auth-output');
    return;
  }

  if (payload.type === 'exit') {
    stopAuthMonitor();
    if (payload.ok) {
      markAuthFlow('success', { hidden: false, lastError: '' });
      showHermesAuthWindowForState('auth-success');
    } else {
      markAuthFlow('failed', {
        hidden: false,
        lastError: payload.stderr || payload.stdout || 'Hermes sign-in failed.',
      });
      showHermesAuthWindowForState('auth-failed');
    }
    sendHermesAuthEvent(payload);
    return;
  }

  if (payload.type === 'error') {
    stopAuthMonitor();
    markAuthFlow('failed', {
      hidden: false,
      lastError: payload.error || 'Hermes sign-in failed.',
    });
    showHermesAuthWindowForState('auth-error');
    sendHermesAuthEvent(payload);
    return;
  }

  sendHermesAuthEvent(payload);
}

function getPetOverlayStatePath() {
  return path.join(getAgentUIConfigDir(), 'pet-overlay.json');
}

function getAppSettingsPath() {
  return path.join(getAgentUIConfigDir(), 'settings.json');
}

function readAppSettings() {
  try {
    const file = getAppSettingsPath();
    if (!fs.existsSync(file)) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeAppSettings(patch = {}) {
  try {
    const file = getAppSettingsPath();
    const current = readAppSettings();
    fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8');
  } catch {
    // ignore persistence errors
  }
}

function normalizeInputMode(value) {
  return String(value || '').trim() === INPUT_MODE_VOICE ? INPUT_MODE_VOICE : INPUT_MODE_TEXT;
}

function loadInputModeSetting() {
  selectedInputMode = normalizeInputMode(readAppSettings().inputMode);
}

function setSelectedInputMode(mode, { persist = true } = {}) {
  selectedInputMode = normalizeInputMode(mode);
  if (persist) writeAppSettings({ inputMode: selectedInputMode });
  rebuildAppMenus();
}

function readPetOverlayState() {
  try {
    const file = getPetOverlayStatePath();
    if (!fs.existsSync(file)) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writePetOverlayState(patch = {}) {
  try {
    const file = getPetOverlayStatePath();
    const current = readPetOverlayState();
    fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8');
  } catch {
    // ignore persistence errors
  }
}

function normalizePetCharacterId(id) {
  const value = String(id || '').trim();
  const aliases = [
    value,
    value.startsWith(CUSTOM_PET_PREFIX) ? value.slice(CUSTOM_PET_PREFIX.length) : `${CUSTOM_PET_PREFIX}${value}`,
  ];
  const match = aliases.find((candidate) => petCharacterOptions.some((pet) => pet.id === candidate));
  return match || (petCharacterOptions[0] ? petCharacterOptions[0].id : FALLBACK_PET_CHARACTER_ID);
}

function sendPetCharacterToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed() || !overlayReady) return;
  mainWindow.webContents.send('pet-character-changed', petCharactersPayload());
}

function refreshPetCharacterOptions({ notify = false } = {}) {
  petCharacterOptions = loadPetCharacterOptions();
  selectedPetCharacterId = normalizePetCharacterId(selectedPetCharacterId);
  if (notify) sendPetCharacterToRenderer();
  rebuildAppMenus();
}

function setSelectedPetCharacter(id, { persist = true } = {}) {
  const next = normalizePetCharacterId(id);
  const changed = selectedPetCharacterId !== next;
  selectedPetCharacterId = next;
  if (persist) writePetOverlayState({ petCharacter: next });
  if (changed) sendPetCharacterToRenderer();
  rebuildAppMenus();
}

function safeInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function boundedText(value, maxChars = MAX_PROMPT_CHARS) {
  const text = value == null ? '' : String(value);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function normalizeCatId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > MAX_CAT_ID_LENGTH) return '';
  return /^[A-Za-z0-9_.:-]+$/.test(id) ? id : '';
}

function finiteNumberInRange(value, maxAbs = MAX_DRAG_COORDINATE) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > maxAbs) return null;
  return n;
}

function normalizedDragStartPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const pointerWindowX = finiteNumberInRange(payload.pointerWindowX);
  const pointerWindowY = finiteNumberInRange(payload.pointerWindowY);
  if (pointerWindowX == null || pointerWindowY == null) return null;
  return { pointerWindowX, pointerWindowY };
}

function normalizedDragReleasePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const velocityX = finiteNumberInRange(payload.velocityX, 5000);
  const velocityY = finiteNumberInRange(payload.velocityY, 5000);
  if (velocityX == null || velocityY == null) return null;
  return { velocityX, velocityY };
}

function normalizedSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_REPORTED_ELEMENT_SIZE) return null;
  return Math.ceil(n);
}

function evalPayloadWithinLimit(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload || {}), 'utf8') <= MAX_EVAL_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

const TRUSTED_RENDERER_PAGES = new Set(['index.html', 'modal.html', 'conversation.html', 'auth.html']);
const TRUSTED_RENDERER_DEV_PATHS = new Set(['/', '/index.html', '/modal.html', '/conversation.html', '/auth.html']);

function isLoopbackHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function trustedRendererDevBaseUrl() {
  const raw = String(process.env.ELECTRON_RENDERER_URL || '').trim();
  if (!raw) return '';
  if (app.isPackaged) {
    console.warn('[agent-ui] ignoring ELECTRON_RENDERER_URL in packaged app');
    return '';
  }
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !isLoopbackHost(parsed.hostname)) {
      console.warn('[agent-ui] ignoring untrusted ELECTRON_RENDERER_URL:', raw);
      return '';
    }
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = '/';
    return parsed.origin;
  } catch {
    console.warn('[agent-ui] ignoring invalid ELECTRON_RENDERER_URL:', raw);
    return '';
  }
}

function trustedRendererFileDir() {
  return path.resolve(__dirname, '../renderer');
}

function isTrustedRendererUrl(urlValue) {
  const raw = String(urlValue || '').trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'file:') {
      const file = path.resolve(fileURLToPath(parsed));
      return path.dirname(file) === trustedRendererFileDir() &&
        TRUSTED_RENDERER_PAGES.has(path.basename(file));
    }
    const devBase = trustedRendererDevBaseUrl();
    if (!devBase) return false;
    const dev = new URL(devBase);
    return parsed.origin === dev.origin && TRUSTED_RENDERER_DEV_PATHS.has(parsed.pathname);
  } catch {
    return false;
  }
}

function applyTrustedWebContentsPolicy(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, urlValue) => {
    if (!isTrustedRendererUrl(urlValue)) {
      event.preventDefault();
    }
  });
}

function isTrustedIpcEvent(event, channel) {
  const urlValue = String(
    (event && event.senderFrame && event.senderFrame.url) ||
    (event && event.sender && typeof event.sender.getURL === 'function' ? event.sender.getURL() : '') ||
    ''
  );
  if (isTrustedRendererUrl(urlValue)) return true;
  console.warn('[agent-ui] rejected IPC from untrusted renderer', { channel, url: urlValue || 'unknown' });
  return false;
}

function trustedIpcOn(channel, listener) {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedIpcEvent(event, channel)) return;
    return listener(event, ...args);
  });
}

function trustedIpcHandle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcEvent(event, channel)) {
      return { ok: false, error: 'Untrusted renderer.' };
    }
    return listener(event, ...args);
  });
}

function macPanelWindowOptions() {
  return IS_MAC ? { type: 'panel' } : {};
}

function applyOverlayWindowPolicy(win, { level = PET_OVERLAY_WINDOW_LEVEL } = {}) {
  if (!win || win.isDestroyed()) return;
  if (IS_MAC) {
    win.setVisibleOnAllWorkspaces(true, MAC_FULL_SCREEN_WORKSPACE_OPTIONS);
    win.setAlwaysOnTop(true, level);
    return;
  }
  win.setAlwaysOnTop(true);
}

function usableBounds(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function displayPlacementBounds(displayLike) {
  const direct = displayLike && typeof displayLike === 'object' ? displayLike : null;
  const bounds = usableBounds(direct && (direct.workArea || direct.bounds));
  if (bounds) return bounds;
  const fallbackDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return usableBounds(fallbackDisplay.workArea) || usableBounds(fallbackDisplay.bounds);
}

function centeredWindowBounds(width, height, displayLike) {
  const windowWidth = Math.max(1, Math.round(Number(width) || 1));
  const windowHeight = Math.max(1, Math.round(Number(height) || 1));
  const primaryDisplay = screen.getPrimaryDisplay();
  const displayBounds =
    displayPlacementBounds(displayLike) ||
    usableBounds(primaryDisplay.workArea) ||
    usableBounds(primaryDisplay.bounds) ||
    { x: 0, y: 0, width: windowWidth, height: windowHeight };
  return {
    x: Math.round(displayBounds.x + Math.max(0, (displayBounds.width - windowWidth) / 2)),
    y: Math.round(displayBounds.y + Math.max(0, (displayBounds.height - windowHeight) / 2)),
    width: windowWidth,
    height: windowHeight,
  };
}

function launchDisplayForModal(modalContextId) {
  const launchContext = modalContextId ? (modalContexts.get(modalContextId) || null) : null;
  if (launchContext && launchContext.display) return launchContext.display;
  if (launchContext && launchContext.cursor) return screen.getDisplayNearestPoint(launchContext.cursor);
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function displayForPetOrCursor() {
  if (petAnchor) return screen.getDisplayNearestPoint(pointForRectCenter(petAnchor));
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function defaultPetAnchor(display = screen.getPrimaryDisplay()) {
  return defaultPetAnchorForDisplay(display.bounds, petMascotSize);
}

function displayBoundsForPetAnchor(anchor = petAnchor) {
  const point = anchor ? pointForRectCenter(anchor) : screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(point).bounds;
}

function initialPetWindowBounds() {
  const saved = readPetOverlayState();
  if (saved && saved.mascot && Number.isFinite(Number(saved.mascot.width)) && Number.isFinite(Number(saved.mascot.height))) {
    petMascotSize = { width: Number(saved.mascot.width), height: Number(saved.mascot.height) };
  }
  if (saved && saved.tray && Number.isFinite(Number(saved.tray.width)) && Number.isFinite(Number(saved.tray.height))) {
    petTraySize = { width: Number(saved.tray.width), height: Number(saved.tray.height) };
  }
  if (saved && typeof saved.placement === 'string') {
    petPlacement = saved.placement;
  }
  if (saved && saved.anchor && Number.isFinite(Number(saved.anchor.x)) && Number.isFinite(Number(saved.anchor.y))) {
    petAnchor = {
      x: Number(saved.anchor.x),
      y: Number(saved.anchor.y),
      width: Number(saved.anchor.width) || petMascotSize.width,
      height: Number(saved.anchor.height) || petMascotSize.height,
    };
  } else if (saved && saved.bounds && saved.mascot && Number.isFinite(Number(saved.bounds.x))) {
    petAnchor = {
      x: Number(saved.bounds.x) + Number(saved.mascot.left || 0),
      y: Number(saved.bounds.y) + Number(saved.mascot.top || 0),
      width: petMascotSize.width,
      height: petMascotSize.height,
    };
  } else {
    petAnchor = defaultPetAnchor();
  }
  petLayout = computePetLayout({
    anchor: petAnchor,
    displayBounds: displayBoundsForPetAnchor(petAnchor),
    mascotSize: petMascotSize,
    previousPlacement: petPlacement,
    traySize: petTraySize || PET_DEFAULT_TRAY_SIZE,
  });
  petAnchor = petLayout.anchor;
  petPlacement = petLayout.placement;
  return petLayout.windowBounds;
}

function persistPetWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !petLayout) return;
  writePetOverlayState({
    bounds: mainWindow.getBounds(),
    anchor: petAnchor,
    mascot: petLayout.mascot,
    placement: petPlacement,
    tray: petLayout.tray,
  });
}

function cancelPetWindowMovePersist() {
  if (petWindowMovePersistTimer != null) {
    clearTimeout(petWindowMovePersistTimer);
    petWindowMovePersistTimer = null;
  }
}

function sendPetLayoutToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed() || !petLayout || !overlayReady) return;
  mainWindow.webContents.send('pet-layout-changed', {
    layout: {
      mascot: petLayout.mascot,
      placement: petLayout.placement,
      tray: petLayout.tray,
      viewport: petLayout.viewport,
    },
  });
}

function setPetWindowBounds(bounds) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!bounds || !Number.isFinite(Number(bounds.x)) || !Number.isFinite(Number(bounds.y))) return;
  applyingPetWindowBounds = true;
  mainWindow.setBounds({
    x: Math.round(Number(bounds.x)),
    y: Math.round(Number(bounds.y)),
    width: Math.round(Number(bounds.width) || PET_WINDOW_WIDTH),
    height: Math.round(Number(bounds.height) || PET_WINDOW_HEIGHT),
  }, false);
  setImmediate(() => {
    applyingPetWindowBounds = false;
  });
}

function applyPetLayout(displayBounds = displayBoundsForPetAnchor(), { persist = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  petAnchor = petAnchor || defaultPetAnchor();
  petLayout = computePetLayout({
    anchor: petAnchor,
    displayBounds,
    mascotSize: petMascotSize,
    previousPlacement: petPlacement,
    traySize: petTraySize || PET_DEFAULT_TRAY_SIZE,
  });
  petAnchor = petLayout.anchor;
  petPlacement = petLayout.placement;
  setPetWindowBounds(petLayout.windowBounds);
  sendPetLayoutToRenderer();
  if (persist) persistPetWindowBounds();
}

function rectEquals(a, b) {
  return !!(
    a &&
    b &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

function expandRect(rect, amount) {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

function pointInRect(point, rect) {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

function displayBoundsForDragPoint(point, previousDisplayBounds) {
  const nearestBounds = screen.getDisplayNearestPoint(point).bounds;
  if (rectEquals(nearestBounds, previousDisplayBounds)) return nearestBounds;
  if (previousDisplayBounds && pointInRect(point, expandRect(previousDisplayBounds, PET_DRAG_DISPLAY_HYSTERESIS))) {
    return previousDisplayBounds;
  }
  return nearestBounds;
}

function cancelPetMomentum() {
  if (petMomentumTimer != null) {
    clearTimeout(petMomentumTimer);
    petMomentumTimer = null;
  }
}

function movePetDragToCurrentCursor() {
  if (!petDragState) return;
  const cursor = screen.getCursorScreenPoint();
  const displayBounds = displayBoundsForDragPoint(cursor, petDragState.displayBounds);
  petDragState.displayBounds = displayBounds;
  petAnchor = {
    ...(petAnchor || defaultPetAnchor()),
    x: cursor.x - petDragState.pointerAnchorX,
    y: cursor.y - petDragState.pointerAnchorY,
  };
  applyPetLayout(displayBounds, { persist: false });
}

function startPetDrag({ pointerWindowX, pointerWindowY } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const x = Number(pointerWindowX);
  const y = Number(pointerWindowY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  cancelPetMomentum();
  const currentLayout = petLayout || computePetLayout({
    anchor: petAnchor || defaultPetAnchor(),
    displayBounds: displayBoundsForPetAnchor(),
    mascotSize: petMascotSize,
    previousPlacement: petPlacement,
    traySize: petTraySize || PET_DEFAULT_TRAY_SIZE,
  });
  petDragState = {
    displayBounds: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds,
    hasMoved: false,
    pointerAnchorX: x - currentLayout.mascot.left,
    pointerAnchorY: y - currentLayout.mascot.top,
  };
}

function movePetDrag() {
  if (!mainWindow || mainWindow.isDestroyed() || !petDragState) return;
  cancelPetMomentum();
  petDragState.hasMoved = true;
  movePetDragToCurrentCursor();
}

function endPetDrag() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (petDragState && petDragState.hasMoved) movePetDragToCurrentCursor();
  petDragState = null;
  applyPetLayout(undefined, { persist: true });
}

function throwPetWithVelocity(velocityX, velocityY) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let vx = Number(velocityX);
  let vy = Number(velocityY);
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || (vx === 0 && vy === 0)) return;
  cancelPetMomentum();
  let elapsed = 0;
  const step = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      cancelPetMomentum();
      return;
    }
    petMomentumTimer = null;
    elapsed += PET_MOMENTUM_INTERVAL_MS;
    const intended = {
      ...(petAnchor || defaultPetAnchor()),
      x: (petAnchor || defaultPetAnchor()).x + (vx * PET_MOMENTUM_INTERVAL_MS) / 1000,
      y: (petAnchor || defaultPetAnchor()).y + (vy * PET_MOMENTUM_INTERVAL_MS) / 1000,
    };
    const displayBounds = screen.getDisplayNearestPoint(pointForRectCenter(intended)).bounds;
    petAnchor = intended;
    applyPetLayout(displayBounds, { persist: false });
    if (petAnchor.x !== Math.round(intended.x)) vx = 0;
    if (petAnchor.y !== Math.round(intended.y)) vy = 0;
    vx *= PET_MOMENTUM_DECAY;
    vy *= PET_MOMENTUM_DECAY;
    if (elapsed >= PET_MOMENTUM_MAX_DURATION_MS || Math.hypot(vx, vy) < PET_MOMENTUM_STOP_SPEED) {
      persistPetWindowBounds();
      return;
    }
    petMomentumTimer = setTimeout(step, PET_MOMENTUM_INTERVAL_MS);
  };
  petMomentumTimer = setTimeout(step, PET_MOMENTUM_INTERVAL_MS);
}

function syncPetAnchorFromWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !petLayout) return;
  const bounds = mainWindow.getBounds();
  petAnchor = {
    ...(petAnchor || defaultPetAnchor()),
    x: bounds.x + petLayout.mascot.left,
    y: bounds.y + petLayout.mascot.top,
    width: petMascotSize.width,
    height: petMascotSize.height,
  };
}

function scheduleMovedPetPersist() {
  if (!mainWindow || mainWindow.isDestroyed() || applyingPetWindowBounds) return;
  cancelPetWindowMovePersist();
  petWindowMovePersistTimer = setTimeout(() => {
    petWindowMovePersistTimer = null;
    syncPetAnchorFromWindowBounds();
    applyPetLayout(displayBoundsForPetAnchor(), { persist: true });
  }, 140);
}

function refreshCursorAtCurrentMousePosition(win) {
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const x = p.x - b.x;
  const y = p.y - b.y;
  if (x < 0 || y < 0 || x > b.width || y > b.height) return;
  win.webContents.sendInputEvent({
    type: 'mouseMove',
    x,
    y,
    movementX: 0,
    movementY: 0,
  });
}

function setPetWindowMouseable(enabled, { refreshCursor = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const next = !!enabled;
  if (mainWindowMouseable === next) {
    if (next && refreshCursor) refreshCursorAtCurrentMousePosition(mainWindow);
    return;
  }
  if (next) {
    mainWindow.setIgnoreMouseEvents(false);
    mainWindowMouseable = true;
    if (refreshCursor) refreshCursorAtCurrentMousePosition(mainWindow);
    return;
  }
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindowMouseable = false;
}

function applyPetMouseInteractivityPolicy() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  setPetWindowMouseable(petPointerInteractive, { refreshCursor: petPointerInteractive });
}

function openPetOverlay({ persist = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  petOverlayOpenRequested = true;
  petPointerInteractive = false;
  applyOverlayWindowPolicy(mainWindow, { level: PET_OVERLAY_WINDOW_LEVEL });
  applyPetLayout(undefined, { persist: false });
  if (!mainWindow.isVisible()) mainWindow.showInactive();
  mainWindow.moveTop();
  if (persist) writePetOverlayState({ open: true });
  rebuildAppMenus();
}

function setPetPointerInteraction(enabled) {
  petPointerInteractive = !!enabled;
  applyPetMouseInteractivityPolicy();
}

function closePetOverlay({ persist = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  petOverlayOpenRequested = false;
  petDragState = null;
  cancelPetMomentum();
  cancelPetWindowMovePersist();
  setPetPointerInteraction(false);
  if (mainWindow.isVisible()) mainWindow.hide();
  if (persist) writePetOverlayState({ open: false });
  rebuildAppMenus();
}

function togglePetOverlay() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    closePetOverlay({ persist: true });
  } else {
    openPetOverlay({ persist: true });
  }
}

function createWindow() {
  const saved = readPetOverlayState();
  petOverlayOpenRequested = saved.open === true;
  selectedPetCharacterId = normalizePetCharacterId(saved.petCharacter);
  const { x, y, width, height } = initialPetWindowBounds();

  mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    ...macPanelWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  applyTrustedWebContentsPolicy(mainWindow);
  applyOverlayWindowPolicy(mainWindow, { level: PET_OVERLAY_WINDOW_LEVEL });

  mainWindow.on('show', () => rebuildAppMenus());
  mainWindow.on('hide', () => rebuildAppMenus());
  mainWindow.on('move', scheduleMovedPetPersist);
  mainWindow.webContents.on('did-start-loading', () => {
    overlayReady = false;
  });
  mainWindowMouseable = false;
  petPointerInteractive = false;

  mainWindow.once('ready-to-show', () => {
    if (petOverlayOpenRequested) openPetOverlay({ persist: false });
  });

  const rendererDevBase = trustedRendererDevBaseUrl();
  if (rendererDevBase) {
    mainWindow.loadURL(rendererDevBase);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function ensureOverlayVisibleForSpawn() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  openPetOverlay({ persist: true });
}

function flushPendingSpawnCats() {
  if (!mainWindow || mainWindow.isDestroyed() || !overlayReady) return;
  ensureOverlayVisibleForSpawn();
  applyPetLayout(undefined, { persist: false });
  while (pendingSpawnCats.length > 0) {
    mainWindow.webContents.send('spawn-cat', pendingSpawnCats.shift());
  }
}

function sendSpawnCatToOverlay(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  ensureOverlayVisibleForSpawn();
  if (!overlayReady) {
    pendingSpawnCats.push(payload);
    return;
  }
  mainWindow.webContents.send('spawn-cat', payload);
}

function conversationSpawnPayload(catId) {
  const id = normalizeCatId(catId);
  if (!id) return null;
  const rec = listAgentConversations().find((item) => String(item.catId) === id);
  if (!rec) return null;
  return {
    catId: id,
    prompt: rec.prompt || '',
    runtime: rec.runtime || 'local',
    status: rec.runStatus || 'running',
  };
}

function sendConversationToOverlay(catId) {
  const payload = conversationSpawnPayload(catId);
  if (payload) sendSpawnCatToOverlay(payload);
}

function closeWindowOnEscape(win, closeFn) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    event.preventDefault();
    closeFn();
  });
}

function focusExistingSessionWindow(reason) {
  if (isLiveWindow(modalWindow)) {
    focusWindow(modalWindow);
    recordTrace('session_window_open_blocked', { reason, surface: 'modal' });
    return true;
  }
  if (isLiveWindow(conversationWindow)) {
    focusWindow(conversationWindow);
    recordTrace('session_window_open_blocked', {
      catId: activeConversationCatId || null,
      reason,
      surface: 'conversation',
    });
    return true;
  }
  return false;
}

function openNewCatModal(modalContextId, inputMode = selectedInputMode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const normalizedInputMode = normalizeInputMode(inputMode);
  recordTrace('modal_show_requested', { modalContextId: modalContextId || null, inputMode: normalizedInputMode });

  if (focusExistingSessionWindow('new_session_requested')) return null;

  const modalBounds = centeredWindowBounds(680, 240, launchDisplayForModal(modalContextId));

  const win = new BrowserWindow({
    width: modalBounds.width,
    height: modalBounds.height,
    x: modalBounds.x,
    y: modalBounds.y,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    ...macPanelWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  modalWindow = win;
  applyTrustedWebContentsPolicy(win);
  applyOverlayWindowPolicy(win, { level: FOCUSED_OVERLAY_WINDOW_LEVEL });

  closeWindowOnEscape(win, () => {
    if (isCurrentWindow(win, () => modalWindow)) {
      win.close();
    }
  });

  win.webContents.once('did-finish-load', () => {
    if (!isCurrentWindow(win, () => modalWindow)) return;
    recordTrace('modal_dom_loaded', { modalContextId: modalContextId || null, inputMode: normalizedInputMode });
  });

  win.once('ready-to-show', () => {
    runForCurrentWindow(win, () => modalWindow, (currentWindow) => {
      currentWindow.show();
      currentWindow.moveTop();
      currentWindow.focus();
      currentWindow.webContents.focus();
      recordTrace('modal_shown_and_focused', {
        modalContextId: modalContextId || null,
        bounds: currentWindow.getBounds(),
      });
    });
  });

  win.on('closed', () => {
    modalContexts.delete(modalContextId);
    if (activeModalContextId === modalContextId) {
      activeModalContextId = null;
    }
    clearCurrentWindow(win, () => modalWindow, (next) => {
      modalWindow = next;
    });
  });

  const rendererDevBase = trustedRendererDevBaseUrl();
  if (rendererDevBase) {
    const base = rendererDevBase;
    win.loadURL(`${base}/modal.html?${new URLSearchParams({
      modalContextId: modalContextId || '',
      inputMode: normalizedInputMode,
    }).toString()}`);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/modal.html'), {
      query: { modalContextId: modalContextId || '', inputMode: normalizedInputMode },
    });
  }
  return win;
}

function showConversationWindow(win) {
  focusWindow(win);
}

function openConversationWindow(catId) {
  if (!mainWindow || mainWindow.isDestroyed() || !catId) return;

  const q = { catId: String(catId) };
  if (focusExistingSessionWindow('conversation_requested')) {
    return;
  }

  const conversationBounds = centeredWindowBounds(
    CONVERSATION_WINDOW_SIDE,
    CONVERSATION_WINDOW_SIDE,
    displayForPetOrCursor()
  );

  const win = new BrowserWindow({
    width: conversationBounds.width,
    height: conversationBounds.height,
    x: conversationBounds.x,
    y: conversationBounds.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    ...macPanelWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  conversationWindow = win;
  activeConversationCatId = q.catId;
  applyTrustedWebContentsPolicy(win);
  applyOverlayWindowPolicy(win, { level: FOCUSED_OVERLAY_WINDOW_LEVEL });

  closeWindowOnEscape(win, () => {
    if (isCurrentWindow(win, () => conversationWindow)) {
      win.close();
    }
  });

  win.once('ready-to-show', () => {
    runForCurrentWindow(win, () => conversationWindow, showConversationWindow);
  });

  win.on('closed', () => {
    const cleared = clearCurrentWindow(win, () => conversationWindow, (next) => {
      conversationWindow = next;
    });
    if (cleared) activeConversationCatId = null;
  });

  const rendererDevBase = trustedRendererDevBaseUrl();
  if (rendererDevBase) {
    const base = rendererDevBase;
    void win.loadURL(
      `${base}/conversation.html?${new URLSearchParams(q).toString()}`
    );
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/conversation.html'), {
      query: q,
    });
  }
}

function displayForAuthWindow(pendingRun = null) {
  const launchContext = pendingRun && pendingRun.launchContext ? pendingRun.launchContext : null;
  if (launchContext && launchContext.display) return launchContext.display;
  if (launchContext && launchContext.cursor) return screen.getDisplayNearestPoint(launchContext.cursor);
  return displayForPetOrCursor();
}

function openHermesAuthWindow({ pendingRun = null, reason = '' } = {}) {
  if (pendingRun) pendingAuthRun = pendingRun;
  if (authWindow && !authWindow.isDestroyed()) {
    authFlow.hidden = false;
    focusWindow(authWindow);
    sendHermesAuthContext(reason);
    return authWindow;
  }

  const bounds = centeredWindowBounds(640, 560, displayForAuthWindow(pendingRun));
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    ...macPanelWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  authWindow = win;
  applyTrustedWebContentsPolicy(win);
  applyOverlayWindowPolicy(win, { level: FOCUSED_OVERLAY_WINDOW_LEVEL });

  closeWindowOnEscape(win, () => {
    if (isCurrentWindow(win, () => authWindow)) {
      dismissHermesAuthWindow();
    }
  });

  win.webContents.once('did-finish-load', () => {
    if (isCurrentWindow(win, () => authWindow)) sendHermesAuthContext(reason);
  });

  win.once('ready-to-show', () => {
    runForCurrentWindow(win, () => authWindow, (currentWindow) => {
      currentWindow.show();
      currentWindow.moveTop();
      currentWindow.focus();
      currentWindow.webContents.focus();
    });
  });

  win.on('closed', () => {
    clearCurrentWindow(win, () => authWindow, (next) => {
      authWindow = next;
    });
  });

  const query = {
    pending: pendingAuthRun ? '1' : '',
    reason: String(reason || ''),
  };
  const rendererDevBase = trustedRendererDevBaseUrl();
  if (rendererDevBase) {
    const base = rendererDevBase;
    void win.loadURL(`${base}/auth.html?${new URLSearchParams(query).toString()}`);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/auth.html'), { query });
  }
  return win;
}

function closeHermesAuthWindow() {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.close();
  }
}

function setCatsVisible(visible) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (visible) {
    openPetOverlay({ persist: true });
  } else {
    closePetOverlay({ persist: true });
  }
  rebuildAppMenus();
}

function hermesLoginMenuItem() {
  return {
    label: authFlowIsRecoverable() ? 'Return to Hermes Sign-In...' : 'Hermes Login...',
    click: () => {
      openHermesAuthWindow({ reason: 'menu' });
    },
  };
}

function petCharacterMenuItem() {
  return {
    label: 'Pet Character',
    submenu: petCharacterOptions.length === 0 ? [{
      label: 'No Codex pets found',
      enabled: false,
    }] : petCharacterOptions.map((pet) => ({
      label: pet.label,
      type: 'radio',
      checked: selectedPetCharacterId === pet.id,
      click: () => setSelectedPetCharacter(pet.id),
    })),
  };
}

function refreshPetMenuItem() {
  return {
    label: 'Refresh Pets',
    click: () => refreshPetCharacterOptions({ notify: true }),
  };
}

function openPetFolderMenuItem() {
  return {
    label: 'Open Pet Folder',
    click: () => {
      void shell.openPath(primaryCodexPetsDir());
    },
  };
}

function inputModeMenuItem() {
  return {
    label: 'Input Mode',
    submenu: [
      {
        label: 'Text',
        type: 'radio',
        checked: selectedInputMode === INPUT_MODE_TEXT,
        click: () => setSelectedInputMode(INPUT_MODE_TEXT),
      },
      {
        label: 'Voice',
        type: 'radio',
        checked: selectedInputMode === INPUT_MODE_VOICE,
        click: () => setSelectedInputMode(INPUT_MODE_VOICE),
      },
    ],
  };
}

function settingsMenuItem() {
  return {
    label: 'Settings',
    submenu: [
      hermesLoginMenuItem(),
      { type: 'separator' },
      inputModeMenuItem(),
    ],
  };
}

function buildAppMenu() {
  const catsVisible = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const accelerator = process.platform === 'darwin' ? 'Command+Shift+C' : 'Control+Shift+C';
  const newSessionLabel = selectedInputMode === INPUT_MODE_VOICE ? 'Start Voice Session' : 'New Text Session';
  return Menu.buildFromTemplate([
    {
      label: newSessionLabel,
      accelerator,
      click: () => {
        void handleNewCatShortcut('menu');
      },
    },
    { type: 'separator' },
    settingsMenuItem(),
    { type: 'separator' },
    {
      label: catsVisible ? 'Close Pet' : 'Wake Pet',
      click: () => {
        setCatsVisible(!catsVisible);
      },
    },
    petCharacterMenuItem(),
    refreshPetMenuItem(),
    openPetFolderMenuItem(),
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);
}

function buildApplicationMenu() {
  const catsVisible = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const accelerator = process.platform === 'darwin' ? 'Command+Shift+C' : 'Control+Shift+C';
  const newSessionLabel = selectedInputMode === INPUT_MODE_VOICE ? 'Start Voice Session' : 'New Text Session';
  return Menu.buildFromTemplate([
    {
      label: 'agent-UI',
      submenu: [
        {
          label: newSessionLabel,
          accelerator,
          click: () => {
            void handleNewCatShortcut('menu');
          },
        },
        { type: 'separator' },
        settingsMenuItem(),
        { type: 'separator' },
        {
          label: catsVisible ? 'Close Pet' : 'Wake Pet',
          click: () => {
            setCatsVisible(!catsVisible);
          },
        },
        petCharacterMenuItem(),
        refreshPetMenuItem(),
        openPetFolderMenuItem(),
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Command+Q' : 'Control+Q',
          click: () => app.quit(),
        },
      ],
    },
  ]);
}

function rebuildAppMenus() {
  const menu = buildAppMenu();
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(menu);
  }
  Menu.setApplicationMenu(buildApplicationMenu());
}

function createTray() {
  const iconPng = path.join(getPackageRoot(), 'assets', 'icon.png');
  const source = nativeImage.createFromPath(iconPng);
  const image = source.isEmpty() ? source : source.resize({ width: 22, height: 22, quality: 'best' });
  if (process.platform === 'darwin' && !image.isEmpty()) {
    image.setTemplateImage(true);
  }
  tray = new Tray(image);
  if (process.platform === 'darwin') {
    updateTrayTitle();
  }
  tray.setToolTip('agent-UI');
  rebuildAppMenus();
}

function updateTrayTitle() {
  if (!tray || tray.isDestroyed() || process.platform !== 'darwin') return;
  const active = Number.isFinite(catCounts.active) ? catCounts.active : 0;
  const review = Number.isFinite(catCounts.inReview) ? catCounts.inReview : 0;
  let title;
  if (active > 0 && review > 0) {
    title = `${active}·${review}`;
  } else if (active > 0) {
    title = String(active);
  } else if (review > 0) {
    title = `·${review}`;
  } else {
    title = '';
  }
  tray.setTitle(title);
}

function boundsPayload(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x: Math.trunc(x),
    y: Math.trunc(y),
    width: Math.trunc(width),
    height: Math.trunc(height),
  };
}

function displayPayload(display) {
  if (!display || typeof display !== 'object') return null;
  return {
    id: display.id,
    bounds: boundsPayload(display.bounds),
    workArea: boundsPayload(display.workArea),
    scaleFactor: Number(display.scaleFactor) || 1,
    rotation: Number(display.rotation) || 0,
  };
}

function isBrowserLikeWindow(win) {
  const owner = win && win.owner ? win.owner : {};
  const haystack = [
    owner.name,
    owner.bundleId,
    owner.path,
    win && win.url ? 'url' : '',
  ].filter(Boolean).join(' ').toLowerCase();
  return ['safari', 'firefox', 'chrome', 'chromium', 'arc', 'brave', 'edge', 'opera', 'vivaldi']
    .some((marker) => haystack.includes(marker));
}

function screenContextHintForWindow(win) {
  const owner = win && win.owner ? win.owner : {};
  const appName = String(owner.name || '').trim();
  const title = String((win && win.title) || '').trim();
  if (appName && title) return `Visible window: ${appName} - ${title.slice(0, 180)}`;
  if (appName) return `Visible app: ${appName}`;
  return '';
}

function screenContextHintForContext(activeWindow, frontmostApp) {
  const windowHint = screenContextHintForWindow(activeWindow);
  if (windowHint) return windowHint;
  const appName = String((frontmostApp && frontmostApp.name) || '').trim();
  return appName ? `Visible app: ${appName}` : '';
}

function contextQuality(activeWindow, frontmostApp, display, cursor) {
  const app = activeWindow && activeWindow.owner ? activeWindow.owner : frontmostApp;
  if (
    activeWindow &&
    app &&
    app.name &&
    app.processId &&
    activeWindow.title &&
    activeWindow.bounds &&
    display &&
    cursor
  ) {
    return 'full';
  }
  if ((app && app.name) || display) return 'partial';
  return 'minimal';
}

function missingContextFields(activeWindow, frontmostApp, display, cursor) {
  const owner = activeWindow && activeWindow.owner ? activeWindow.owner : (frontmostApp || {});
  const missing = [];
  if (!activeWindow) missing.push('active_window');
  if (!owner.name) missing.push('active_app');
  if (!owner.bundleId) missing.push('bundle_id');
  if (!owner.processId) missing.push('pid');
  if (!activeWindow || !activeWindow.title) missing.push('top_window_title');
  if (!activeWindow || !activeWindow.bounds) missing.push('top_window_bounds');
  if (!cursor) missing.push('cursor');
  if (!display) missing.push('display');
  return missing;
}

function normalizeActiveWindow(win) {
  if (!win) return null;
  return {
    id: win.id || null,
    title: win.title || '',
    bounds: boundsPayload(win.bounds),
    owner: win.owner ? {
      name: win.owner.name || '',
      processId: win.owner.processId || null,
      bundleId: win.owner.bundleId || '',
      path: win.owner.path || '',
    } : null,
    url: win.url || '',
  };
}

function isOwnActiveWindow(win) {
  const owner = win && win.owner ? win.owner : {};
  return Number(owner.processId) === Number(process.pid);
}

function usableRecentExternalWindow(maxAgeMs = 30000) {
  if (!lastExternalWindowSnapshot) return null;
  if (Date.now() - Number(lastExternalWindowSnapshot.capturedAt || 0) > maxAgeMs) return null;
  return lastExternalWindowSnapshot.window || null;
}

function frontmostAppFromAppleScriptOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim());
  const [name, bundleId, pid] = lines;
  if (!name) return null;
  return {
    name,
    bundleId: bundleId || '',
    processId: safeInteger(pid),
    path: '',
  };
}

async function frontmostAppWithTimeout(timeoutMs = 600) {
  if (process.platform !== 'darwin') return null;
  const script = [
    'tell application "System Events"',
    'set p to first application process whose frontmost is true',
    'return (name of p) & "\\n" & (bundle identifier of p) & "\\n" & ((unix id of p) as text)',
    'end tell',
  ].join('\n');
  const lookup = execFileText('osascript', ['-e', script], { timeout: timeoutMs })
    .then(frontmostAppFromAppleScriptOutput)
    .catch(() => null);
  return Promise.race([
    lookup,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function readActiveWindowSnapshot() {
  const { activeWindow } = await loadGetWindowsModule();
  const win = await activeWindow({
    accessibilityPermission: false,
    screenRecordingPermission: false,
  });
  const snapshot = normalizeActiveWindow(win);
  if (snapshot && !isOwnActiveWindow(snapshot)) {
    lastExternalWindowSnapshot = { capturedAt: Date.now(), window: snapshot };
  }
  return snapshot;
}

function stopActiveWindowTracker() {
  if (activeWindowCacheTimer != null) {
    clearInterval(activeWindowCacheTimer);
    activeWindowCacheTimer = null;
  }
  if (activeWindowCacheStopTimer != null) {
    clearTimeout(activeWindowCacheStopTimer);
    activeWindowCacheStopTimer = null;
  }
}

function startActiveWindowTracker({
  durationMs = ACTIVE_WINDOW_CACHE_DURATION_MS,
  intervalMs = ACTIVE_WINDOW_CACHE_INTERVAL_MS,
} = {}) {
  const tick = () => {
    void readActiveWindowSnapshot().catch(() => {
      // Context capture is best-effort and must not affect the launcher.
    });
  };
  tick();
  if (activeWindowCacheTimer == null) {
    activeWindowCacheTimer = setInterval(tick, intervalMs);
  }
  if (activeWindowCacheStopTimer != null) {
    clearTimeout(activeWindowCacheStopTimer);
  }
  activeWindowCacheStopTimer = setTimeout(stopActiveWindowTracker, Math.max(1000, Number(durationMs) || ACTIVE_WINDOW_CACHE_DURATION_MS));
}

async function activeWindowWithTimeout(timeoutMs = 1200) {
  const lookup = (async () => {
    try {
      const snapshot = await readActiveWindowSnapshot();
      if (snapshot && !isOwnActiveWindow(snapshot)) return snapshot;
      return usableRecentExternalWindow();
    } catch {
      return usableRecentExternalWindow();
    }
  })();
  return Promise.race([
    lookup,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function captureLaunchContext(source, modalContextId) {
  const capturedAt = new Date().toISOString();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const activeWindow = await activeWindowWithTimeout();
  const frontmostApp = activeWindow && activeWindow.owner ? null : await frontmostAppWithTimeout();
  const displayInfo = displayPayload(display);
  const cursorInfo = cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)
    ? { x: Math.trunc(cursor.x), y: Math.trunc(cursor.y) }
    : null;
  const missingContext = missingContextFields(activeWindow, frontmostApp, displayInfo, cursorInfo);
  return {
    schemaVersion: 1,
    source,
    modalContextId,
    capturedAt,
    platform: process.platform,
    cursor: cursorInfo,
    display: displayInfo,
    activeWindow,
    frontmostApp,
    topWindowIsBrowserLike: isBrowserLikeWindow(activeWindow),
    screenContextHint: screenContextHintForContext(activeWindow, frontmostApp),
    contextQuality: contextQuality(activeWindow, frontmostApp, displayInfo, cursorInfo),
    missingContext,
  };
}

async function handleNewCatShortcut(source = 'shortcut') {
  if (focusExistingSessionWindow('new_session_shortcut')) return;
  const modalContextId = randomUUID();
  activeModalContextId = modalContextId;
  const inputMode = selectedInputMode;
  const launchContext = await captureLaunchContext(source, modalContextId);
  startActiveWindowTracker();
  modalContexts.set(modalContextId, launchContext);
  recordTrace('shortcut_received', {
    source,
    modalContextId,
    contextQuality: launchContext.contextQuality,
    missingContext: launchContext.missingContext,
    screenContextHint: launchContext.screenContextHint || null,
    inputMode,
  });
  const newModalWindow = openNewCatModal(modalContextId, inputMode);
  if (!newModalWindow) {
    modalContexts.delete(modalContextId);
    if (activeModalContextId === modalContextId) activeModalContextId = null;
    return;
  }
  if (inputMode === INPUT_MODE_VOICE && newModalWindow && !newModalWindow.isDestroyed()) {
    newModalWindow.webContents.once('did-finish-load', () => {
      if (newModalWindow.isDestroyed()) return;
      void startVoiceSessionFromShortcut(newModalWindow, modalContextId);
    });
  }
}

trustedIpcOn('overlay-ready', () => {
  overlayReady = true;
  sendPetCharacterToRenderer();
  flushPendingSpawnCats();
});

function getAgentUIConfigDir() {
  const configured = String(process.env.AGENT_UI_CONFIG_DIR || '').trim();
  let userHome = '';
  try {
    userHome = os.userInfo().homedir;
  } catch {
    userHome = '';
  }
  const dir = configured ? path.resolve(configured) : path.join(userHome || os.homedir(), '.agent-ui');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function startCatRunFromPayload(payload = {}, opts = {}) {
  const catId = opts.catId ? normalizeCatId(opts.catId) : randomUUID();
  const modalContextId =
    normalizeCatId(opts.modalContextId) ||
    normalizeCatId(payload && payload.modalContextId) ||
    activeModalContextId ||
    '';
  const runtime = 'local';
  const prompt = boundedText(payload && payload.prompt);
  if (!catId) {
    return { ok: false, error: 'Invalid session id.' };
  }
  const launchContext = modalContextId ? (modalContexts.get(modalContextId) || null) : null;
  if (!prompt.trim()) {
    const error = 'Missing task prompt.';
    recordTrace('submit_rejected', {
      catId,
      modalContextId: modalContextId || null,
      reason: 'missing_prompt',
    });
    return { ok: false, error };
  }
  recordTrace('submit_context_ready', {
    catId,
    modalContextId: modalContextId || null,
    contextQuality: launchContext ? launchContext.contextQuality : 'missing',
    missingContext: launchContext ? launchContext.missingContext : ['launch_context'],
  });
  recordTrace('submit_requested', {
    catId,
    modalContextId: modalContextId || null,
    promptLength: prompt.length,
    runtime,
    contextQuality: launchContext ? launchContext.contextQuality : 'missing',
  });

  const prepared = { catId, prompt, runtime, modalContextId, launchContext };
  launchPreparedCatRun(prepared, { closeModal: opts.closeModal !== false });
  return { ok: true, catId, runtime };
}

function launchPreparedCatRun(prepared = {}, opts = {}) {
  const catId = normalizeCatId(prepared.catId) || randomUUID();
  const prompt = boundedText(prepared.prompt);
  const runtime = 'local';
  const modalContextId = normalizeCatId(prepared.modalContextId);
  const launchContext = prepared.launchContext || null;
  const out = { catId, prompt, runtime, modalContextId };
  if (modalContextId) modalContexts.delete(modalContextId);
  if (activeModalContextId === modalContextId) activeModalContextId = null;
  if (opts.closeModal !== false && modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }
  sendSpawnCatToOverlay(out);
  recordTrace('cat_spawn_sent', { catId, modalContextId: modalContextId || null, runtime });
  startAgentForCat(
    {
      catId,
      prompt,
      runtime,
      pointerContext: launchContext,
    },
    { getMainWindow: () => mainWindow, log: console }
  );
}

trustedIpcOn('new-cat-submit', (_event, payload) => {
  void startCatRunFromPayload(payload, { closeModal: true });
});

trustedIpcOn('new-cat-cancel', () => {
  if (modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }
});

trustedIpcOn('cat-counts', (_event, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const active = Number(payload.active);
  const inReview = Number(payload.inReview);
  if (!Number.isFinite(active) || !Number.isFinite(inReview)) return;
  catCounts = {
    active: Math.min(1000, Math.max(0, Math.floor(active))),
    inReview: Math.min(1000, Math.max(0, Math.floor(inReview))),
  };
  rebuildAppMenus();
  updateTrayTitle();
});

trustedIpcOn('pet-overlay-toggle', () => {
  togglePetOverlay();
});

trustedIpcHandle('get-pet-characters', () => {
  return petCharactersPayload();
});

trustedIpcOn('pet-characters-refresh', () => {
  refreshPetCharacterOptions({ notify: true });
});

trustedIpcOn('pet-context-menu', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  Menu.buildFromTemplate([
    {
      label: 'Close pet',
      click: () => closePetOverlay({ persist: true }),
    },
    { type: 'separator' },
    settingsMenuItem(),
    { type: 'separator' },
    petCharacterMenuItem(),
    refreshPetMenuItem(),
    openPetFolderMenuItem(),
  ]).popup({ window: mainWindow });
});

trustedIpcOn('pet-pointer-interaction-changed', (_event, payload = {}) => {
  setPetPointerInteraction(!!payload.active);
});

trustedIpcOn('pet-drag-start', (_event, payload = {}) => {
  const safePayload = normalizedDragStartPayload(payload);
  if (safePayload) startPetDrag(safePayload);
});

trustedIpcOn('pet-drag-move', () => {
  movePetDrag();
});

trustedIpcOn('pet-drag-end', () => {
  endPetDrag();
});

trustedIpcOn('pet-drag-release', (_event, payload = {}) => {
  const safePayload = normalizedDragReleasePayload(payload);
  if (safePayload) throwPetWithVelocity(safePayload.velocityX, safePayload.velocityY);
});

trustedIpcOn('pet-element-size-changed', (_event, payload = {}) => {
  if (!payload || typeof payload !== 'object') return;
  cancelPetMomentum();
  const mascot = payload.mascot && typeof payload.mascot === 'object' ? payload.mascot : null;
  const trayPayload = payload.tray && typeof payload.tray === 'object' ? payload.tray : null;
  const mascotWidth = mascot ? normalizedSize(mascot.width) : null;
  const mascotHeight = mascot ? normalizedSize(mascot.height) : null;
  if (mascotWidth != null && mascotHeight != null) {
    petMascotSize = { width: mascotWidth, height: mascotHeight };
    petAnchor = { ...(petAnchor || defaultPetAnchor()), width: petMascotSize.width, height: petMascotSize.height };
  }
  const trayWidth = trayPayload ? normalizedSize(trayPayload.width) : null;
  const trayHeight = trayPayload ? normalizedSize(trayPayload.height) : null;
  petTraySize = trayWidth != null && trayHeight != null
    ? { width: trayWidth, height: trayHeight }
    : null;
  applyPetLayout(undefined, { persist: false });
});

trustedIpcOn('open-cat-conversation', (_e, { catId } = {}) => {
  const id = normalizeCatId(catId);
  if (!id) return;
  openConversationWindow(id);
});

trustedIpcOn('close-conversation-window', () => {
  if (conversationWindow && !conversationWindow.isDestroyed()) {
    conversationWindow.close();
  }
});

trustedIpcOn('dismiss-cat', async (_e, { catId } = {}) => {
  const id = normalizeCatId(catId);
  if (!id) return;
  const result = await dismissAgent(id, { getMainWindow: () => mainWindow, log: console });
  if (!result || result.ok === false) return;
  if (conversationWindow && !conversationWindow.isDestroyed()) {
    conversationWindow.close();
  }
});

trustedIpcHandle('agent-followup', (_e, { catId, text } = {}) => {
  const id = normalizeCatId(catId);
  if (!id) return { ok: false, error: 'Missing session id.' };
  return sendFollowup(id, boundedText(text), { getMainWindow: () => mainWindow, log: console });
});

trustedIpcHandle('agent-cancel', (_e, { catId } = {}) => {
  const id = normalizeCatId(catId);
  if (!id) return { ok: false, error: 'Missing session id.' };
  return cancelAgent(id, { getMainWindow: () => mainWindow, log: console });
});

trustedIpcHandle('open-agent-attachment', async (_e, { url } = {}) => {
  const value = boundedText(url, 4096).trim();
  if (!value) return { ok: false, error: 'Missing attachment URL.' };
  try {
    const parsed = new URL(value);
    if (parsed.protocol === `${ATTACHMENT_SCHEME}:`) {
      const resolved = hermesAttachments.resolveAttachmentRequest(value);
      if (!resolved || !resolved.file) return { ok: false, error: 'Attachment is unavailable.' };
      const error = await shell.openPath(resolved.file);
      return error ? { ok: false, error } : { ok: true };
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      await shell.openExternal(parsed.toString());
      return { ok: true };
    }
  } catch {
    return { ok: false, error: 'Attachment is unavailable.' };
  }
  return { ok: false, error: 'Unsupported attachment URL.' };
});

trustedIpcHandle('open-external-url', async (_e, { url } = {}) => {
  const value = boundedText(url, 4096).trim();
  if (!value) return { ok: false, error: 'Missing URL.' };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'Unsupported URL.' };
    }
    await shell.openExternal(parsed.toString());
    return { ok: true };
  } catch {
    return { ok: false, error: 'Unsupported URL.' };
  }
});

trustedIpcHandle('clipboard-write-text', (_e, { text } = {}) => {
  const value = boundedText(text, 20000);
  if (!value) return { ok: false, error: 'Missing text.' };
  clipboard.writeText(value);
  return { ok: true };
});

trustedIpcHandle('get-agent-conversation', (_e, catId) => {
  const id = normalizeCatId(catId);
  return id ? getAgentConversation(id) : { found: false, items: [] };
});

trustedIpcHandle('hermes-auth-status', async () => {
  try {
    return await hermesAuth.getAuthStatus();
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

trustedIpcHandle('hermes-auth-add-api-key', async (_e, payload = {}) => {
  return hermesAuth.addApiKeyCredential(payload);
});

trustedIpcHandle('hermes-auth-save-model', async (_e, payload = {}) => {
  return hermesAuth.saveModelSelection(payload);
});

trustedIpcHandle('hermes-auth-oauth-start', (_e, payload = {}) => {
  return startHermesOAuthFlow(payload);
});

trustedIpcHandle('hermes-auth-oauth-input', (_e, payload = {}) => {
  return hermesAuth.sendOAuthInput(payload);
});

trustedIpcHandle('hermes-auth-oauth-cancel', (_e, payload = {}) => {
  return cancelHermesOAuthFlow(payload, { clearPending: true });
});

trustedIpcHandle('hermes-auth-check-now', async () => {
  return await checkHermesAuthFlow('check-now');
});

trustedIpcHandle('hermes-auth-finish', () => {
  const pending = pendingAuthRun;
  resetAuthFlow({ clearPending: true });
  closeHermesAuthWindow();
  if (pending) {
    launchPreparedCatRun(pending, { closeModal: false });
    return { ok: true, started: true, catId: pending.catId || null };
  }
  return { ok: true, started: false };
});

trustedIpcOn('hermes-auth-close', () => {
  closeHermesAuthWindow();
});

trustedIpcHandle('hermes-auth-dismiss', () => {
  return dismissHermesAuthWindow();
});

trustedIpcOn('hermes-auth-open', () => {
  openHermesAuthWindow({ reason: 'renderer' });
});

function evalWindowState(win) {
  return {
    visible: !!(win && !win.isDestroyed() && win.isVisible()),
    bounds: win && !win.isDestroyed() ? win.getBounds() : null,
    osProcessId: win && !win.isDestroyed() ? win.webContents.getOSProcessId() : null,
  };
}

async function getEvalUiTargets() {
  const modal = evalUiSnapshots.get('modal') || {};
  const conversation = evalUiSnapshots.get('conversation') || {};
  const overlay = evalUiSnapshots.get('overlay') || {};
  return {
    ok: true,
    modal: {
      modalContextId: activeModalContextId,
      ...evalWindowState(modalWindow),
      ...modal,
    },
    conversation: {
      ...evalWindowState(conversationWindow),
      ...conversation,
    },
    overlay: {
      ...evalWindowState(mainWindow),
      ...overlay,
    },
    cats: Array.isArray(overlay.cats) ? overlay.cats.slice() : [],
    configDir: getAgentUIConfigDir(),
    trace: {
      enabled: evalTraceEnabled,
      runId: evalRunId,
      runDir: evalRunDir,
    },
  };
}

async function closeEvalModal() {
  if (modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }
  recordTrace('cleanup_modal_closed', { ok: true });
  return { ok: true };
}

async function waitForEvalCat({ catId, timeoutMs = 180000 } = {}) {
  const started = Date.now();
  const id = catId ? String(catId) : '';
  while (Date.now() - started <= Number(timeoutMs || 180000)) {
    const conversations = listAgentConversations();
    const rec = id
      ? conversations.find((c) => String(c.catId) === id)
      : conversations.find((c) => ['completed', 'error', 'cancelled'].includes(String(c.runStatus || '').toLowerCase()));
    if (rec) {
      const status = String(rec.runStatus || '').toLowerCase();
      if (['completed', 'error', 'cancelled'].includes(status)) {
        return {
          ok: true,
          catId: rec.catId,
          status,
          conversation: getAgentConversation(rec.catId),
          artifacts: getAgentArtifacts(rec.catId),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, error: 'timeout', catId: id || null };
}

async function readDeterministicTranscript() {
  const direct = String(process.env.AGENT_UI_EVAL_TRANSCRIPT || '').trim();
  if (direct) return direct;
  const file = String(process.env.AGENT_UI_EVAL_TRANSCRIPT_FILE || '').trim();
  if (file && fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8').trim();
  }
  return '';
}

function textTraceMeta(value, maxPreview = 80) {
  const text = String(value || '');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return {
    chars: text.length,
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
    preview: normalized.length > maxPreview ? `${normalized.slice(0, maxPreview - 1)}...` : normalized,
  };
}

async function captureVoicePromptTranscript(onStatus) {
  recordTrace('voice_started', {});
  if (process.env.AGENT_UI_EVAL === '1') {
    const transcript = await readDeterministicTranscript();
    if (!transcript) {
      recordTrace('voice_final_transcript', { deterministic: true, ...textTraceMeta('') });
      return { ok: false, error: 'missing deterministic transcript' };
    }
    recordTrace('voice_partial_transcript', { deterministic: true, ...textTraceMeta(transcript.slice(0, 80)) });
    recordTrace('voice_final_transcript', { deterministic: true, ...textTraceMeta(transcript) });
    return { ok: true, deterministic: true, transcript };
  }
  const result = await captureAndTranscribeVoice({ onStatus });
  if (result.ok) {
    recordTrace('voice_final_transcript', { deterministic: false, ...textTraceMeta(result.transcript) });
  }
  return result;
}

function sendVoiceInputStatus(win, modalContextId, payload = {}) {
  const state = String(payload.state || '').trim();
  if (!state || !isCurrentWindow(win, () => modalWindow)) return;
  win.webContents.send('voice-input-status', {
    modalContextId: modalContextId || null,
    state,
    transcript: boundedText(payload.transcript || ''),
    error: boundedText(payload.error || ''),
    provider: payload.provider ? String(payload.provider).slice(0, 128) : '',
  });
}

async function startVoiceSessionFromShortcut(win, modalContextId) {
  if (!isCurrentWindow(win, () => modalWindow)) return;
  recordTrace('voice_session_recording_requested', { modalContextId: modalContextId || null });
  sendVoiceInputStatus(win, modalContextId, { state: 'recording' });
  const result = await captureVoicePromptTranscript((state) => {
    sendVoiceInputStatus(win, modalContextId, { state });
  });
  if (!isCurrentWindow(win, () => modalWindow)) return;
  if (!result || !result.ok) {
    const error = (result && result.error) || 'Could not capture voice input.';
    recordTrace('voice_session_rejected', { modalContextId: modalContextId || null, error });
    sendVoiceInputStatus(win, modalContextId, { state: 'error', error });
    return;
  }
  const prompt = String(result.transcript || '').trim();
  if (!prompt) {
    const error = 'Voice input produced no transcript.';
    recordTrace('voice_session_rejected', { modalContextId: modalContextId || null, error });
    sendVoiceInputStatus(win, modalContextId, { state: 'error', error });
    return;
  }
  recordTrace('voice_session_transcript_ready', {
    modalContextId: modalContextId || null,
    deterministic: !!result.deterministic,
    ...textTraceMeta(prompt),
  });
  sendVoiceInputStatus(win, modalContextId, {
    state: 'transcript_ready',
    transcript: prompt,
    provider: result.provider || '',
  });
}

trustedIpcOn('eval-trace-event', (_event, payload = {}) => {
  if (!evalPayloadWithinLimit(payload)) return;
  const type = payload && payload.type ? payload.type : 'renderer_event';
  const { type: _type, ...rest } = payload && typeof payload === 'object' ? payload : {};
  recordTrace(type, rest);
});

trustedIpcOn('eval-ui-state', (_event, payload = {}) => {
  if (!evalTraceEnabled || !payload || typeof payload !== 'object') return;
  if (!evalPayloadWithinLimit(payload)) return;
  const surface = String(payload.surface || '').trim();
  if (!surface) return;
  evalUiSnapshots.set(surface, {
    ...(payload.payload && typeof payload.payload === 'object' ? payload.payload : {}),
    reportedAt: Date.now(),
  });
});

app.whenReady().then(() => {
  app.setName('agent-UI');
  loadInputModeSetting();
  installPetAssetProtocol();
  installAttachmentProtocol();
  refreshPetCharacterOptions();
  void loadGetWindowsModule();
  if (process.platform === 'darwin' && app.dock && process.env.AGENT_UI_EVAL !== '1') {
    app.dock.hide();
  }
  createWindow();
  createTray();
  closeEvalServer = startAgentUIEvalServer(
    {
      getConversation: async (catId) => {
        if (!catId) return { found: false, items: [] };
        return getAgentConversation(String(catId));
      },
      listConversations: async () => ({ ok: true, conversations: listAgentConversations() }),
      getUiTargets: async () => getEvalUiTargets(),
      start: async (payload = {}) => {
        const catId = normalizeCatId(payload.catId);
        return startCatRunFromPayload(payload, {
          catId: catId || undefined,
          closeModal: payload.closeModal !== false,
        });
      },
      followup: async ({ catId, text } = {}) => {
        const id = normalizeCatId(catId);
        if (!id) return { ok: false, error: 'missing cat id' };
        return sendFollowup(id, boundedText(text), { getMainWindow: () => mainWindow, log: console });
      },
      cancel: async ({ catId } = {}) => {
        const id = normalizeCatId(catId);
        if (!id) return { ok: false, error: 'missing cat id' };
        return cancelAgent(id, { getMainWindow: () => mainWindow, log: console });
      },
      openConversation: async ({ catId } = {}) => {
        const id = normalizeCatId(catId);
        if (!id) return { ok: false, error: 'missing cat id' };
        openConversationWindow(id);
        return { ok: true, catId: id };
      },
      setInputMode: async ({ mode } = {}) => {
        setSelectedInputMode(mode);
        return { ok: true, inputMode: selectedInputMode };
      },
      wait: async (payload = {}) => waitForEvalCat(payload),
      getTrace: async () => getTrace(),
      closeModal: async () => closeEvalModal(),
      dismiss: async ({ catId } = {}) => {
        if (!catId) return { ok: false, error: 'missing cat id' };
        const result = await dismissAgent(String(catId), { getMainWindow: () => mainWindow, log: console });
        recordTrace('cleanup_dismiss_completed', {
          catId: String(catId),
          ok: !!(result && result.ok),
          error: result && result.error ? result.error : null,
        });
        return result;
      },
      shutdown: () => app.quit(),
    },
    console
  );

  /** Throttle overlay speech bubbles so streaming tokens do not flood IPC. */
  const streamBubbleThrottle = new Map();

  function sendStreamBubbleThrottled(catId, text) {
    const id = String(catId);
    const msg = String(text || '').trim();
    if (!msg) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    let slot = streamBubbleThrottle.get(id);
    if (!slot) {
      slot = {};
      streamBubbleThrottle.set(id, slot);
    }
    slot.text = msg;
    if (!slot.sentFirst) {
      slot.sentFirst = true;
      mainWindow.webContents.send('agent-stream-bubble', { catId: id, text: msg });
      return;
    }
    if (slot.timer) return;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      const t = slot.text;
      if (!t || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('agent-stream-bubble', { catId: id, text: t });
    }, 120);
  }

  setOnConversationPushed(({ catId, streamBubble }) => {
    const _id = String(catId);
    sendConversationToOverlay(_id);
    if (conversationWindow && !conversationWindow.isDestroyed()) {
      conversationWindow.webContents.send('conversation-updated', { catId: _id });
    }
    if (streamBubble) sendStreamBubbleThrottled(_id, streamBubble);
  });

  void hydrateGatewayConversations({ getMainWindow: () => mainWindow, log: console });

  const reclampPetOverlay = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    cancelPetWindowMovePersist();
    if (petDragState) {
      petDragState.displayBounds = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
      movePetDrag();
      return;
    }
    cancelPetMomentum();
    applyPetLayout(undefined, { persist: true });
  };
  screen.on('display-added', reclampPetOverlay);
  screen.on('display-removed', reclampPetOverlay);
  screen.on('display-metrics-changed', reclampPetOverlay);

  const newCatAccelerator =
    process.platform === 'darwin' ? 'CommandOrControl+Shift+C' : 'Control+Shift+C';
  const registered = globalShortcut.register(newCatAccelerator, () => {
    void handleNewCatShortcut(newCatAccelerator);
  });
  recordTrace('shortcut_registered', { accelerator: newCatAccelerator, registered });
});

app.on('will-quit', () => {
  if (typeof closeEvalServer === 'function') {
    try {
      closeEvalServer();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[agent-ui] eval server cleanup', e);
    }
    closeEvalServer = null;
  } else if (closeEvalServer && typeof closeEvalServer.closeSync === 'function') {
    try {
      closeEvalServer.closeSync();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[agent-ui] eval server cleanup', e);
    }
    closeEvalServer = null;
  }
  cancelAllAgents();
  cancelPetMomentum();
  stopActiveWindowTracker();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Keep app running (tray) on non-mac, or we could quit; plan expects tray+shortcut
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
