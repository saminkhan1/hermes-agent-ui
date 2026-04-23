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
} = require('./agents');
const { startHookServer } = require('./hook-server');
const {
  handleIdeSessionStart,
  handleIdeSessionEnd,
  removeIdeCatIfPresent,
} = require('./ide-sessions');

function assertPathInsideApp(relPath) {
  const root = path.resolve(app.getAppPath());
  const full = path.resolve(path.join(root, relPath));
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('Path escapes app root');
  }
  return full;
}

let mainWindow;
let modalWindow;
let conversationWindow;
/** @type {null | (() => void)} */
let closeHookServer = null;
/** When true, the overlay is accepting mouse (cursor over a cat). */
let mainWindowMouseable = false;
let lastCatScreenRects = [];
let tray;
/** `setVisibleOnAllWorkspaces(true)` on the overlay breaks `app.dock.show()` after `dock.hide()` on macOS; restore when the modal closes. */
let mainWindowWasVisibleOnAllWorkspaces = false;
/** Latest overlay cat counts from renderer (dock / tray menu). */
let catCounts = { active: 0, inReview: 0 };

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
  lastCatScreenRects = [];
  mainWindowMouseable = false;

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
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
      app.dock?.show();
      app.focus({ steal: true });
    }
    return;
  }

  if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindowWasVisibleOnAllWorkspaces = true;
    mainWindow.setVisibleOnAllWorkspaces(false);
  }

  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }

  modalWindow = new BrowserWindow({
    width: 680,
    height: 200,
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
    if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed() && mainWindowWasVisibleOnAllWorkspaces) {
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      mainWindowWasVisibleOnAllWorkspaces = false;
    }
    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide();
    }
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
    conversationWindow.show();
    conversationWindow.focus();
    if (process.platform === 'darwin') {
      app.dock?.show();
      app.focus({ steal: true });
    }
    return;
  }

  if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindowWasVisibleOnAllWorkspaces = true;
    mainWindow.setVisibleOnAllWorkspaces(false);
  }
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }

  conversationWindow = new BrowserWindow({
    width: 680,
    height: 560,
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

  conversationWindow.once('ready-to-show', () => {
    conversationWindow.show();
    conversationWindow.focus();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
  });

  conversationWindow.on('closed', () => {
    conversationWindow = null;
    if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed() && mainWindowWasVisibleOnAllWorkspaces) {
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      mainWindowWasVisibleOnAllWorkspaces = false;
    }
    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide();
    }
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
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(menu);
  }
}

function createTray() {
  const trayPng = path.join(app.getAppPath(), 'assets', 'tray.png');
  const iconPng = path.join(app.getAppPath(), 'assets', 'icon.png');
  let image;
  let imageIsEmpty = false;
  if (fs.existsSync(trayPng)) {
    // Electron auto-picks up assets/tray@2x.png for retina when it's siblings.
    image = nativeImage.createFromPath(trayPng);
  } else if (fs.existsSync(iconPng)) {
    const source = nativeImage.createFromPath(iconPng);
    // macOS menu bar icons render at ~22pt; resizing avoids a giant blurry icon.
    image = source.isEmpty() ? source : source.resize({ width: 22, height: 22, quality: 'best' });
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

ipcMain.handle('get-app-path', () => app.getAppPath());
ipcMain.handle('get-frontmost-window-bounds', getFrontmostWindowBoundsInOverlay);
ipcMain.handle('get-frontmost-window-info', () => getFrontmostWindowInfo());

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

ipcMain.on('new-cat-submit', (_event, payload) => {
  const catId = randomUUID();
  const out = { ...payload, catId };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('spawn-cat', out);
  }
  startAgentForCat(
    { catId, folder: payload.folder, prompt: payload.prompt },
    { getMainWindow: () => mainWindow }
  );
  if (modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }
});

ipcMain.on('new-cat-cancel', () => {
  if (modalWindow && !modalWindow.isDestroyed()) {
    modalWindow.close();
  }
});

ipcMain.on('resize-modal', (_event, { height } = {}) => {
  if (!modalWindow || modalWindow.isDestroyed()) return;
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
  const display = screen.getDisplayMatching(modalWindow.getBounds());
  const maxHeight = Math.floor(display.workArea.height * 0.8);
  const clamped = Math.min(Math.max(Math.ceil(height), 120), maxHeight);
  const [w] = modalWindow.getContentSize();
  modalWindow.setContentSize(w, clamped);
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

app.whenReady().then(() => {
  if (!process.env.CURSOR_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn(
      'CURSOR_API_KEY is not set. New cats will appear briefly and disappear; set the env var to run agents.'
    );
  }
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
    if (fs.existsSync(iconPath)) {
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) {
        app.dock.setIcon(icon);
      }
    }
  }
  createWindow();
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }
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

  setOnConversationPushed(({ catId: _id }) => {
    if (conversationWindow && !conversationWindow.isDestroyed()) {
      conversationWindow.webContents.send('conversation-updated', { catId: _id });
    }
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
