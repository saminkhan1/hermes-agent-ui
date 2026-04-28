function quietSdkLogsByDefault() {
  if (String(process.env.CURSORCATS_AGENT_LOG_VERBOSE || '').trim() === '1') {
    return;
  }
  process.env.RUST_LOG = 'error';
  process.env.LOG_LEVEL = 'warn';
  process.env.OTEL_LOG_LEVEL = 'error';
  process.env.DEBUG = '';

  installSdkLogStreamFilter();
}

/**
 * The Cursor SDK runs its own structured logger inside this process and writes
 * directly to stdout/stderr (`HH:MM:SS.mmm <LEVEL> ...meta={...}`). Those lines
 * cannot be silenced via env vars, so we filter them at the stream level. App
 * output (`console.*`, `[cursorcats] ...`) never matches and is preserved.
 */
function installSdkLogStreamFilter() {
  const lineRe = /^\d{1,2}:\d{2}:\d{2}\.\d{3}\s+(DEBUG|TRACE|INFO|WARN|ERROR)\s+/;
  const shouldDrop = (line) => {
    if (!line) return false;
    if (lineRe.test(line)) return true;
    return (
      line.includes('cursorMcp:') ||
      line.includes('mcp_http_exchange') ||
      line.includes('mcp_oauth_')
    );
  };
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream || stream.__cursorcatsFiltered) continue;
    const original = stream.write.bind(stream);
    let pending = '';
    stream.write = (chunk, encoding, cb) => {
      try {
        const text =
          typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
        pending += text;
        let out = '';
        let idx;
        while ((idx = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          if (!shouldDrop(line)) out += `${line}\n`;
        }
        if (out) original(out, encoding, cb);
        else if (typeof cb === 'function') cb();
        return true;
      } catch {
        return original(chunk, encoding, cb);
      }
    };
    stream.__cursorcatsFiltered = true;
  }
}

quietSdkLogsByDefault();

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
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const {
  startAgentForCat,
  cancelAllAgents,
  getAgentConversation,
  setOnConversationPushed,
  dismissAgent,
  sendFollowup,
  revertAgentChanges,
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
/** Opening a modal child temporarily clears `setVisibleOnAllWorkspaces` on the overlay (stacking/focus on macOS); restore when the modal closes. */
let mainWindowWasVisibleOnAllWorkspaces = false;
/** Latest overlay cat counts from renderer (dock / tray menu). */
let catCounts = { active: 0, inReview: 0 };
let overlayReady = false;
const pendingSpawnCats = [];

/** Tracked for frontmost window stability (used by get-frontmost-window-info). */
let activeWindowState = { id: null, firstSeenAt: 0, screenBounds: null };
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

function openNewCatModal() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (conversationWindow && !conversationWindow.isDestroyed()) {
    conversationWindow.close();
  }

  if (modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.focus();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
    return;
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
    parent: mainWindow,
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

  modalWindow.once('ready-to-show', () => {
    modalWindow.show();
    modalWindow.focus();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
  });

  modalWindow.on('closed', () => {
    modalWindow = null;
    restoreMainWindowAllWorkspaces();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/?$/, '');
    modalWindow.loadURL(`${base}/modal.html`);
  } else {
    modalWindow.loadFile(path.join(__dirname, '../renderer/modal.html'));
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
    parent: mainWindow,
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

  conversationWindow.once('ready-to-show', () => {
    conversationWindow.show();
    conversationWindow.focus();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
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
        openNewCatModal();
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

function rebuildAppMenus() {
  const menu = buildAppMenu();
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(menu);
  }
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
  tray.setToolTip('CursorCats');
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
  return pathToFileURL(full).href;
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

function getRecentFoldersPath() {
  const dir = path.join(os.homedir(), '.cursorcats');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

const FALLBACK_MODEL_LIST = [{ id: 'composer-2', displayName: 'Composer 2', description: '' }];

function getModelSelectionPath() {
  const dir = path.join(os.homedir(), '.cursorcats');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'model.json');
}

function getRuntimeSelectionPath() {
  const dir = path.join(os.homedir(), '.cursorcats');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'runtime.json');
}

function getCloudRepositorySelectionPath() {
  const dir = path.join(os.homedir(), '.cursorcats');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'cloud_repository.json');
}

function normalizeRuntime(value) {
  return String(value || '').trim().toLowerCase() === 'cloud' ? 'cloud' : 'local';
}

ipcMain.handle('list-models', async () => {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return FALLBACK_MODEL_LIST;
  }
  try {
    const { Cursor } = require('@cursor/sdk');
    const models = await Cursor.models.list({ apiKey });
    if (!Array.isArray(models) || models.length === 0) {
      return FALLBACK_MODEL_LIST;
    }
    return models.map((m) => ({
      id: String(m.id),
      displayName: (m.displayName && String(m.displayName)) || String(m.id),
      description: m.description != null ? String(m.description) : '',
    }));
  } catch (e) {
    console.warn('list-models failed', e);
    return FALLBACK_MODEL_LIST;
  }
});

ipcMain.handle('get-selected-model', () => {
  try {
    const file = getModelSelectionPath();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data.id === 'string' && data.id.trim()) {
        return { id: data.id.trim() };
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
});

ipcMain.handle('set-selected-model', (_event, modelId) => {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id) return;
  try {
    const file = getModelSelectionPath();
    fs.writeFileSync(file, JSON.stringify({ id }, null, 2), 'utf8');
  } catch (e) {
    // ignore
  }
});

ipcMain.handle('list-cloud-repositories', async () => {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return [];
  }
  try {
    const { Cursor } = require('@cursor/sdk');
    const repos = await Cursor.repositories.list({ apiKey });
    if (!Array.isArray(repos)) return [];
    return repos
      .map((r) => {
        const url = r && r.url != null ? String(r.url).trim() : '';
        return url ? { url } : null;
      })
      .filter(Boolean);
  } catch (e) {
    console.warn('list-cloud-repositories failed', e);
    return [];
  }
});

ipcMain.handle('get-selected-runtime', () => {
  try {
    const file = getRuntimeSelectionPath();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { runtime: normalizeRuntime(data && data.runtime) };
    }
  } catch (e) {
    // ignore
  }
  return { runtime: 'local' };
});

ipcMain.handle('set-selected-runtime', (_event, runtime) => {
  try {
    const file = getRuntimeSelectionPath();
    fs.writeFileSync(file, JSON.stringify({ runtime: normalizeRuntime(runtime) }, null, 2), 'utf8');
  } catch (e) {
    // ignore
  }
});

ipcMain.handle('get-selected-cloud-repository', () => {
  try {
    const file = getCloudRepositorySelectionPath();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const url = data && typeof data.url === 'string' ? data.url.trim() : '';
      const startingRef = data && typeof data.startingRef === 'string' ? data.startingRef.trim() : '';
      if (url) return { url, startingRef };
    }
  } catch (e) {
    // ignore
  }
  return null;
});

ipcMain.handle('set-selected-cloud-repository', (_event, repo) => {
  const url = repo && typeof repo.url === 'string' ? repo.url.trim() : '';
  const startingRef = repo && typeof repo.startingRef === 'string' ? repo.startingRef.trim() : '';
  if (!url) return;
  try {
    const file = getCloudRepositorySelectionPath();
    fs.writeFileSync(file, JSON.stringify({ url, startingRef }, null, 2), 'utf8');
  } catch (e) {
    // ignore
  }
});

ipcMain.on('new-cat-submit', (_event, payload) => {
  const catId = randomUUID();
  const modelRaw = payload && payload.model;
  const modelId =
    typeof modelRaw === 'string' && modelRaw.trim() ? modelRaw.trim() : null;
  if (modelId) {
    try {
      const file = getModelSelectionPath();
      fs.writeFileSync(file, JSON.stringify({ id: modelId }, null, 2), 'utf8');
    } catch (e) {
      // ignore
    }
  }
  const runtime = normalizeRuntime(payload && payload.runtime);
  try {
    const file = getRuntimeSelectionPath();
    fs.writeFileSync(file, JSON.stringify({ runtime }, null, 2), 'utf8');
  } catch (e) {
    // ignore
  }
  const cloudRepo =
    payload && payload.cloudRepo && typeof payload.cloudRepo === 'object'
      ? {
          url: typeof payload.cloudRepo.url === 'string' ? payload.cloudRepo.url.trim() : '',
          startingRef:
            typeof payload.cloudRepo.startingRef === 'string' ? payload.cloudRepo.startingRef.trim() : '',
        }
      : null;
  if (runtime === 'cloud' && cloudRepo && cloudRepo.url) {
    try {
      const file = getCloudRepositorySelectionPath();
      fs.writeFileSync(file, JSON.stringify(cloudRepo, null, 2), 'utf8');
    } catch (e) {
      // ignore
    }
  }
  const out = { ...payload, catId };
  if (modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }
  sendSpawnCatToOverlay(out);
  startAgentForCat(
    {
      catId,
      folder: payload.folder,
      prompt: payload.prompt,
      model: modelId || undefined,
      runtime,
      cloudRepo,
    },
    { getMainWindow: () => mainWindow }
  );
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

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }
  if (!process.env.CURSOR_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn(
      'CURSOR_API_KEY is not set. New cats will appear briefly and disappear; set the env var to run agents.'
    );
  }
  createWindow();
  createTray();

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
      console.warn('[cursorcats] hook server failed to start', e);
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
    process.platform === 'darwin' ? 'Command+Shift+C' : 'Control+Shift+C';
  globalShortcut.register(newCatAccelerator, () => {
    openNewCatModal();
  });
});

app.on('will-quit', () => {
  if (typeof closeHookServer === 'function') {
    try {
      closeHookServer();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cursorcats] hook server cleanup', e);
    }
    closeHookServer = null;
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
