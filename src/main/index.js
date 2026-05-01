const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
  dialog,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID, createHash } = require('crypto');
const { spawn, execFile } = require('child_process');
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
  cancelAgent,
  sendFollowup,
  revertAgentChanges,
  getAgentArtifacts,
} = require('./agents');
const { startHookServer } = require('./hook-server');
const {
  handleIdeSessionStart,
  handleIdeSessionEnd,
  removeIdeCatIfPresent,
} = require('./ide-sessions');

/**
 * Root of the installed package (`package.json`, `assets/`, `out/`).
 * Do not use `app.getAppPath()` for files here: when Electron is started with an explicit
 * main module (e.g. `npx …` / `electron out/main/index.js`), it returns `out/main/`, not
 * the package root, so `assets/` would not be found.
 */
function getPackageRoot() {
  return path.resolve(__dirname, '..', '..');
}

function assertPathInsideApp(relPath) {
  const root = path.resolve(getPackageRoot());
  const full = path.resolve(path.join(root, relPath));
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('Path escapes app root');
  }
  return full;
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
      if (req.method === 'POST' && url.pathname === '/revert') {
        sendEvalJson(res, 200, await handlers.revert(await readEvalJson(req)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/dismiss') {
        sendEvalJson(res, 200, await handlers.dismiss(await readEvalJson(req)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/cancel') {
        sendEvalJson(res, 200, await handlers.cancel(await readEvalJson(req)));
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
/** @type {null | (() => void)} */
let closeHookServer = null;
/** When true, the overlay is accepting mouse (cursor over a cat). */
let mainWindowMouseable = false;
let lastCatScreenRects = [];
let tray;
let closeEvalServer = null;
/** Opening a modal child temporarily clears `setVisibleOnAllWorkspaces` on the overlay (stacking/focus on macOS); restore when the modal closes. */
let mainWindowWasVisibleOnAllWorkspaces = false;
/** Latest overlay cat counts from renderer (dock / tray menu). */
let catCounts = { active: 0, inReview: 0 };
let overlayReady = false;
const pendingSpawnCats = [];

/** Tracked for frontmost window stability (used by get-frontmost-window-info). */
let activeWindowState = { id: null, firstSeenAt: 0, screenBounds: null };
let lastExternalWindowSnapshot = null;
/** Captured at the moment the user invokes Cmd+Shift+C, then attached to the submitted cat. */
let activeModalContextId = null;
const modalContexts = new Map();
function windowKey(win) {
  if (!win || !win.owner) return null;
  return `${win.owner.processId}:${win.id}`;
}

function clipScreenBoundsToOverlayLocal(wb) {
  if (!wb) return null;
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.bounds;
  const left0 = wb.x - dx;
  const top0 = wb.y - dy;
  const right0 = left0 + wb.width;
  const bottom0 = top0 + wb.height;
  const left = Math.max(0, left0);
  const top = Math.max(0, top0);
  const right = Math.min(dw, right0);
  const bottom = Math.min(dh, bottom0);
  if (right - left < 2 || bottom - top < 2) return null;
  return { left, top, right, bottom };
}

async function tickActiveWindowTracker() {
  try {
    const { activeWindow } = await import('get-windows');
    const win = await activeWindow({
      accessibilityPermission: false,
      screenRecordingPermission: false,
    });
    if (!win || !win.bounds || (win.owner && win.owner.processId === process.pid)) {
      activeWindowState = { id: null, firstSeenAt: 0, screenBounds: null };
      return;
    }
    const key = windowKey(win);
    if (key == null) {
      activeWindowState = { id: null, firstSeenAt: 0, screenBounds: null };
      return;
    }
    if (key !== activeWindowState.id) {
      activeWindowState = {
        id: key,
        firstSeenAt: Date.now(),
        screenBounds: { x: win.bounds.x, y: win.bounds.y, width: win.bounds.width, height: win.bounds.height },
      };
    } else {
      activeWindowState.screenBounds = {
        x: win.bounds.x,
        y: win.bounds.y,
        width: win.bounds.width,
        height: win.bounds.height,
      };
    }
    lastExternalWindowSnapshot = {
      capturedAt: Date.now(),
      title: win.title || '',
      id: win.id || null,
      bounds: { x: win.bounds.x, y: win.bounds.y, width: win.bounds.width, height: win.bounds.height },
      owner: win.owner ? { ...win.owner } : {},
    };
  } catch {
    // ignore get-windows errors
  }
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  // The macOS Dock (and Windows taskbar) lives at a higher window level than
  // our alwaysOnTop transparent overlay, so a window sized to `display.bounds`
  // gets its bottom edge covered by the Dock and the cats' feet are clipped.
  // Use `workArea` so the overlay's bottom sits flush with the top of the
  // Dock / taskbar (or the true screen bottom when the Dock is hidden or on
  // another display), keeping cats fully visible on all setups.
  const { x, y, width, height } = display.workArea;

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
    show: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('show', () => rebuildAppMenus());
  mainWindow.on('hide', () => rebuildAppMenus());
  mainWindow.webContents.on('did-start-loading', () => {
    overlayReady = false;
  });
  lastCatScreenRects = [];
  mainWindowMouseable = false;

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function restoreMainWindowAllWorkspaces() {
  if (process.platform !== 'darwin') return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowWasVisibleOnAllWorkspaces) return;
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindowWasVisibleOnAllWorkspaces = false;
}

function ensureOverlayVisibleForSpawn() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  restoreMainWindowAllWorkspaces();
  if (!mainWindow.isVisible()) {
    mainWindow.showInactive();
  }
}

function flushPendingSpawnCats() {
  if (!mainWindow || mainWindow.isDestroyed() || !overlayReady) return;
  ensureOverlayVisibleForSpawn();
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

/** Best-effort: bring Cursor to the foreground (no workspace/deeplink; see plan). */
function activateCursorApp() {
  try {
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Cursor'], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn('cursor', [], { detached: true, stdio: 'ignore', shell: true }).unref();
    } else {
      spawn('cursor', [], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // ignore
  }
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
  const requestedAt = Date.now();
  const ctx = modalContextId ? modalContexts.get(modalContextId) : null;
  recordTrace('modal_show_requested', {
    modalContextId: modalContextId || null,
    hasPointerContext: !!(ctx && ctx.context),
    msSinceShortcut: ctx && ctx.createdAt ? requestedAt - ctx.createdAt : null,
  });

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
    height: 500,
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

  recordTrace('modal_window_created', {
    modalContextId: modalContextId || null,
    msSinceModalShowRequested: Date.now() - requestedAt,
    msSinceShortcut: ctx && ctx.createdAt ? Date.now() - ctx.createdAt : null,
  });

  closeWindowOnEscape(modalWindow, () => {
    if (modalWindow && !modalWindow.isDestroyed()) {
      modalWindow.close();
    }
  });

  modalWindow.webContents.once('did-finish-load', () => {
    recordTrace('modal_dom_loaded', {
      modalContextId: modalContextId || null,
      msSinceModalShowRequested: Date.now() - requestedAt,
      msSinceShortcut: ctx && ctx.createdAt ? Date.now() - ctx.createdAt : null,
    });
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
      msSinceModalShowRequested: Date.now() - requestedAt,
      msSinceShortcut: ctx && ctx.createdAt ? Date.now() - ctx.createdAt : null,
    });
  });

  modalWindow.on('closed', () => {
    modalWindow = null;
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
    if (!mainWindow.isVisible()) mainWindow.showInactive();
  } else if (mainWindow.isVisible()) {
    mainWindow.hide();
  }
  rebuildAppMenus();
}

function buildAppMenu() {
  const catsVisible = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const activeN = Number.isFinite(catCounts.active) ? catCounts.active : 0;
  const reviewN = Number.isFinite(catCounts.inReview) ? catCounts.inReview : 0;
  return Menu.buildFromTemplate([
    {
      label: 'New Cat',
      accelerator: process.platform === 'darwin' ? 'Command+Shift+C' : 'Control+Shift+C',
      click: () => {
        void handleNewCatShortcut('menu');
      },
    },
    {
      label: `Active cats: ${activeN}`,
      enabled: false,
    },
    {
      label: `In review: ${reviewN}`,
      enabled: false,
    },
    {
      label: 'Clear finished cats',
      enabled: reviewN > 0,
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('clear-finished-cats');
        }
      },
    },
    {
      label: 'Show Cats',
      type: 'checkbox',
      checked: catsVisible,
      click: (menuItem) => {
        setCatsVisible(menuItem.checked);
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
  return Menu.buildFromTemplate([
    {
      label: 'agent-UI',
      submenu: [
        {
          label: 'New Cat',
          accelerator: process.platform === 'darwin' ? 'Command+Shift+C' : 'Control+Shift+C',
          click: () => {
            void handleNewCatShortcut('shortcut');
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
  const trayPng = path.join(getPackageRoot(), 'assets', 'tray.png');
  const iconPng = path.join(getPackageRoot(), 'assets', 'icon.png');
  let image;
  let imageIsEmpty = false;
  if (fs.existsSync(iconPng)) {
    const source = nativeImage.createFromPath(iconPng);
    // macOS menu bar icons render at ~22pt; resizing avoids a giant blurry icon.
    image = source.isEmpty() ? source : source.resize({ width: 22, height: 22, quality: 'best' });
  } else if (fs.existsSync(trayPng)) {
    // Electron auto-picks up assets/tray@2x.png for retina when it's siblings.
    image = nativeImage.createFromPath(trayPng);
  } else {
    // 1×1 transparent PNG so Tray always has a valid image
    const onePx =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    image = nativeImage.createFromBuffer(Buffer.from(onePx, 'base64'));
    imageIsEmpty = true;
  }
  if (process.platform === 'darwin' && !image.isEmpty()) {
    // Treat as a template image so macOS tints it for light/dark menu bars.
    image.setTemplateImage(true);
  }
  tray = new Tray(image);
  // Always give the tray some visible text on macOS. This does two things:
  //   1. Belt-and-suspenders fallback if the icon asset is missing/empty.
  //   2. Widens the tray item so it's less likely to be hidden by the notch
  //      or a crowded menu bar (macOS drops menu bar extras that can't fit).
  // The title is kept in sync with live counts by `updateTrayTitle()`.
  if (process.platform === 'darwin') {
    updateTrayTitle({ forceFallback: imageIsEmpty });
  }
  tray.setToolTip('agent-UI');
  rebuildAppMenus();
}

function updateTrayTitle({ forceFallback = false } = {}) {
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
    // No cats — if we have a visible icon, keep text empty so we don't clutter
    // the menu bar. If the icon is empty (asset missing), always show a glyph
    // so the tray is still clickable.
    title = forceFallback ? '🐱' : '';
  }
  tray.setTitle(title);
}

function handleNewCatShortcut(source = 'shortcut') {
  const modalContextId = randomUUID();
  activeModalContextId = modalContextId;
  const ctx = {
    id: modalContextId,
    source,
    context: null,
    promise: null,
    createdAt: Date.now(),
  };
  ctx.promise = capturePointerContext(source, modalContextId)
    .then((context) => {
      ctx.context = context;
      return context;
    })
    .catch(() => null);
  modalContexts.set(modalContextId, ctx);
  recordTrace('shortcut_received', { source, modalContextId });
  openNewCatModal(modalContextId);
}

/** Translate active window to overlay-local coords; exclude our own app window. */
async function getFrontmostWindowBoundsInOverlay() {
  const { activeWindow } = await import('get-windows');
  const win = await activeWindow({
    accessibilityPermission: false,
    screenRecordingPermission: false,
  });
  if (!win || !win.bounds) return null;
  if (win.owner && win.owner.processId === process.pid) return null;
  return clipScreenBoundsToOverlayLocal({
    x: win.bounds.x,
    y: win.bounds.y,
    width: win.bounds.width,
    height: win.bounds.height,
  });
}

function getFrontmostWindowInfo() {
  if (!activeWindowState.id || !activeWindowState.screenBounds) {
    return { id: null, bounds: null, stableMs: 0 };
  }
  const bounds = clipScreenBoundsToOverlayLocal(activeWindowState.screenBounds);
  if (!bounds) {
    return { id: null, bounds: null, stableMs: 0 };
  }
  const stableMs = Math.max(0, Date.now() - activeWindowState.firstSeenAt);
  return { id: activeWindowState.id, bounds, stableMs };
}

async function osascriptLines(script) {
  if (process.platform !== 'darwin') return [];
  try {
    const text = await execFileText('osascript', ['-e', script], { timeout: 2500 });
    return text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function getAppSpecificPointerContext(bundleId, appName) {
  const bid = String(bundleId || '').toLowerCase();
  const name = String(appName || '').toLowerCase();
  if (bid === 'com.google.chrome' || name.includes('chrome')) {
    const lines = await osascriptLines(
      'tell application "Google Chrome" to if (count of windows) > 0 then return (title of active tab of front window) & "\\n" & (URL of active tab of front window)'
    );
    return { chromeTitle: lines[0] || '', chromeUrl: lines[1] || '' };
  }
  if (bid === 'com.apple.preview' || name.includes('preview')) {
    const lines = await osascriptLines(
      'tell application "Preview" to if (count of documents) > 0 then return (name of front document) & "\\n" & (path of front document)'
    );
    return { previewDocumentName: lines[0] || '', previewDocumentPath: lines[1] || '' };
  }
  if (bid === 'com.apple.mail' || name === 'mail') {
    const lines = await osascriptLines(
      'tell application "Mail" to if (count of outgoing messages) > 0 then return (subject of item 1 of outgoing messages)'
    );
    return { mailFrontDraftSubject: lines[0] || '' };
  }
  if (bid === 'md.obsidian' || name.includes('obsidian')) {
    return { obsidianHint: 'Obsidian is frontmost; inspect the selected agent-UI eval folder for the disposable vault.' };
  }
  if (bid === 'net.ankiweb.launcher' || name.includes('anki')) {
    return { ankiHint: 'Anki is frontmost; benchmark runs with an isolated ANKI_BASE.' };
  }
  if (bid === 'com.apple.garageband10' || name.includes('garageband')) {
    return { garageBandHint: 'GarageBand is frontmost; benchmark project files live in the selected agent-UI eval folder.' };
  }
  return {};
}

function screenshotRectFromBounds(bounds) {
  if (!bounds) return null;
  const x = Math.max(0, Math.floor(Number(bounds.x) || 0));
  const y = Math.max(0, Math.floor(Number(bounds.y) || 0));
  const width = Math.max(1, Math.floor(Number(bounds.width) || 0));
  const height = Math.max(1, Math.floor(Number(bounds.height) || 0));
  return { x, y, width, height };
}

async function captureContextScreenshot(bounds) {
  if (process.platform !== 'darwin') return null;
  if (process.env.AGENT_UI_CONTEXT_CAPTURE !== '1' && process.env.AGENT_UI_EVAL !== '1') return null;
  const rect = screenshotRectFromBounds(bounds);
  if (!rect) return null;
  try {
    const dir = path.join(evalRunDir, 'context');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `shortcut-${Date.now()}.png`);
    await execFileText('screencapture', [
      '-x',
      '-R',
      `${rect.x},${rect.y},${rect.width},${rect.height}`,
      file,
    ], { timeout: 5000 });
    return file;
  } catch {
    return null;
  }
}

async function capturePointerContext(reason = 'shortcut', modalContextId = null) {
  const captureStartedAt = Date.now();
  recordTrace('pointer_context_capture_started', { modalContextId: modalContextId || null, reason });
  const cursor = screen.getCursorScreenPoint();
  let active = null;
  let usedExternalSnapshot = false;
  try {
    const { activeWindow } = await import('get-windows');
    active = await activeWindow({
      accessibilityPermission: false,
      screenRecordingPermission: false,
    });
  } catch {
    active = null;
  }
  if (active && active.owner && active.owner.processId === process.pid && lastExternalWindowSnapshot) {
    active = lastExternalWindowSnapshot;
    usedExternalSnapshot = true;
  }
  const owner = active && active.owner ? active.owner : {};
  const bounds = active && active.bounds ? {
    x: active.bounds.x,
    y: active.bounds.y,
    width: active.bounds.width,
    height: active.bounds.height,
  } : null;
  const bundleId = owner.bundleId || owner.bundleIdentifier || '';
  const appName = owner.name || owner.path || '';
  const appContextStartedAt = Date.now();
  const appContext = await getAppSpecificPointerContext(bundleId, appName);
  recordTrace('pointer_app_context_captured', {
    modalContextId: modalContextId || null,
    activeApp: { name: appName, bundleId, processId: owner.processId || null },
    durationMs: Date.now() - appContextStartedAt,
  });
  const screenshotStartedAt = Date.now();
  const screenshotPath = await captureContextScreenshot(bounds);
  recordTrace('pointer_screenshot_captured', {
    modalContextId: modalContextId || null,
    hasScreenshot: !!screenshotPath,
    durationMs: Date.now() - screenshotStartedAt,
  });
  const context = {
    modalContextId: modalContextId || null,
    reason,
    capturedAt: new Date().toISOString(),
    cursor,
    activeApp: {
      name: appName,
      bundleId,
      processId: owner.processId || null,
    },
    activeWindow: active
      ? {
          title: active.title || '',
          id: active.id || null,
          bounds,
        }
      : null,
    screenshotPath,
    evalRunId: evalTraceEnabled ? evalRunId : null,
    usedExternalSnapshot,
    ...appContext,
  };
  recordTrace('pointer_context_captured', {
    modalContextId: modalContextId || null,
    reason,
    activeApp: context.activeApp,
    activeWindow: context.activeWindow,
    screenshotPath,
    durationMs: Date.now() - captureStartedAt,
  });
  return context;
}

ipcMain.handle('get-app-path', () => getPackageRoot());
ipcMain.handle('get-frontmost-window-bounds', getFrontmostWindowBoundsInOverlay);
ipcMain.handle('get-frontmost-window-info', () => getFrontmostWindowInfo());

ipcMain.on('overlay-ready', () => {
  overlayReady = true;
  flushPendingSpawnCats();
});

ipcMain.handle('read-text-file', (_event, relPath) => {
  const full = assertPathInsideApp(relPath);
  return fs.readFileSync(full, 'utf8');
});

ipcMain.handle('get-asset-file-url', (_event, relPath) => {
  const full = assertPathInsideApp(relPath);
  const ext = path.extname(full).toLowerCase();
  const mime =
    ext === '.png'
      ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.webp'
            ? 'image/webp'
            : 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`;
});

ipcMain.handle('choose-folder', async () => {
  const win =
    (modalWindow && !modalWindow.isDestroyed() && modalWindow) ||
    (conversationWindow && !conversationWindow.isDestroyed() && conversationWindow) ||
    undefined;
  const result = await dialog.showOpenDialog(win || undefined, {
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths || !result.filePaths.length) {
    return null;
  }
  return result.filePaths[0];
});

function getAgentUIConfigDir() {
  const configured = String(process.env.AGENT_UI_CONFIG_DIR || '').trim();
  const dir = configured ? path.resolve(configured) : path.join(os.homedir(), '.agent-ui');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getEvalWorkspaceRoot() {
  if (process.env.AGENT_UI_EVAL !== '1') return null;
  return path.join(evalRunDir, 'workspace');
}

function isPathInside(childPath, parentPath) {
  const child = path.resolve(String(childPath || ''));
  const parent = path.resolve(String(parentPath || ''));
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function isEvalAllowedFolder(folder) {
  const root = getEvalWorkspaceRoot();
  if (!root) return true;
  const f = path.resolve(String(folder || ''));
  return isPathInside(f, root);
}

function getRecentFoldersPath() {
  const dir = getAgentUIConfigDir();
  return path.join(dir, 'recent_folders.json');
}

ipcMain.handle('get-recent-folders', () => {
  try {
    const file = getRecentFoldersPath();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    // ignore
  }
  return [];
});

ipcMain.handle('add-recent-folder', (_event, folder) => {
  if (!folder) return;
  try {
    const file = getRecentFoldersPath();
    let folders = [];
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) folders = data;
    }
    // Remove if exists
    folders = folders.filter(f => f !== folder);
    // Add to top
    folders.unshift(folder);
    // Keep top 20
    folders = folders.slice(0, 20);
    fs.writeFileSync(file, JSON.stringify(folders, null, 2), 'utf8');
  } catch (e) {
    // ignore
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForModalPointerContext(modalContextId) {
  const key = modalContextId ? String(modalContextId) : '';
  const ctx = key ? modalContexts.get(key) : null;
  if (!ctx) return null;
  if (ctx.context) return ctx.context;
  try {
    await Promise.race([ctx.promise, delay(2500)]);
  } catch {
    /* ignore context capture errors */
  }
  return ctx.context || null;
}

async function startCatRunFromPayload(payload = {}, opts = {}) {
  const catId = opts.catId ? String(opts.catId) : randomUUID();
  const modalContextId =
    (opts.modalContextId && String(opts.modalContextId)) ||
    (payload && payload.modalContextId ? String(payload.modalContextId) : '') ||
    activeModalContextId ||
    '';
  const submitStartedAt = Date.now();
  const pointerWaitStartedAt = Date.now();
  const pointerContext = opts.pointerContext || (await waitForModalPointerContext(modalContextId)) || null;
  recordTrace('submit_pointer_context_ready', {
    catId,
    modalContextId: modalContextId || null,
    hasPointerContext: !!pointerContext,
    waitMs: Date.now() - pointerWaitStartedAt,
  });
  const runtime = 'local';
  const modelId = 'hermes-cli';
  if (!isEvalAllowedFolder(payload && payload.folder)) {
    const folder = String((payload && payload.folder) || '');
    const error = `Eval local folder is outside the disposable workspace: ${folder}`;
    recordTrace('submit_rejected', {
      catId,
      modalContextId: modalContextId || null,
      reason: 'folder_outside_eval_workspace',
      folder,
      evalWorkspaceRoot: getEvalWorkspaceRoot(),
    });
    return { ok: false, error };
  }
  recordTrace('submit_requested', {
    catId,
    modalContextId: modalContextId || null,
    promptLength: payload && payload.prompt ? String(payload.prompt).length : 0,
    runtime,
    hasPointerContext: !!pointerContext,
    folder: payload && payload.folder ? String(payload.folder) : '',
  });
  const out = { ...payload, catId, model: modelId, runtime, modalContextId, pointerContext };
  if (opts.closeModal !== false && modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }
  recordTrace('cat_spawn_sent', {
    catId,
    modalContextId: modalContextId || null,
    runtime,
    msSinceSubmitStart: Date.now() - submitStartedAt,
  });
  sendSpawnCatToOverlay(out);
  startAgentForCat(
    {
      catId,
      folder: payload.folder,
      prompt: payload.prompt,
      model: modelId,
      runtime,
      pointerContext,
    },
    { getMainWindow: () => mainWindow }
  );
  return { ok: true, catId, modelId: modelId || null, runtime };
}

ipcMain.on('new-cat-submit', (_event, payload) => {
  void startCatRunFromPayload(payload, { closeModal: true });
});

ipcMain.on('new-cat-cancel', () => {
  if (modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }
});

ipcMain.on('resize-modal', (_event, { height } = {}) => {
  // No-op: modal is now a static 500px height
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

ipcMain.on('open-cat-conversation', (_e, { catId } = {}) => {
  if (!catId) return;
  const id = String(catId);
  if (id.startsWith('ide:')) {
    activateCursorApp();
    return;
  }
  openConversationWindow(id);
});

ipcMain.on('close-conversation-window', () => {
  if (conversationWindow && !conversationWindow.isDestroyed()) {
    conversationWindow.close();
  }
});

ipcMain.on('dismiss-cat', async (_e, { catId } = {}) => {
  if (!catId) return;
  const id = String(catId);
  if (id.startsWith('ide:')) {
    removeIdeCatIfPresent(id, { getMainWindow: () => mainWindow, log: console });
    if (conversationWindow && !conversationWindow.isDestroyed()) {
      conversationWindow.close();
    }
    return;
  }
  await dismissAgent(id, { getMainWindow: () => mainWindow, log: console });
  if (conversationWindow && !conversationWindow.isDestroyed()) {
    conversationWindow.close();
  }
});

ipcMain.on('agent-followup', (_e, { catId, text } = {}) => {
  if (!catId) return;
  if (String(catId).startsWith('ide:')) {
    return;
  }
  sendFollowup(String(catId), text, { getMainWindow: () => mainWindow, log: console });
});

ipcMain.handle('get-agent-conversation', (_e, catId) => getAgentConversation(catId));

ipcMain.handle('revert-cat-changes', async (_e, { catId } = {}) => {
  if (!catId) return { ok: false, error: 'missing cat id' };
  const id = String(catId);
  if (id.startsWith('ide:')) {
    return { ok: false, error: 'Revert is not available for this cat.' };
  }
  const c = getAgentConversation(id);
  if (!c.found || !c.folder) {
    return { ok: false, error: 'Conversation not found.' };
  }
  const parent =
    (conversationWindow && !conversationWindow.isDestroyed() && conversationWindow) ||
    (mainWindow && !mainWindow.isDestroyed() && mainWindow) ||
    undefined;
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    message: 'Revert all changes this cat made?',
    detail: `This will restore the folder to how it was when the cat was spawned:\n\n${c.folder}\n\nThis cannot be undone.`,
    buttons: ['Cancel', 'Revert'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) {
    return { ok: false, cancelled: true };
  }
  return revertAgentChanges(id, { log: console });
});

ipcMain.handle('open-external-url', async (_e, url) => {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, error: 'invalid url' };
  }
  const u = url.trim();
  if (!/^file:/i.test(u) && !/^https:/i.test(u)) {
    return { ok: false, error: 'unsupported url scheme' };
  }
  try {
    await shell.openExternal(u);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

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
        const selected = document.querySelector('.recent-folder-item.selected');
        out.selectedFolderPath = (document.body && document.body.dataset ? document.body.dataset.selectedFolder : '') || (selected && selected.dataset ? selected.dataset.folder : '') || '';
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
    selectedFolderRowRects: '.recent-folder-item.selected[]',
  });
  const conversation = await readDomEvalTargets(conversationWindow, {
    logRect: '#log',
    followupRect: '#followup-input',
    revertButtonRect: '#btn-revert',
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
  const helper = path.join(getPackageRoot(), 'eval', 'human-e2e', 'swift', 'AgentUISpeech.swift');
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
      revert: async ({ catId } = {}) => {
        if (!catId) return { ok: false, error: 'missing cat id' };
        const result = await revertAgentChanges(String(catId), { log: console });
        recordTrace('cleanup_revert_completed', { catId: String(catId), ok: !!result.ok });
        return result;
      },
      dismiss: async ({ catId } = {}) => {
        if (!catId) return { ok: false, error: 'missing cat id' };
        await dismissAgent(String(catId), { getMainWindow: () => mainWindow, log: console });
        recordTrace('cleanup_dismiss_completed', { catId: String(catId), ok: true });
        return { ok: true };
      },
      cancel: async ({ catId } = {}) => {
        if (!catId) return { ok: false, error: 'missing cat id' };
        const result = await cancelAgent(String(catId), { getMainWindow: () => mainWindow, log: console });
        recordTrace('cleanup_cancel_completed', { catId: String(catId), ok: !!result.ok });
        return result;
      },
      shutdown: () => app.quit(),
    },
    console
  );

  void startHookServer({
    onIdeSessionStart: (p) => handleIdeSessionStart(p, { getMainWindow: () => mainWindow, log: console }),
    onIdeSessionEnd: (p) => handleIdeSessionEnd(p, { getMainWindow: () => mainWindow, log: console }),
    log: console,
  })
    .then((h) => {
      closeHookServer = h && h.closeSync ? h.closeSync : null;
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[agent-ui] hook server failed to start', e);
    });

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

  void tickActiveWindowTracker();
  setInterval(() => {
    void tickActiveWindowTracker();
  }, 1000);

  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!lastCatScreenRects.length) {
      if (mainWindowMouseable) {
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
        mainWindowMouseable = false;
      }
      return;
    }
    const p = screen.getCursorScreenPoint();
    let over = false;
    for (const b of lastCatScreenRects) {
      if (p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom) {
        over = true;
        break;
      }
    }
    if (over) {
      if (!mainWindowMouseable) {
        mainWindow.setIgnoreMouseEvents(false);
        mainWindowMouseable = true;
      }
    } else if (mainWindowMouseable) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      mainWindowMouseable = false;
    }
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
  if (typeof closeHookServer === 'function') {
    try {
      closeHookServer();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[agent-ui] hook server cleanup', e);
    }
    closeHookServer = null;
  }
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
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Keep app running (tray) on non-mac, or we could quit; plan expects tray+shortcut
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
