const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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
  setOnConversationPushed,
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

const IS_MAC = process.platform === 'darwin';
const MAC_FULL_SCREEN_WORKSPACE_OPTIONS = {
  visibleOnFullScreen: true,
  skipTransformProcessType: true,
};
const PET_OVERLAY_WINDOW_LEVEL = 'floating';
const FOCUSED_OVERLAY_WINDOW_LEVEL = 'modal-panel';
const CUSTOM_PET_PREFIX = 'custom:';
const PET_MANIFEST_FILE = 'pet.json';
const LEGACY_AVATAR_MANIFEST_FILE = 'avatar.json';
const PET_DEFAULT_SPRITESHEET = 'spritesheet.webp';
const PET_SPRITESHEET_WIDTH = 1536;
const PET_SPRITESHEET_HEIGHT = 1872;
const PET_DRAG_DISPLAY_HYSTERESIS = 24;
const PET_MOMENTUM_INTERVAL_MS = 16;
const PET_MOMENTUM_DECAY = 0.88;
const PET_MOMENTUM_STOP_SPEED = 65;
const PET_MOMENTUM_MAX_DURATION_MS = 900;
const FALLBACK_PET_CHARACTER_ID = `${CUSTOM_PET_PREFIX}goblin`;

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

function bufferToDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function readJsonFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data && typeof data === 'object' ? data : {};
}

function safeManifestString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathInsideDirectory(file, dir) {
  const relative = path.relative(dir, file);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolvePetSpritesheetPath(packageDir, manifest) {
  const rel = safeManifestString(manifest.spritesheetPath) || PET_DEFAULT_SPRITESHEET;
  const resolved = path.resolve(packageDir, rel);
  return pathInsideDirectory(resolved, packageDir) ? resolved : null;
}

function readPngDimensions(buffer) {
  if (
    buffer.length < 24 ||
    buffer[0] !== 0x89 ||
    buffer.toString('ascii', 1, 4) !== 'PNG' ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readUint24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function readWebpDimensions(buffer) {
  if (
    buffer.length < 16 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (data + size > buffer.length) return null;
    if (type === 'VP8X' && size >= 10) {
      return {
        width: readUint24LE(buffer, data + 4) + 1,
        height: readUint24LE(buffer, data + 7) + 1,
      };
    }
    if (type === 'VP8L' && size >= 5 && buffer[data] === 0x2f) {
      const b1 = buffer[data + 1];
      const b2 = buffer[data + 2];
      const b3 = buffer[data + 3];
      const b4 = buffer[data + 4];
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
    }
    if (
      type === 'VP8 ' &&
      size >= 10 &&
      buffer[data + 3] === 0x9d &&
      buffer[data + 4] === 0x01 &&
      buffer[data + 5] === 0x2a
    ) {
      return {
        width: buffer.readUInt16LE(data + 6) & 0x3fff,
        height: buffer.readUInt16LE(data + 8) & 0x3fff,
      };
    }
    offset = data + size + (size % 2);
  }
  return null;
}

function spritesheetMimeType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return '';
}

function readSpritesheetDimensions(file, buffer) {
  const mimeType = spritesheetMimeType(file);
  if (mimeType === 'image/png') return readPngDimensions(buffer);
  if (mimeType === 'image/webp') return readWebpDimensions(buffer);
  return null;
}

function loadPetPackage(packageDir, manifestFile) {
  const manifestPath = path.join(packageDir, manifestFile);
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = readJsonFile(manifestPath);
  const spritesheetPath = resolvePetSpritesheetPath(packageDir, manifest);
  if (!spritesheetPath || !fs.existsSync(spritesheetPath)) return null;
  const buffer = fs.readFileSync(spritesheetPath);
  const dimensions = readSpritesheetDimensions(spritesheetPath, buffer);
  if (
    !dimensions ||
    dimensions.width !== PET_SPRITESHEET_WIDTH ||
    dimensions.height !== PET_SPRITESHEET_HEIGHT
  ) return null;
  const directoryId = path.basename(packageDir);
  const id = `${CUSTOM_PET_PREFIX}${directoryId}`;
  const displayName = safeManifestString(manifest.displayName) || safeManifestString(manifest.id) || directoryId;
  const description = manifest.description == null ? '' : safeManifestString(manifest.description);
  return {
    assetRef: 'codex',
    description,
    displayName,
    id,
    label: displayName,
    sourceDirectory: packageDir,
    spriteUrl: bufferToDataUrl(buffer, spritesheetMimeType(spritesheetPath)),
  };
}

function scanPetPackageRoot(rootDir, manifestFile, { create = false } = {}) {
  try {
    if (create) ensureDir(rootDir);
    if (!fs.existsSync(rootDir)) return [];
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return loadPetPackage(path.join(rootDir, entry.name), manifestFile);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    console.warn('[agent-ui] pet package scan failed', rootDir, e && e.message ? e.message : e);
    return [];
  }
}

function loadPetCharacterOptions() {
  const codexHome = getCodexHomeDir();
  const packageRoot = getPackageRoot();
  const byId = new Map();
  const roots = [
    { dir: path.join(packageRoot, 'assets', 'pets'), manifestFile: PET_MANIFEST_FILE, create: false },
    { dir: path.join(codexHome, 'avatars'), manifestFile: LEGACY_AVATAR_MANIFEST_FILE, create: false },
    { dir: path.join(codexHome, 'pets'), manifestFile: PET_MANIFEST_FILE, create: true },
  ];
  for (const root of roots) {
    for (const pet of scanPetPackageRoot(root.dir, root.manifestFile, { create: root.create })) {
      byId.set(pet.id, pet);
    }
  }
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function petCharactersPayload() {
  return {
    id: selectedPetCharacterId,
    options: petCharacterOptions.map((pet) => ({
      assetRef: pet.assetRef,
      description: pet.description,
      displayName: pet.displayName,
      id: pet.id,
      label: pet.label,
      spriteUrl: pet.spriteUrl,
    })),
  };
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
const evalUiSnapshots = new Map();
let lastExternalWindowSnapshot = null;
let activeWindowPollTimer = null;
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

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
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

  const modalBounds = centeredWindowBounds(680, 240, launchDisplayForModal(modalContextId));

  modalWindow = new BrowserWindow({
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
  applyOverlayWindowPolicy(modalWindow, { level: FOCUSED_OVERLAY_WINDOW_LEVEL });

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
    conversationWindow.setBounds(
      centeredWindowBounds(CONVERSATION_WINDOW_SIDE, CONVERSATION_WINDOW_SIDE, displayForPetOrCursor()),
      false
    );
    applyOverlayWindowPolicy(conversationWindow, { level: FOCUSED_OVERLAY_WINDOW_LEVEL });
    conversationWindow.show();
    conversationWindow.focus();
    conversationWindow.webContents.focus();
    return;
  }

  const conversationBounds = centeredWindowBounds(
    CONVERSATION_WINDOW_SIDE,
    CONVERSATION_WINDOW_SIDE,
    displayForPetOrCursor()
  );

  conversationWindow = new BrowserWindow({
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
      webSecurity: false,
    },
  });
  applyOverlayWindowPolicy(conversationWindow, { level: FOCUSED_OVERLAY_WINDOW_LEVEL });

  closeWindowOnEscape(conversationWindow, () => {
    if (conversationWindow && !conversationWindow.isDestroyed()) {
      conversationWindow.close();
    }
  });

  conversationWindow.once('ready-to-show', () => {
    conversationWindow.show();
    conversationWindow.moveTop();
    conversationWindow.focus();
    conversationWindow.webContents.focus();
  });

  conversationWindow.on('closed', () => {
    conversationWindow = null;
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
  sendPetCharacterToRenderer();
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

ipcMain.on('pet-overlay-toggle', () => {
  togglePetOverlay();
});

ipcMain.handle('get-pet-characters', () => {
  return petCharactersPayload();
});

ipcMain.on('pet-characters-refresh', () => {
  refreshPetCharacterOptions({ notify: true });
});

ipcMain.on('pet-context-menu', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  Menu.buildFromTemplate([
    {
      label: 'Close pet',
      click: () => closePetOverlay({ persist: true }),
    },
    { type: 'separator' },
    petCharacterMenuItem(),
    refreshPetMenuItem(),
    openPetFolderMenuItem(),
  ]).popup({ window: mainWindow });
});

ipcMain.on('pet-pointer-interaction-changed', (_event, payload = {}) => {
  setPetPointerInteraction(!!payload.active);
});

ipcMain.on('pet-drag-start', (_event, payload = {}) => {
  startPetDrag(payload);
});

ipcMain.on('pet-drag-move', () => {
  movePetDrag();
});

ipcMain.on('pet-drag-end', () => {
  endPetDrag();
});

ipcMain.on('pet-drag-release', (_event, payload = {}) => {
  throwPetWithVelocity(payload.velocityX, payload.velocityY);
});

ipcMain.on('pet-element-size-changed', (_event, payload = {}) => {
  if (!payload || typeof payload !== 'object') return;
  cancelPetMomentum();
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

ipcMain.on('eval-ui-state', (_event, payload = {}) => {
  if (!evalTraceEnabled || !payload || typeof payload !== 'object') return;
  const surface = String(payload.surface || '').trim();
  if (!surface) return;
  evalUiSnapshots.set(surface, {
    ...(payload.payload && typeof payload.payload === 'object' ? payload.payload : {}),
    reportedAt: Date.now(),
  });
});

app.whenReady().then(() => {
  app.setName('agent-UI');
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
  startActiveWindowTracker();

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
  cancelPetMomentum();
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
