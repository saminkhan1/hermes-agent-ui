const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID, createHash } = require('crypto');
const { execFile } = require('child_process');
const http = require('http');
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
  setOnConversationPushed,
  dismissAgent,
  sendFollowup,
  getAgentArtifacts,
} = require('./agents');

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

function readEvalJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendEvalJson(res, statusCode, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
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

function writeEvalPortFile(port) {
  const file = String(process.env.AGENT_UI_EVAL_PORT_FILE || '').trim();
  if (!file) return;
  fs.writeFileSync(file, `${port}\n`, 'utf8');
}

function startAgentUIEvalServer(handlers, log = console) {
  if (process.env.AGENT_UI_EVAL !== '1') return null;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        sendEvalJson(res, 200, { ok: true, app: 'agent-UI', eval: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/conversation') {
        sendEvalJson(res, 200, await handlers.getConversation(url.searchParams.get('catId')));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/conversations') {
        sendEvalJson(res, 200, await handlers.listConversations());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ui-targets') {
        sendEvalJson(res, 200, await handlers.getUiTargets());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/wait') {
        sendEvalJson(res, 200, await handlers.wait(await readEvalJson(req)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/trace') {
        sendEvalJson(res, 200, await handlers.getTrace());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/close-modal') {
        sendEvalJson(res, 200, await handlers.closeModal());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/dismiss') {
        sendEvalJson(res, 200, await handlers.dismiss(await readEvalJson(req)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        sendEvalJson(res, 200, { ok: true });
        setTimeout(() => handlers.shutdown(), 25);
        return;
      }
      sendEvalJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      sendEvalJson(res, 500, { ok: false, error: (e && e.message) || String(e) });
    }
  });

  const port = Number(process.env.AGENT_UI_EVAL_PORT || 0);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    writeEvalPortFile(actualPort);
    log.log(`[agent-ui] eval server listening on http://127.0.0.1:${actualPort}`);
  });

  return {
    closeSync() {
      try {
        server.close();
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

let mainWindow;
let modalWindow;
let conversationWindow;
/** Square conversation panel — content dimensions (px). */
const CONVERSATION_WINDOW_SIDE = 800;
const PET_WINDOW_WIDTH = 356;
const PET_WINDOW_HEIGHT = 320;
const PET_VIEWPORT_SIZE = { width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT };
const PET_DEFAULT_MARGIN = 24;
const PET_LAYOUT_PADDING = { top: 8, right: 28, bottom: 8, left: 0 };
const PET_TRAY_GAP = 4;
const PET_PLACEMENT_STICKINESS = 96;
const PET_DEFAULT_MASCOT_SIZE = { width: 112, height: 121 };
const PET_DEFAULT_TRAY_SIZE = { width: 276, height: 131 };
const PET_DISPLAY_SWITCH_SLOP = 24;
const PET_MOMENTUM_FRAME_MS = 16;
const PET_MOMENTUM_DECAY = 0.88;
const PET_MOMENTUM_STOP_VELOCITY = 65;
const PET_MOMENTUM_MAX_MS = 900;
/** When true, the overlay is accepting mouse (cursor over a cat). */
let mainWindowMouseable = false;
let lastCatScreenRects = [];
let tray;
let closeEvalServer = null;
/** Opening a child window temporarily clears `setVisibleOnAllWorkspaces` on the overlay (stacking/focus on macOS); restore when the child closes. */
let mainWindowWasVisibleOnAllWorkspaces = false;
/** Latest overlay session counts from renderer (dock / tray menu). */
let catCounts = { active: 0, inReview: 0 };
let overlayReady = false;
const pendingSpawnCats = [];
let activeModalContextId = null;
const modalContexts = new Map();
let lastExternalWindowSnapshot = null;
let activeWindowPollTimer = null;
let petOverlayOpenRequested = false;
let petDragState = null;
let petMomentumTimer = null;
let petPointerInteractive = false;
let petPointerInteractionSeen = false;
let petKeyboardInteractive = false;
let petAnchor = null;
let petLayout = null;
let petMascotSize = { ...PET_DEFAULT_MASCOT_SIZE };
let petTraySize = null;
let petPlacement = 'top-end';

function getPetOverlayStatePath() {
  return path.join(getAgentUIConfigDir(), 'pet-overlay.json');
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

function rectCenterX(rect) {
  return rect.x + rect.width / 2;
}

function rectCenterY(rect) {
  return rect.y + rect.height / 2;
}

function pointForRectCenter(rect) {
  return { x: rectCenterX(rect), y: rectCenterY(rect) };
}

function clampNumber(value, min, max) {
  if (min > max) return Math.round((min + max) / 2);
  return Math.min(Math.max(Math.round(value), min), max);
}

function safeInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function clampRectToDisplay(rect, displayBounds, { bottomPadding = 0 } = {}) {
  return {
    ...rect,
    x: clampNumber(rect.x, displayBounds.x, displayBounds.x + displayBounds.width - rect.width),
    y: clampNumber(rect.y, displayBounds.y, displayBounds.y + displayBounds.height - rect.height - bottomPadding),
  };
}

function expandedMascotBounds(mascotBounds) {
  return {
    x: mascotBounds.x - PET_LAYOUT_PADDING.left,
    y: mascotBounds.y - PET_LAYOUT_PADDING.top,
    width: mascotBounds.width + PET_LAYOUT_PADDING.left + PET_LAYOUT_PADDING.right,
    height: mascotBounds.height + PET_LAYOUT_PADDING.top + PET_LAYOUT_PADDING.bottom,
  };
}

function trayBoundsForPlacement(anchor, traySize, placement) {
  const isTop = placement.startsWith('top');
  return {
    x: placement.endsWith('end') ? anchor.x + anchor.width - traySize.width : anchor.x,
    y: isTop ? anchor.y - traySize.height - PET_TRAY_GAP : anchor.y + anchor.height + PET_TRAY_GAP,
    width: traySize.width,
    height: traySize.height,
  };
}

function overflowScore(rect, displayBounds) {
  const left = Math.max(0, displayBounds.x - rect.x);
  const top = Math.max(0, displayBounds.y - rect.y);
  const right = Math.max(0, rect.x + rect.width - displayBounds.x - displayBounds.width);
  const bottom = Math.max(0, rect.y + rect.height - displayBounds.y - displayBounds.height);
  return left + top + right + bottom + (left + right) * rect.height + (top + bottom) * rect.width;
}

function unionRects(rects) {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function localRect(rect, viewportBounds) {
  return {
    left: Math.round(rect.x - viewportBounds.x),
    top: Math.round(rect.y - viewportBounds.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function preferredPlacement(anchor, displayBounds) {
  const vertical = rectCenterY(anchor) < rectCenterY(displayBounds) ? 'bottom' : 'top';
  const horizontal = rectCenterX(anchor) < rectCenterX(displayBounds) ? 'start' : 'end';
  return `${vertical}-${horizontal}`;
}

function choosePlacement({ anchor, displayBounds, previousPlacement, traySize }) {
  const preferred = preferredPlacement(anchor, displayBounds);
  const placements = ['top-start', 'top-end', 'bottom-start', 'bottom-end']
    .map((placement) => ({
      placement,
      score:
        overflowScore(trayBoundsForPlacement(anchor, traySize, placement), displayBounds) +
        (placement === preferred ? 0 : 32) +
        (placement === previousPlacement ? -PET_PLACEMENT_STICKINESS : 0),
    }))
    .sort((a, b) => a.score - b.score);
  return placements[0] ? placements[0].placement : preferred;
}

function contentViewportBounds({ contentBounds, displayBounds, viewportSize }) {
  return {
    x: clampNumber(contentBounds.x + contentBounds.width - viewportSize.width, displayBounds.x, displayBounds.x + displayBounds.width - viewportSize.width),
    y: clampNumber(contentBounds.y + contentBounds.height - viewportSize.height, displayBounds.y, displayBounds.y + displayBounds.height - viewportSize.height),
    width: viewportSize.width,
    height: viewportSize.height,
  };
}

function computePetLayout({
  anchor,
  displayBounds,
  mascotSize,
  previousPlacement,
  traySize,
  viewportSize = PET_VIEWPORT_SIZE,
}) {
  const viewport = {
    width: Math.min(viewportSize.width, displayBounds.width),
    height: Math.min(viewportSize.height, displayBounds.height),
  };
  const safeAnchor = clampRectToDisplay({
    ...anchor,
    width: Math.min(mascotSize.width, displayBounds.width),
    height: Math.min(mascotSize.height, displayBounds.height),
  }, displayBounds, { bottomPadding: PET_LAYOUT_PADDING.bottom });
  const maxTrayWidth = Math.max(0, viewport.width - PET_LAYOUT_PADDING.left - PET_LAYOUT_PADDING.right);
  const maxTrayHeight = Math.max(0, viewport.height - safeAnchor.height - PET_LAYOUT_PADDING.bottom - PET_TRAY_GAP);
  const clampedTraySize = traySize == null ? null : {
    width: Math.min(traySize.width, maxTrayWidth),
    height: Math.min(traySize.height, maxTrayHeight),
  };
  const placement = clampedTraySize == null
    ? previousPlacement
    : choosePlacement({
      anchor: safeAnchor,
      displayBounds,
      previousPlacement,
      traySize: clampedTraySize,
    });
  const trayBounds = clampedTraySize == null
    ? null
    : clampRectToDisplay(trayBoundsForPlacement(safeAnchor, clampedTraySize, placement), displayBounds);
  const viewportBounds = contentViewportBounds({
    contentBounds: unionRects([
      expandedMascotBounds(safeAnchor),
      ...(trayBounds == null ? [] : [trayBounds]),
    ]),
    displayBounds,
    viewportSize: viewport,
  });
  return {
    anchor: safeAnchor,
    mascot: localRect(safeAnchor, viewportBounds),
    placement,
    tray: trayBounds == null ? null : localRect(trayBounds, viewportBounds),
    viewport,
    windowBounds: viewportBounds,
  };
}

function defaultPetAnchor(display = screen.getPrimaryDisplay()) {
  const bounds = display.bounds;
  return {
    x: bounds.x + bounds.width - petMascotSize.width - PET_DEFAULT_MARGIN,
    y: bounds.y + bounds.height - petMascotSize.height - PET_DEFAULT_MARGIN,
    width: petMascotSize.width,
    height: petMascotSize.height,
  };
}

function displayBoundsForPetAnchor(anchor = petAnchor) {
  const point = anchor ? pointForRectCenter(anchor) : screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(point).bounds;
}

function expandedDisplayBounds(bounds, amount) {
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    width: bounds.width + amount * 2,
    height: bounds.height + amount * 2,
  };
}

function pointInRect(point, rect) {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

function sameBounds(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function displayBoundsForDragPoint(point, previousDisplayBounds) {
  const nearest = screen.getDisplayNearestPoint(point).bounds;
  if (sameBounds(nearest, previousDisplayBounds)) return nearest;
  if (previousDisplayBounds && pointInRect(point, expandedDisplayBounds(previousDisplayBounds, PET_DISPLAY_SWITCH_SLOP))) {
    return previousDisplayBounds;
  }
  return nearest;
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

function cancelPetMomentum() {
  if (petMomentumTimer != null) {
    clearTimeout(petMomentumTimer);
    petMomentumTimer = null;
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
  mainWindow.setBounds({
    x: Math.round(Number(bounds.x)),
    y: Math.round(Number(bounds.y)),
    width: Math.round(Number(bounds.width) || PET_WINDOW_WIDTH),
    height: Math.round(Number(bounds.height) || PET_WINDOW_HEIGHT),
  }, false);
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

function cursorOverPetScreenRects() {
  if (!lastCatScreenRects.length) return false;
  const p = screen.getCursorScreenPoint();
  return lastCatScreenRects.some((b) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom);
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
  const shouldAcceptMouse =
    petKeyboardInteractive ||
    petDragState != null ||
    petPointerInteractive ||
    (!petPointerInteractionSeen && cursorOverPetScreenRects());
  setPetWindowMouseable(shouldAcceptMouse, { refreshCursor: shouldAcceptMouse });
}

function openPetOverlay({ persist = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  petOverlayOpenRequested = true;
  petPointerInteractive = false;
  petPointerInteractionSeen = false;
  restoreMainWindowAllWorkspaces();
  applyPetLayout(undefined, { persist: false });
  if (!mainWindow.isVisible()) mainWindow.showInactive();
  mainWindow.moveTop();
  if (persist) writePetOverlayState({ open: true });
  rebuildAppMenus();
}

function setPetKeyboardInteraction(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  petKeyboardInteractive = !!enabled;
  if (!petKeyboardInteractive) {
    mainWindow.setFocusable(false);
    applyPetMouseInteractivityPolicy();
    return;
  }
  mainWindow.setFocusable(true);
  setPetWindowMouseable(true, { refreshCursor: true });
  if (!mainWindow.isVisible()) mainWindow.show();
  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }
  mainWindow.focus();
  mainWindow.webContents.focus();
  mainWindow.webContents.send('pet-keyboard-interaction-ready', {});
}

function setPetPointerInteraction(enabled) {
  petPointerInteractionSeen = true;
  petPointerInteractive = !!enabled;
  applyPetMouseInteractivityPolicy();
}

function closePetOverlay({ persist = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  petOverlayOpenRequested = false;
  cancelPetMomentum();
  petDragState = null;
  setPetPointerInteraction(false);
  setPetKeyboardInteraction(false);
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
  const { x, y, width, height } = initialPetWindowBounds();

  mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  mainWindow.setAlwaysOnTop(true, 'floating');

  mainWindow.on('show', () => rebuildAppMenus());
  mainWindow.on('hide', () => rebuildAppMenus());
  mainWindow.webContents.on('did-start-loading', () => {
    overlayReady = false;
  });
  lastCatScreenRects = [];
  mainWindowMouseable = false;
  petPointerInteractive = false;
  petPointerInteractionSeen = false;

  mainWindow.once('ready-to-show', () => {
    if (petOverlayOpenRequested) openPetOverlay({ persist: false });
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function restoreMainWindowAllWorkspaces() {
  if (process.platform !== 'darwin') return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowWasVisibleOnAllWorkspaces) return;
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  mainWindowWasVisibleOnAllWorkspaces = false;
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

function closeWindowOnEscape(win, closeFn) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    event.preventDefault();
    closeFn();
  });
}

function openNewCatModal(modalContextId) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  recordTrace('modal_show_requested', { modalContextId: modalContextId || null });

  if (conversationWindow && !conversationWindow.isDestroyed()) {
    conversationWindow.close();
  }

  if (modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }

  if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindowWasVisibleOnAllWorkspaces = true;
    mainWindow.setVisibleOnAllWorkspaces(false);
  }

  modalWindow = new BrowserWindow({
    width: 680,
    height: 240,
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
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  closeWindowOnEscape(modalWindow, () => {
    if (modalWindow && !modalWindow.isDestroyed()) {
      modalWindow.close();
    }
  });

  modalWindow.webContents.once('did-finish-load', () => {
    recordTrace('modal_dom_loaded', { modalContextId: modalContextId || null });
  });

  modalWindow.once('ready-to-show', () => {
    modalWindow.show();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
    modalWindow.moveTop();
    modalWindow.focus();
    modalWindow.webContents.focus();
    recordTrace('modal_shown_and_focused', {
      modalContextId: modalContextId || null,
      bounds: modalWindow && !modalWindow.isDestroyed() ? modalWindow.getBounds() : null,
    });
  });

  modalWindow.on('closed', () => {
    modalWindow = null;
    modalContexts.delete(modalContextId);
    if (activeModalContextId === modalContextId) {
      activeModalContextId = null;
    }
    restoreMainWindowAllWorkspaces();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/?$/, '');
    modalWindow.loadURL(`${base}/modal.html?${new URLSearchParams({ modalContextId: modalContextId || '' }).toString()}`);
  } else {
    modalWindow.loadFile(path.join(__dirname, '../renderer/modal.html'), {
      query: { modalContextId: modalContextId || '' },
    });
  }
}

function openConversationWindow(catId) {
  if (!mainWindow || mainWindow.isDestroyed() || !catId) return;

  if (modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }

  const q = { catId: String(catId) };
  if (conversationWindow && !conversationWindow.isDestroyed()) {
    if (process.env.ELECTRON_RENDERER_URL) {
      const base = process.env.ELECTRON_RENDERER_URL.replace(/\/?$/, '');
      void conversationWindow.loadURL(
        `${base}/conversation.html?${new URLSearchParams(q).toString()}`
      );
    } else {
      void conversationWindow.loadFile(path.join(__dirname, '../renderer/conversation.html'), {
        query: q,
      });
    }
    conversationWindow.setContentSize(CONVERSATION_WINDOW_SIDE, CONVERSATION_WINDOW_SIDE);
    conversationWindow.show();
    conversationWindow.focus();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
    return;
  }

  if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindowWasVisibleOnAllWorkspaces = true;
    mainWindow.setVisibleOnAllWorkspaces(false);
  }

  conversationWindow = new BrowserWindow({
    width: CONVERSATION_WINDOW_SIDE,
    height: CONVERSATION_WINDOW_SIDE,
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
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  closeWindowOnEscape(conversationWindow, () => {
    if (conversationWindow && !conversationWindow.isDestroyed()) {
      conversationWindow.close();
    }
  });

  conversationWindow.once('ready-to-show', () => {
    conversationWindow.show();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
    conversationWindow.moveTop();
    conversationWindow.focus();
    conversationWindow.webContents.focus();
  });

  conversationWindow.on('closed', () => {
    conversationWindow = null;
    restoreMainWindowAllWorkspaces();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/?$/, '');
    void conversationWindow.loadURL(
      `${base}/conversation.html?${new URLSearchParams(q).toString()}`
    );
  } else {
    void conversationWindow.loadFile(path.join(__dirname, '../renderer/conversation.html'), {
      query: q,
    });
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

function buildAppMenu() {
  const catsVisible = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const accelerator = process.platform === 'darwin' ? 'Command+Shift+C' : 'Control+Shift+C';
  return Menu.buildFromTemplate([
    {
      label: 'New Session',
      accelerator,
      click: () => {
        void handleNewCatShortcut('menu');
      },
    },
    { type: 'separator' },
    {
      label: catsVisible ? 'Close Pet' : 'Wake Pet',
      click: () => {
        setCatsVisible(!catsVisible);
      },
    },
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
  return Menu.buildFromTemplate([
    {
      label: 'agent-UI',
      submenu: [
        {
          label: 'New Session',
          accelerator,
          click: () => {
            void handleNewCatShortcut('menu');
          },
        },
        { type: 'separator' },
        {
          label: catsVisible ? 'Close Pet' : 'Wake Pet',
          click: () => {
            setCatsVisible(!catsVisible);
          },
        },
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

function startActiveWindowTracker() {
  if (activeWindowPollTimer != null) return;
  const tick = () => {
    void readActiveWindowSnapshot().catch(() => {
      // Context capture is best-effort and must not affect the launcher.
    });
  };
  tick();
  activeWindowPollTimer = setInterval(tick, 750);
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
  const modalContextId = randomUUID();
  activeModalContextId = modalContextId;
  const launchContext = await captureLaunchContext(source, modalContextId);
  modalContexts.set(modalContextId, launchContext);
  recordTrace('shortcut_received', {
    source,
    modalContextId,
    contextQuality: launchContext.contextQuality,
    missingContext: launchContext.missingContext,
    screenContextHint: launchContext.screenContextHint || null,
  });
  openNewCatModal(modalContextId);
}

ipcMain.on('overlay-ready', () => {
  overlayReady = true;
  flushPendingSpawnCats();
});

function getAgentUIConfigDir() {
  const configured = String(process.env.AGENT_UI_CONFIG_DIR || '').trim();
  const dir = configured ? path.resolve(configured) : path.join(os.homedir(), '.agent-ui');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function startCatRunFromPayload(payload = {}, opts = {}) {
  const catId = opts.catId ? String(opts.catId) : randomUUID();
  const modalContextId =
    (opts.modalContextId && String(opts.modalContextId)) ||
    (payload && payload.modalContextId ? String(payload.modalContextId) : '') ||
    activeModalContextId ||
    '';
  const runtime = 'local';
  const prompt = payload && payload.prompt != null ? String(payload.prompt) : '';
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
  const out = { catId, prompt, runtime, modalContextId };
  if (modalContextId) modalContexts.delete(modalContextId);
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
  return { ok: true, catId, runtime };
}

ipcMain.on('new-cat-submit', (_event, payload) => {
  void startCatRunFromPayload(payload, { closeModal: true });
});

ipcMain.on('new-cat-cancel', () => {
  if (modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }
});

ipcMain.on('cat-counts', (_event, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const active = Number(payload.active);
  const inReview = Number(payload.inReview);
  if (!Number.isFinite(active) || !Number.isFinite(inReview)) return;
  catCounts = { active: Math.max(0, Math.floor(active)), inReview: Math.max(0, Math.floor(inReview)) };
  rebuildAppMenus();
  updateTrayTitle();
});

ipcMain.on('cat-screen-rects', (_event, rects) => {
  if (!Array.isArray(rects)) {
    lastCatScreenRects = [];
    return;
  }
  lastCatScreenRects = rects.filter(
    (r) =>
      r &&
      [r.left, r.top, r.right, r.bottom].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      r.right - r.left > 0 &&
      r.bottom - r.top > 0
  );
});

ipcMain.on('pet-overlay-toggle', () => {
  togglePetOverlay();
});

ipcMain.on('pet-context-menu', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  Menu.buildFromTemplate([
    {
      label: 'Close pet',
      click: () => closePetOverlay({ persist: true }),
    },
  ]).popup({ window: mainWindow });
});

ipcMain.on('pet-keyboard-interaction-changed', (_event, payload = {}) => {
  setPetKeyboardInteraction(!!payload.active);
});

ipcMain.on('pet-pointer-interaction-changed', (_event, payload = {}) => {
  setPetPointerInteraction(!!payload.active);
});

ipcMain.on('pet-element-size-changed', (_event, payload = {}) => {
  if (!payload || typeof payload !== 'object') return;
  const mascot = payload.mascot && typeof payload.mascot === 'object' ? payload.mascot : null;
  const trayPayload = payload.tray && typeof payload.tray === 'object' ? payload.tray : null;
  const mascotWidth = mascot ? Number(mascot.width) : NaN;
  const mascotHeight = mascot ? Number(mascot.height) : NaN;
  if (Number.isFinite(mascotWidth) && Number.isFinite(mascotHeight) && mascotWidth > 0 && mascotHeight > 0) {
    petMascotSize = { width: Math.ceil(mascotWidth), height: Math.ceil(mascotHeight) };
    petAnchor = { ...(petAnchor || defaultPetAnchor()), width: petMascotSize.width, height: petMascotSize.height };
  }
  const trayWidth = trayPayload ? Number(trayPayload.width) : NaN;
  const trayHeight = trayPayload ? Number(trayPayload.height) : NaN;
  petTraySize = Number.isFinite(trayWidth) && Number.isFinite(trayHeight) && trayWidth > 0 && trayHeight > 0
    ? { width: Math.ceil(trayWidth), height: Math.ceil(trayHeight) }
    : null;
  applyPetLayout(undefined, { persist: false });
});

ipcMain.on('pet-drag-start', (_event, payload = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  cancelPetMomentum();
  setPetWindowMouseable(true, { refreshCursor: true });
  const pointerWindowX = Number(payload.pointerWindowX);
  const pointerWindowY = Number(payload.pointerWindowY);
  const currentLayout = petLayout || computePetLayout({
    anchor: petAnchor || defaultPetAnchor(),
    displayBounds: displayBoundsForPetAnchor(),
    mascotSize: petMascotSize,
    previousPlacement: petPlacement,
    traySize: petTraySize,
  });
  petDragState = {
    pointerAnchorX: (Number.isFinite(pointerWindowX) ? pointerWindowX : currentLayout.mascot.left) - currentLayout.mascot.left,
    pointerAnchorY: (Number.isFinite(pointerWindowY) ? pointerWindowY : currentLayout.mascot.top) - currentLayout.mascot.top,
    displayBounds: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds,
  };
});

ipcMain.on('pet-drag-move', () => {
  if (!mainWindow || mainWindow.isDestroyed() || !petDragState) return;
  const p = screen.getCursorScreenPoint();
  const displayBounds = displayBoundsForDragPoint(p, petDragState.displayBounds);
  petDragState.displayBounds = displayBounds;
  petAnchor = {
    ...(petAnchor || defaultPetAnchor()),
    x: p.x - petDragState.pointerAnchorX,
    y: p.y - petDragState.pointerAnchorY,
    width: petMascotSize.width,
    height: petMascotSize.height,
  };
  applyPetLayout(displayBounds, { persist: false });
});

ipcMain.on('pet-drag-end', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (petDragState) {
    const p = screen.getCursorScreenPoint();
    const displayBounds = displayBoundsForDragPoint(p, petDragState.displayBounds);
    petAnchor = {
      ...(petAnchor || defaultPetAnchor()),
      x: p.x - petDragState.pointerAnchorX,
      y: p.y - petDragState.pointerAnchorY,
      width: petMascotSize.width,
      height: petMascotSize.height,
    };
    applyPetLayout(displayBounds, { persist: true });
  }
  persistPetWindowBounds();
  petDragState = null;
  applyPetMouseInteractivityPolicy();
});

ipcMain.on('pet-drag-release', (_event, payload = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let vx = Number(payload.velocityX);
  let vy = Number(payload.velocityY);
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || (vx === 0 && vy === 0)) return;
  cancelPetMomentum();
  let elapsed = 0;
  const step = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      cancelPetMomentum();
      return;
    }
    petMomentumTimer = null;
    elapsed += PET_MOMENTUM_FRAME_MS;
    const requested = {
      ...(petAnchor || defaultPetAnchor()),
      x: (petAnchor ? petAnchor.x : defaultPetAnchor().x) + (vx * PET_MOMENTUM_FRAME_MS) / 1000,
      y: (petAnchor ? petAnchor.y : defaultPetAnchor().y) + (vy * PET_MOMENTUM_FRAME_MS) / 1000,
      width: petMascotSize.width,
      height: petMascotSize.height,
    };
    petAnchor = requested;
    applyPetLayout(screen.getDisplayNearestPoint(pointForRectCenter(requested)).bounds, { persist: false });
    if (petAnchor.x !== Math.round(requested.x)) vx = 0;
    if (petAnchor.y !== Math.round(requested.y)) vy = 0;
    vx *= PET_MOMENTUM_DECAY;
    vy *= PET_MOMENTUM_DECAY;
    if (elapsed >= PET_MOMENTUM_MAX_MS || Math.hypot(vx, vy) < PET_MOMENTUM_STOP_VELOCITY) {
      persistPetWindowBounds();
      return;
    }
    petMomentumTimer = setTimeout(step, PET_MOMENTUM_FRAME_MS);
  };
  petMomentumTimer = setTimeout(step, PET_MOMENTUM_FRAME_MS);
});

ipcMain.on('open-cat-conversation', (_e, { catId } = {}) => {
  if (!catId) return;
  openConversationWindow(String(catId));
});

ipcMain.on('close-conversation-window', () => {
  if (conversationWindow && !conversationWindow.isDestroyed()) {
    conversationWindow.close();
  }
});

ipcMain.on('dismiss-cat', async (_e, { catId } = {}) => {
  if (!catId) return;
  const result = await dismissAgent(String(catId), { getMainWindow: () => mainWindow, log: console });
  if (!result || result.ok === false) return;
  if (conversationWindow && !conversationWindow.isDestroyed()) {
    conversationWindow.close();
  }
});

ipcMain.handle('agent-followup', (_e, { catId, text } = {}) => {
  if (!catId) return { ok: false, error: 'Missing session id.' };
  return sendFollowup(String(catId), text, { getMainWindow: () => mainWindow, log: console });
});

ipcMain.handle('get-agent-conversation', (_e, catId) => getAgentConversation(catId));

function offsetRect(rect, win) {
  if (!rect || !win || win.isDestroyed()) return null;
  const wb = win.getBounds();
  return {
    left: wb.x + rect.left,
    top: wb.y + rect.top,
    right: wb.x + rect.right,
    bottom: wb.y + rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

async function readDomEvalTargets(win, selectors) {
  if (!win || win.isDestroyed()) return {};
  try {
    const raw = await win.webContents.executeJavaScript(
      `(() => {
        const selectors = ${JSON.stringify(selectors)};
        const out = {};
        const rectFor = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (!r || r.width <= 0 || r.height <= 0) return null;
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        for (const [key, selector] of Object.entries(selectors)) {
          if (selector.endsWith('[]')) {
            const base = selector.slice(0, -2);
            out[key] = Array.from(document.querySelectorAll(base)).map(rectFor).filter(Boolean);
          } else {
            out[key] = rectFor(document.querySelector(selector));
          }
        }
        out.activeElement = document.activeElement ? { id: document.activeElement.id || '', tag: document.activeElement.tagName || '' } : null;
        const prompt = document.querySelector('#prompt');
        out.promptValueLength = prompt && typeof prompt.value === 'string' ? prompt.value.length : 0;
        out.promptValuePreview = prompt && typeof prompt.value === 'string' ? prompt.value.slice(0, 120) : '';
        const visibleText = document.body && typeof document.body.innerText === 'string' ? document.body.innerText.replace(/\s+/g, ' ').trim() : '';
        out.visibleTextLength = visibleText.length;
        out.visibleTextPreview = visibleText.slice(0, 4000);
        out.lineEntries = Array.from(document.querySelectorAll('.line')).slice(0, 20).map((line) => {
          const label = line.querySelector('.line-label');
          const text = line.querySelector('.line-text');
          return {
            label: label && typeof label.textContent === 'string' ? label.textContent : '',
            text: text && typeof text.textContent === 'string' ? text.textContent : '',
          };
        });
        return out;
      })()`,
      true
    );
    const out = {};
    for (const [key, value] of Object.entries(raw || {})) {
      if (key === 'lineEntries') {
        out[key] = value;
      } else if (Array.isArray(value)) {
        out[key] = value.map((r) => offsetRect(r, win)).filter(Boolean);
      } else if (value && typeof value === 'object' && 'left' in value) {
        out[key] = offsetRect(value, win);
      } else {
        out[key] = value;
      }
    }
    return out;
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

async function getEvalUiTargets() {
  const modal = await readDomEvalTargets(modalWindow, {
    promptRect: '#prompt',
    micButtonRect: '#btn-dictate',
    createButtonRect: '#btn-create-cat',
  });
  const conversation = await readDomEvalTargets(conversationWindow, {
    logRect: '#log',
    followupRect: '#followup-input',
  });
  return {
    ok: true,
    modal: {
      modalContextId: activeModalContextId,
      visible: !!(modalWindow && !modalWindow.isDestroyed() && modalWindow.isVisible()),
      bounds: modalWindow && !modalWindow.isDestroyed() ? modalWindow.getBounds() : null,
      osProcessId: modalWindow && !modalWindow.isDestroyed() ? modalWindow.webContents.getOSProcessId() : null,
      ...modal,
    },
    conversation: {
      visible: !!(conversationWindow && !conversationWindow.isDestroyed() && conversationWindow.isVisible()),
      bounds: conversationWindow && !conversationWindow.isDestroyed() ? conversationWindow.getBounds() : null,
      ...conversation,
    },
    cats: lastCatScreenRects.slice(),
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

async function runSpeechHelper() {
  const helper = path.join(getPackageRoot(), 'src', 'main', 'AgentUISpeech.swift');
  if (!fs.existsSync(helper)) {
    return { ok: false, error: 'speech helper is missing' };
  }
  try {
    const transcript = (await execFileText('/usr/bin/swift', [helper], { timeout: 30000 })).trim();
    return transcript ? { ok: true, transcript } : { ok: false, error: 'empty transcript' };
  } catch (e) {
    return { ok: false, error: (e && (e.stderr || e.message)) || String(e) };
  }
}

ipcMain.handle('start-voice-dictation', async () => {
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
  const result = await runSpeechHelper();
  if (result.ok) {
    recordTrace('voice_final_transcript', { deterministic: false, ...textTraceMeta(result.transcript) });
  }
  return result;
});

ipcMain.on('eval-trace-event', (_event, payload = {}) => {
  const type = payload && payload.type ? payload.type : 'renderer_event';
  const { type: _type, ...rest } = payload && typeof payload === 'object' ? payload : {};
  recordTrace(type, rest);
});

app.whenReady().then(() => {
  app.setName('agent-UI');
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
    if (conversationWindow && !conversationWindow.isDestroyed()) {
      conversationWindow.webContents.send('conversation-updated', { catId: _id });
    }
    if (streamBubble) sendStreamBubbleThrottled(_id, streamBubble);
  });

  const reclampPetOverlay = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (petDragState) {
      const point = screen.getCursorScreenPoint();
      petDragState.displayBounds = screen.getDisplayNearestPoint(point).bounds;
      return;
    }
    cancelPetMomentum();
    applyPetLayout(undefined, { persist: true });
  };
  screen.on('display-added', reclampPetOverlay);
  screen.on('display-removed', reclampPetOverlay);
  screen.on('display-metrics-changed', reclampPetOverlay);
  startActiveWindowTracker();

  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    applyPetMouseInteractivityPolicy();
  }, 32);

  const quit = () => {
    app.quit();
  };
  if (process.platform === 'darwin') {
    globalShortcut.register('Command+Q', quit);
  } else {
    globalShortcut.register('Control+Q', quit);
  }

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
  if (activeWindowPollTimer != null) {
    clearInterval(activeWindowPollTimer);
    activeWindowPollTimer = null;
  }
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Keep app running (tray) on non-mac, or we could quit; plan expects tray+shortcut
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
