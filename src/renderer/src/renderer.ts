import { rectForEvalElement } from './eval-ui-state.ts';
import type { AgentUIPayload } from '../../shared/contracts.ts';

const root = document.getElementById('pet-root');
const shell = document.getElementById('pet-shell');
const mascot = document.getElementById('pet-mascot');
const badgeEl = document.getElementById('pet-badge');
const tray = document.getElementById('pet-tray');
const trayList = document.getElementById('pet-tray-list');

const DEFAULT_LAYOUT = {
  mascot: { left: 244, top: 191, width: 112, height: 121 },
  placement: 'top-end',
  tray: { left: 80, top: 56, width: 276, height: 131 },
  viewport: { width: 356, height: 320 },
};

const STATUS_PRIORITY: Record<string, number> = {
  failed: 0,
  review: 1,
  running: 2,
  idle: 3,
};

const STATUS_META = {
  running: {
    badgeBackgroundColor: 'var(--color-token-activity-bar-badge-background)',
    badgeForegroundColor: 'var(--color-token-activity-bar-badge-foreground)',
    defaultBody: 'Thinking',
    icon: 'spinner',
    label: 'Running',
    mascotState: 'running',
  },
  failed: {
    badgeBackgroundColor: 'var(--color-token-error-foreground)',
    badgeForegroundColor: 'var(--color-token-bg-primary)',
    defaultBody: 'Blocked',
    icon: 'warning',
    label: 'Blocked',
    mascotState: 'failed',
  },
  review: {
    badgeBackgroundColor: 'var(--color-token-charts-green)',
    badgeForegroundColor: 'var(--color-token-bg-primary)',
    defaultBody: 'Ready',
    icon: 'check-circle',
    label: 'Ready',
    mascotState: 'review',
  },
  idle: {
    badgeBackgroundColor: 'var(--color-token-bg-primary)',
    badgeForegroundColor: 'var(--color-token-text-secondary)',
    defaultBody: 'Info',
    icon: 'clock',
    label: 'Info',
    mascotState: 'idle',
  },
};

const DEFAULT_PET_OPTIONS: LooseBoundaryValue[] = [];
const DEFAULT_PET_ID = 'custom:goblin';
const AVATAR_COLUMNS = 8;
const AVATAR_ROWS = 9;
const IDLE_FRAMES = [
  { rowIndex: 0, columnIndex: 0, frameDurationMs: 280 },
  { rowIndex: 0, columnIndex: 1, frameDurationMs: 110 },
  { rowIndex: 0, columnIndex: 2, frameDurationMs: 110 },
  { rowIndex: 0, columnIndex: 3, frameDurationMs: 140 },
  { rowIndex: 0, columnIndex: 4, frameDurationMs: 140 },
  { rowIndex: 0, columnIndex: 5, frameDurationMs: 320 },
];
const LONG_IDLE_FRAMES = IDLE_FRAMES.map((frame) => ({ ...frame, frameDurationMs: frame.frameDurationMs * 6 }));
const AVATAR_FRAMES: Record<string, LooseBoundaryValue[]> = {
  failed: linearFrames(5, 8, 140, 240),
  idle: IDLE_FRAMES,
  jumping: linearFrames(4, 5, 140, 280),
  review: linearFrames(8, 6, 150, 280),
  running: linearFrames(7, 6, 120, 220),
  'running-left': linearFrames(2, 8, 120, 220),
  'running-right': linearFrames(1, 8, 120, 220),
  waving: linearFrames(3, 4, 140, 280),
};

const VISIBLE_SCROLL_STEP = 2;
const SCROLL_EDGE_SLOP = 2;
const COLLAPSED_BODY_MAX_HEIGHT = 32;
const EXPANDED_BODY_MAX_HEIGHT = 512;
const DRAG_THRESHOLD_PX = 4;
const POINTER_HIT_REGION_SELECTOR = '[data-avatar-overlay-hit-region], [data-avatar-mascot="true"]';
const pendingFinishes = new Map();
const pendingStreams = new Map();
const sessions = new Map();
const expandedRows = new Set();
const expandableRows = new Map();
const avatarTimers = new WeakMap();
const renderedRowKeys = new Map();
const rowMeasurementKeys = new Map();

let layout = DEFAULT_LAYOUT;
let trayOpen = true;
let mascotHover = false;
let petPointerInteractionActive = false;
let pointerInteractionPoint: LooseBoundaryValue = null;
let pointerInteractionFrame: LooseBoundaryValue = null;
let pointerInteractionObserver: LooseBoundaryValue = null;
let scrollState = { hasLatestNotificationsAbove: false, hiddenOlderNotificationCount: 0 };
let lastElementSizePayload = '';
let rowMeasureFrame: LooseBoundaryValue = null;
let petDrag: LooseBoundaryValue = null;
let petOptions: LooseBoundaryValue[] = DEFAULT_PET_OPTIONS.slice();
let selectedPetId = DEFAULT_PET_ID;
let renderFrame: LooseBoundaryValue = null;

function traceEvalEvent(type: LooseBoundaryValue, payload = {}) {
  if (!window.agentUI || typeof window.agentUI.traceEvalEvent !== 'function') return;
  window.agentUI.traceEvalEvent({ type, ...payload });
}

function reportEvalUiState(list = notifications()) {
  if (!window.agentUI || typeof window.agentUI.reportEvalUiState !== 'function') return;
  const top = list[0] || null;
  const conversations: LooseBoundaryValue[] = [];
  const push = (el: LooseBoundaryValue, conversationId: LooseBoundaryValue) => {
    const rect = rectForEvalElement(el);
    if (!rect || !conversationId) return;
    conversations.push({ conversationId, ...rect });
  };
  push(mascot, top ? top.conversationId : '__idle_overlay__');
  if (badgeEl && !badgeEl.hidden) push(badgeEl, top ? top.conversationId : '__idle_overlay__');
  if (tray && !tray.hidden && tray.dataset.collapsed !== 'true') {
    push(tray, top ? top.conversationId : '__session_tray__');
  }
  const rows = trayRows()
    .map((row: LooseBoundaryValue) => {
      const conversationId = String(row.dataset.notificationId || '').trim();
      const rect = rectForEvalElement(row);
      if (!conversationId || !rect) return null;
      const action = row.querySelector('.pet-row-action');
      return {
        conversationId,
        rect,
        actionRect: rectForEvalElement(action),
      };
    })
    .filter(Boolean);
  window.agentUI.reportEvalUiState('overlay', {
    layout,
    notificationCount: list.length,
    trayOpen,
    conversations,
    rows,
  });
}

function linearFrames(
  rowIndex: LooseBoundaryValue,
  count: LooseBoundaryValue,
  frameDurationMs: LooseBoundaryValue,
  finalFrameDurationMs: LooseBoundaryValue,
) {
  return Array.from({ length: count }, (_unused, columnIndex) => ({
    columnIndex,
    frameDurationMs: columnIndex === count - 1 ? finalFrameDurationMs : frameDurationMs,
    rowIndex,
  }));
}

function normalizePetOption(option: LooseBoundaryValue) {
  if (!option || typeof option !== 'object') return null;
  const id = String(option.id || '').trim();
  if (!id) return null;
  return {
    assetRef: String(option.assetRef || 'codex'),
    description: String(option.description || '').trim(),
    displayName: String(option.displayName || option.label || id).trim() || id,
    id,
    spriteUrl: String(option.spriteUrl || option.spritesheetUrl || option.spritesheetDataUrl || '').trim(),
  };
}

function setPetOptions(options: LooseBoundaryValue, selectedId = selectedPetId, selectedSpriteUrl = '') {
  const nextOptions = Array.isArray(options) ? options.map(normalizePetOption).filter(Boolean) : [];
  if (nextOptions.length > 0) petOptions = nextOptions;
  const candidate = String(selectedId || '').trim();
  selectedPetId = petOptionById(candidate).id;
  setActivePetSprite(selectedPetId, selectedSpriteUrl);
}

function setActivePetSprite(id: LooseBoundaryValue, spriteUrl: LooseBoundaryValue) {
  const url = String(spriteUrl || '').trim();
  if (!url) return;
  const pet = petOptions.find((option) => option.id === id);
  if (pet) pet.spriteUrl = url;
}

function preloadActivePetAsset() {
  const pet = currentPetOption();
  if (!pet.spriteUrl) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = pet.spriteUrl;
  });
}

async function loadPetOptionsFromBridge() {
  if (!window.agentUI || typeof window.agentUI.getPetCharacters !== 'function') return;
  try {
    const payload = await window.agentUI.getPetCharacters();
    setPetOptions(
      payload && payload.options,
      payload && payload.id,
      (payload && payload.selectedSpriteUrl) || (payload && payload.selected && payload.selected.spriteUrl),
    );
    await preloadActivePetAsset();
  } catch {
    // Keep rendering with the last known pet options.
  }
}

function petOptionById(id: LooseBoundaryValue) {
  const value = String(id || '').trim();
  return (
    petOptions.find((pet) => pet.id === value) ||
    petOptions[0] || {
      assetRef: 'codex',
      description: '',
      displayName: 'Codex pet',
      id: DEFAULT_PET_ID,
      spriteUrl: '',
    }
  );
}

function currentPetOption() {
  return petOptionById(selectedPetId);
}

function setSelectedPet(id: LooseBoundaryValue) {
  const next = petOptionById(id);
  if (selectedPetId === next.id) return;
  selectedPetId = next.id;
  renderAll();
}

function framePosition(frame: LooseBoundaryValue) {
  return `${(frame.columnIndex / (AVATAR_COLUMNS - 1)) * 100}% ${(frame.rowIndex / (AVATAR_ROWS - 1)) * 100}%`;
}

function framesForState(state: LooseBoundaryValue, prefersReducedMotion: LooseBoundaryValue) {
  const frames = AVATAR_FRAMES[state] || AVATAR_FRAMES.idle;
  if (prefersReducedMotion) return { frames: [frames[0]], loopStartIndex: null };
  if (state === 'idle') return { frames: LONG_IDLE_FRAMES, loopStartIndex: 0 };
  const lead = [...frames, ...frames, ...frames];
  return { frames: [...lead, ...LONG_IDLE_FRAMES], loopStartIndex: lead.length };
}

function animateAvatar(el: LooseBoundaryValue, state: LooseBoundaryValue) {
  if (!el) return;
  const nextState = state || 'idle';
  const pet = currentPetOption();
  if (el.dataset.avatarState === nextState && el.dataset.avatarPetId === pet.id && avatarTimers.has(el)) return;
  const cancel = avatarTimers.get(el);
  if (cancel) cancel();
  el.dataset.avatarAssetRef = pet.assetRef || 'codex';
  el.dataset.avatarState = nextState;
  el.dataset.avatarPetId = pet.id;
  if (pet.spriteUrl) el.style.backgroundImage = `url("${pet.spriteUrl}")`;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animation = framesForState(nextState, prefersReducedMotion);
  let index = 0;
  let timer: LooseBoundaryValue = null;
  el.style.backgroundPosition = framePosition(animation.frames[index]);
  if (animation.frames.length <= 1) {
    avatarTimers.set(el, () => {});
    return;
  }

  const step = () => {
    timer = window.setTimeout(() => {
      const nextIndex = index + 1;
      if (nextIndex >= animation.frames.length) {
        if (animation.loopStartIndex != null) {
          index = animation.loopStartIndex;
          el.style.backgroundPosition = framePosition(animation.frames[index]);
          step();
        }
        return;
      }
      index = nextIndex;
      el.style.backgroundPosition = framePosition(animation.frames[index]);
      step();
    }, animation.frames[index].frameDurationMs);
  };
  step();
  avatarTimers.set(el, () => {
    if (timer != null) window.clearTimeout(timer);
  });
}

function iconMarkup(type: LooseBoundaryValue) {
  switch (type) {
    case 'check-circle':
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.8 10.9 3.9 8l1-1 1.9 1.9 4.3-4.8 1.1.9-5.4 5.9Z"/><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.3a5.2 5.2 0 1 1 0 10.4A5.2 5.2 0 0 1 8 2.8Z"/></svg>';
    case 'warning':
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7 15 14H1L8 1.7Zm0 2.6L3.3 12.7h9.4L8 4.3Z"/><path d="M7.35 6h1.3v3.6h-1.3V6Zm0 4.7h1.3V12h-1.3v-1.3Z"/></svg>';
    case 'spinner':
      return '<span class="pet-status-spinner" aria-hidden="true"></span>';
    case 'chevron':
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.3 6.2 8 9.9l3.7-3.7.9.9L8 11.7 3.4 7.1l.9-.9Z"/></svg>';
    case 'x':
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.2 3.3 3.8 3.8 3.8-3.8.9.9L8.9 8l3.8 3.8-.9.9L8 8.9l-3.8 3.8-.9-.9L7.1 8 3.3 4.2l.9-.9Z"/></svg>';
    case 'clock':
    default:
      return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.3a5.2 5.2 0 1 1 0 10.4A5.2 5.2 0 0 1 8 2.8Z"/><path d="M8.65 4.4h-1.3v4.05l3 1.8.65-1.05-2.35-1.4V4.4Z"/></svg>';
  }
}

function summarize(text: LooseBoundaryValue, max = 90) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function normalizeStatus(status: LooseBoundaryValue) {
  const s = String(status || '').toLowerCase();
  if (s === 'running' || s === 'in_progress' || s === 'resuming') return 'running';
  if (s === 'review' || s === 'completed' || s === 'complete') return 'review';
  if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'canceled') return 'failed';
  return 'idle';
}

function statusMeta(status: LooseBoundaryValue) {
  return STATUS_META[normalizeStatus(status)] || STATUS_META.idle;
}

function sessionTitle(session: LooseBoundaryValue) {
  const title = summarize(session.prompt, 48);
  return title || 'New session';
}

function sessionBody(session: LooseBoundaryValue) {
  const state = normalizeStatus(session && session.status);
  if (state === 'running' && session.streamBubble) return String(session.streamBubble);
  if (session.finishLine) return String(session.finishLine);
  if (session.streamBubble) return String(session.streamBubble);
  return '';
}

function canDismissSession(session: LooseBoundaryValue) {
  const status = normalizeStatus(session && session.status);
  return status === 'review' || status === 'failed';
}

function notificationForSession(session: LooseBoundaryValue) {
  const state = normalizeStatus(session.status);
  if (state === 'idle') return null;
  const id = String(session.conversationId);
  const meta = statusMeta(state);
  const body = sessionBody(session);
  return {
    action: { conversationId: id },
    body: body || meta.defaultBody,
    conversationId: id,
    id,
    isLoading: state === 'running',
    level: state,
    canDismiss: canDismissSession(session),
    source: 'local',
    title: sessionTitle(session),
    updatedAtMs: Number(session.updatedAt || 0),
  };
}

function notifications() {
  return [...sessions.values()]
    .map((session) => notificationForSession(session))
    .filter(Boolean)
    .sort((a, b) => {
      const priority = (STATUS_PRIORITY[a!.level] ?? 4) - (STATUS_PRIORITY[b!.level] ?? 4);
      if (priority !== 0) return priority;
      const updated = b!.updatedAtMs - a!.updatedAtMs;
      return updated === 0 ? a!.id.localeCompare(b!.id) : updated;
    });
}

function visibleSessionCount(list = notifications()) {
  let active = 0;
  let review = 0;
  for (const notification of list) {
    if (notification!.level === 'running') active += 1;
    else review += 1;
  }
  return { active, review };
}

function reportPetPointerInteraction(active: LooseBoundaryValue, { force = false } = {}) {
  const next = !!active;
  if (!force && petPointerInteractionActive === next) return;
  petPointerInteractionActive = next;
  if (window.agentUI && typeof window.agentUI.setPetPointerInteraction === 'function') {
    window.agentUI.setPetPointerInteraction(next);
  }
}

function elementIsUsableHitRegion(el: LooseBoundaryValue) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden || el.closest('[hidden]')) return false;
  if (el.closest('[inert], [aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(el);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.pointerEvents === 'none' ||
    Number(style.opacity) <= 0.01
  )
    return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function pointHitsPetRegion(point: LooseBoundaryValue) {
  if (!point) return false;
  const x = Number(point.clientX);
  const y = Number(point.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
  return document.elementsFromPoint(x, y).some((el) => {
    if (!(el instanceof Element)) return false;
    const region = el.closest(POINTER_HIT_REGION_SELECTOR);
    return elementIsUsableHitRegion(region);
  });
}

function updatePetPointerInteraction({ force = false } = {}) {
  pointerInteractionFrame = null;
  reportPetPointerInteraction(pointHitsPetRegion(pointerInteractionPoint), { force });
}

function schedulePetPointerInteraction(point = pointerInteractionPoint, { force = false } = {}) {
  pointerInteractionPoint = point;
  if (pointerInteractionFrame != null) return;
  pointerInteractionFrame = window.requestAnimationFrame(() => updatePetPointerInteraction({ force }));
}

function clearPetPointerInteraction({ force = false } = {}) {
  pointerInteractionPoint = null;
  if (pointerInteractionFrame != null) {
    window.cancelAnimationFrame(pointerInteractionFrame);
    pointerInteractionFrame = null;
  }
  reportPetPointerInteraction(false, { force });
}

function installPetPointerInteractivity() {
  const rememberPoint = (e: LooseBoundaryValue) => {
    pointerInteractionPoint = { clientX: e.clientX, clientY: e.clientY };
    schedulePetPointerInteraction(pointerInteractionPoint);
  };
  window.addEventListener('mousemove', rememberPoint, { passive: true });
  window.addEventListener('pointermove', rememberPoint, { passive: true });
  window.addEventListener('mouseleave', () => clearPetPointerInteraction(), { passive: true });
  window.addEventListener('blur', () => clearPetPointerInteraction());
  window.addEventListener('resize', () => schedulePetPointerInteraction(), { passive: true });
  window.addEventListener('scroll', () => schedulePetPointerInteraction(), { passive: true, capture: true });
  if (typeof MutationObserver === 'function') {
    pointerInteractionObserver = new MutationObserver(() => schedulePetPointerInteraction());
    pointerInteractionObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['aria-hidden', 'class', 'data-collapsed', 'hidden', 'inert', 'style'],
      childList: true,
      subtree: true,
    });
  }
  pointerInteractionPoint = null;
  petPointerInteractionActive = false;
}

function finishPetDrag(
  pointerId: LooseBoundaryValue,
  { shouldOpenMainWindow = false }: { shouldOpenMainWindow?: boolean } = {},
) {
  if (!petDrag || petDrag.pointerId !== pointerId) return;
  const currentDrag = petDrag;
  petDrag = null;
  shell?.releasePointerCapture?.(pointerId);
  if (window.agentUI && typeof window.agentUI.endPetDrag === 'function') {
    window.agentUI.endPetDrag();
  }
  if (shouldOpenMainWindow && currentDrag.startedOnMascot && !currentDrag.hasMoved) {
    const top = notifications()[0] || null;
    if (top && top.action) openSessionConversation(top.action.conversationId);
  }
  renderAll();
}

function onPetPointerDown(e: LooseBoundaryValue) {
  if (e.button !== 0 || !(e.target instanceof Element) || e.target.closest('.no-drag') != null) return;
  e.preventDefault();
  shell?.setPointerCapture?.(e.pointerId);
  petDrag = {
    startedOnMascot: e.target.closest('[data-avatar-mascot="true"]') != null,
    hasMoved: false,
    pointerId: e.pointerId,
    screenX: e.screenX,
    screenY: e.screenY,
  };
  if (window.agentUI && typeof window.agentUI.startPetDrag === 'function') {
    window.agentUI.startPetDrag({ pointerWindowX: e.clientX, pointerWindowY: e.clientY });
  }
}

function onPetPointerMove(e: LooseBoundaryValue) {
  if (!petDrag || petDrag.pointerId !== e.pointerId) return;
  if (typeof e.buttons === 'number' && (e.buttons & 1) === 0) {
    finishPetDrag(e.pointerId);
    return;
  }
  const deltaX = e.screenX - petDrag.screenX;
  const deltaY = e.screenY - petDrag.screenY;
  if (Math.abs(deltaX) < DRAG_THRESHOLD_PX && Math.abs(deltaY) < DRAG_THRESHOLD_PX) return;
  petDrag.hasMoved = true;
  petDrag.screenX = e.screenX;
  petDrag.screenY = e.screenY;
  const previousState = petDrag.transientState;
  if (deltaX >= DRAG_THRESHOLD_PX) petDrag.transientState = 'running-right';
  else if (deltaX <= -DRAG_THRESHOLD_PX) petDrag.transientState = 'running-left';
  if (window.agentUI && typeof window.agentUI.movePetDrag === 'function') {
    window.agentUI.movePetDrag();
  }
  if (petDrag.transientState !== previousState) renderMascot(notifications());
}

function openSessionConversation(conversationId: LooseBoundaryValue) {
  if (window.agentUI && typeof window.agentUI.openConversation === 'function') {
    window.agentUI.openConversation(String(conversationId));
  }
}

function dismissNotification(notification: LooseBoundaryValue) {
  if (!notification || !notification.canDismiss) return;
  const id = String(notification.conversationId || notification.id || '').trim();
  if (!id) return;
  expandedRows.delete(id);
  if (window.agentUI && typeof window.agentUI.dismissSession === 'function') {
    window.agentUI.dismissSession(id);
    return;
  }
  removeSession(id);
}

function styleBox(el: LooseBoundaryValue, box: LooseBoundaryValue) {
  if (!el || !box) return;
  el.style.left = `${box.left}px`;
  el.style.top = `${box.top}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
}

function ensureMascotAvatar() {
  if (!mascot) return null;
  let avatar = mascot.querySelector<HTMLElement>('.codex-avatar-root');
  if (!avatar) {
    mascot.textContent = '';
    avatar = document.createElement('div');
    avatar.className = 'codex-avatar-root pet-mascot-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.dataset.testid = 'codex-avatar';
    mascot.appendChild(avatar);
  }
  return avatar;
}

function renderMascot(list: LooseBoundaryValue) {
  const top = list[0] || null;
  const meta = statusMeta(top ? top.level : 'idle');
  const state: LooseBoundaryValue = petDrag?.transientState || (mascotHover ? 'jumping' : meta.mascotState);
  const pet = currentPetOption();
  const stage = mascot ? mascot.closest<HTMLElement>('.pet-stage') : null;
  styleBox(stage, layout.mascot);
  if (stage) {
    stage.dataset.avatarOverlayHitRegion = 'mascot';
  }
  if (mascot) {
    mascot.dataset.state = state;
    mascot.dataset.avatarMascot = 'true';
    mascot.dataset.testid = 'avatar-mascot-button';
    mascot.setAttribute('role', list.length > 0 ? 'group' : 'img');
    mascot.setAttribute('aria-label', `${pet.displayName} pet`);
  }
  animateAvatar(ensureMascotAvatar(), state);

  if (!badgeEl) return;
  if (!top) {
    badgeEl.hidden = true;
    return;
  }
  badgeEl.hidden = false;
  badgeEl.classList.add('no-drag');
  badgeEl.dataset.testid = 'avatar-overlay-notification-badge';
  badgeEl.style.backgroundColor = trayOpen ? STATUS_META.idle.badgeBackgroundColor : meta.badgeBackgroundColor;
  badgeEl.style.color = trayOpen ? STATUS_META.idle.badgeForegroundColor : meta.badgeForegroundColor;
  badgeEl.innerHTML = trayOpen ? iconMarkup('chevron') : String(list.length);
  badgeEl.setAttribute(
    'aria-label',
    trayOpen ? 'Collapse activity' : `Open activity tray, ${list.length} ${list.length === 1 ? 'item' : 'items'}`,
  );
}

function notificationCanExpand(notification: LooseBoundaryValue) {
  return expandableRows.get(String(notification.id)) === true;
}

function rowBody(notification: LooseBoundaryValue) {
  const meta = statusMeta(notification.level);
  return notification.body || meta.defaultBody;
}

function makeStatusIcon(notification: LooseBoundaryValue) {
  const meta = statusMeta(notification.level);
  const span = document.createElement('span');
  span.className = `pet-row-status pet-row-status-${notification.level}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = iconMarkup(meta.icon);
  return span;
}

function makeRow(notification: LooseBoundaryValue, index: LooseBoundaryValue) {
  const row = document.createElement('div');
  row.className = 'pet-row no-drag';
  row.dataset.notificationId = notification.id;
  row.dataset.state = notification.level;
  row.setAttribute('role', 'listitem');
  const canExpand = notificationCanExpand(notification);
  row.dataset.canExpand = canExpand ? 'true' : 'false';

  const bodyText = rowBody(notification);

  const card = document.createElement('div');
  card.className = 'pet-row-card';

  const action = document.createElement('div');
  action.className = 'pet-row-action';
  action.tabIndex = notification.action ? 0 : -1;
  if (notification.action) {
    action.setAttribute('role', 'button');
    action.setAttribute(
      'aria-label',
      `${notification.title}. ${statusMeta(notification.level).label}. ${bodyText}. Open notification`,
    );
    action.addEventListener('click', () => openSessionConversation(notification.action.conversationId));
    action.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      openSessionConversation(notification.action.conversationId);
    });
  }

  const titleWrap = document.createElement('span');
  titleWrap.className = 'pet-row-title-wrap';
  const title = document.createElement('span');
  title.className = 'pet-row-title';
  title.textContent = notification.title;
  titleWrap.appendChild(title);

  const body = document.createElement('div');
  body.className = 'pet-row-body';
  body.textContent = bodyText;
  const isExpanded = expandedRows.has(notification.id);
  body.style.maxHeight = `${isExpanded ? EXPANDED_BODY_MAX_HEIGHT : COLLAPSED_BODY_MAX_HEIGHT}px`;
  if (isExpanded) body.dataset.expanded = 'true';

  const measure = document.createElement('div');
  measure.className = 'pet-row-measure';
  measure.setAttribute('aria-hidden', 'true');
  measure.textContent = bodyText;

  action.append(titleWrap, body);
  card.append(action, measure, makeStatusIcon(notification));

  if (canExpand) {
    const expandWrap = document.createElement('div');
    expandWrap.className = 'pet-row-control-wrap pet-row-expand-wrap';
    expandWrap.dataset.avatarOverlayControl = 'expand';
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'pet-row-control pet-row-expand no-drag';
    expand.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    expand.setAttribute('aria-label', `${isExpanded ? 'Collapse' : 'Expand'} ${notification.title}`);
    expand.title = isExpanded ? 'Collapse' : 'Expand';
    expand.innerHTML = iconMarkup('chevron');
    expand.addEventListener('click', (e) => {
      e.stopPropagation();
      if (expandedRows.has(notification.id)) expandedRows.delete(notification.id);
      else expandedRows.add(notification.id);
      renderAll();
    });
    expandWrap.appendChild(expand);
    card.appendChild(expandWrap);
  }

  if (notification.canDismiss) {
    const dismissWrap = document.createElement('div');
    dismissWrap.className = 'pet-row-control-wrap pet-row-dismiss-wrap';
    dismissWrap.dataset.avatarOverlayControl = 'dismiss';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'pet-row-control pet-row-dismiss no-drag';
    dismiss.setAttribute('aria-label', `Dismiss ${notification.title}`);
    dismiss.title = 'Dismiss';
    dismiss.innerHTML = iconMarkup('x');
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissNotification(notification);
    });
    dismissWrap.appendChild(dismiss);
    card.appendChild(dismissWrap);
  }

  row.appendChild(card);
  row.style.animationDelay = `${Math.min(index, 3) * 35}ms`;
  return row;
}

function rowRenderKey(notification: LooseBoundaryValue) {
  const id = String(notification.id);
  return JSON.stringify({
    id,
    level: notification.level,
    title: notification.title,
    body: rowBody(notification),
    canDismiss: !!notification.canDismiss,
    canExpand: notificationCanExpand(notification),
    expanded: expandedRows.has(id),
  });
}

function rowMeasureKey(notification: LooseBoundaryValue) {
  return JSON.stringify({
    id: String(notification.id),
    body: rowBody(notification),
    trayWidth: layout.tray ? layout.tray.width : 0,
  });
}

function trayRows() {
  if (!trayList) return [];
  return Array.from(trayList.children).filter((child) => child instanceof HTMLElement);
}

function pruneExpandableRows(list: LooseBoundaryValue) {
  const ids = new Set(list.map((notification: LooseBoundaryValue) => String(notification.id)));
  for (const id of expandableRows.keys()) {
    if (!ids.has(id)) expandableRows.delete(id);
  }
}

function scheduleRowOverflowMeasurement(list: LooseBoundaryValue, { force = false } = {}) {
  if (!trayList || rowMeasureFrame != null) return;
  let changed = force;
  for (const notification of list) {
    const id = String(notification.id);
    const key = rowMeasureKey(notification);
    if (rowMeasurementKeys.get(id) !== key) {
      rowMeasurementKeys.set(id, key);
      changed = true;
    }
  }
  if (!changed) return;
  rowMeasureFrame = window.requestAnimationFrame(() => {
    rowMeasureFrame = null;
    pruneExpandableRows(list);
    let changed = false;
    for (const row of trayRows()) {
      const id = String(row.dataset.notificationId || '');
      if (!id) continue;
      const measure = row.querySelector('.pet-row-measure');
      const canExpand = measure instanceof HTMLElement ? measure.scrollHeight > COLLAPSED_BODY_MAX_HEIGHT + 1 : false;
      if (expandableRows.get(id) !== canExpand) {
        expandableRows.set(id, canExpand);
        changed = true;
      }
      row.dataset.canExpand = canExpand ? 'true' : 'false';
    }
    if (changed) renderAll();
  });
}

function isTrayScrollable() {
  return !!trayList && trayList.scrollHeight > trayList.clientHeight + SCROLL_EDGE_SLOP;
}

function isScrolledToOlderEnd(scrollTop = trayList ? trayList.scrollTop : 0) {
  if (!trayList || !isTrayScrollable()) return false;
  const maxScrollTop = Math.max(0, trayList.scrollHeight - trayList.clientHeight);
  return scrollTop >= maxScrollTop - SCROLL_EDGE_SLOP;
}

function visibleAnchorOffset(rows: LooseBoundaryValue, scrollTop = trayList ? trayList.scrollTop : 0) {
  return scrollTop + (rows[0]?.offsetTop || 0) + SCROLL_EDGE_SLOP;
}

function rowIndexAtOffset(rows: LooseBoundaryValue, offset: LooseBoundaryValue) {
  let index = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].offsetTop <= offset) index = i;
  }
  return index;
}

function hiddenOlderCount(rows: LooseBoundaryValue, anchorOffset: LooseBoundaryValue) {
  if (!trayList) return 0;
  const lowerEdge = anchorOffset + trayList.clientHeight - SCROLL_EDGE_SLOP;
  return rows.filter((row: LooseBoundaryValue) => row.offsetTop + row.offsetHeight > lowerEdge).length;
}

function updateScrollState(scrollTop = trayList ? trayList.scrollTop : 0) {
  if (!trayList) return;
  if (!isTrayScrollable()) {
    scrollState = { hasLatestNotificationsAbove: false, hiddenOlderNotificationCount: 0 };
    return;
  }
  if (isScrolledToOlderEnd(scrollTop)) {
    scrollState = { hasLatestNotificationsAbove: true, hiddenOlderNotificationCount: 0 };
    return;
  }
  const rows = trayRows();
  const anchorOffset = visibleAnchorOffset(rows, scrollTop);
  const hasLatestNotificationsAbove = scrollTop > SCROLL_EDGE_SLOP;
  const hiddenOlderNotificationCount = hiddenOlderCount(rows, anchorOffset);
  scrollState = { hasLatestNotificationsAbove, hiddenOlderNotificationCount };
}

function makeScrollButton(kind: LooseBoundaryValue, count: LooseBoundaryValue) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `pet-scroll-control pet-scroll-${kind} no-drag`;
  button.dataset.avatarOverlayHitRegion = 'notification-scroll-control';
  if (kind === 'latest') {
    button.setAttribute('aria-label', 'Show latest activity');
    button.innerHTML = '<span>Latest</span>' + iconMarkup('chevron');
    button.addEventListener('click', () => {
      trayList!.scrollTo({ behavior: 'smooth', top: 0 });
      requestAnimationFrame(() => updateScrollState(0));
    });
  } else {
    button.setAttribute('aria-label', `Show ${count} older activity items`);
    button.innerHTML = `<span class="pet-scroll-compact">+${count}</span><span class="pet-scroll-full">${count} more</span>${iconMarkup('chevron')}`;
    button.addEventListener('click', () => {
      const rows = trayRows();
      const currentIndex = rowIndexAtOffset(rows, visibleAnchorOffset(rows));
      const target =
        count <= VISIBLE_SCROLL_STEP
          ? trayList!.scrollHeight
          : (rows[currentIndex + VISIBLE_SCROLL_STEP]?.offsetTop ?? trayList!.scrollHeight);
      trayList!.scrollTo({ behavior: 'smooth', top: target });
      requestAnimationFrame(() => updateScrollState(target));
    });
  }
  return button;
}

function renderTray(list: LooseBoundaryValue) {
  if (!tray || !trayList) return;
  const hasNotifications = list.length > 0;
  const isVisible = hasNotifications && trayOpen;
  tray.hidden = !hasNotifications;
  tray.dataset.collapsed = isVisible ? 'false' : 'true';
  tray.dataset.avatarOverlayHitRegion = 'notification-tray';
  tray.dataset.avatarOverlaySize = 'notification-tray';
  tray.toggleAttribute('inert', !isVisible);
  if (isVisible) tray.removeAttribute('aria-hidden');
  else tray.setAttribute('aria-hidden', 'true');
  if (layout.tray) {
    styleBox(tray, layout.tray);
    tray.style.maxHeight = `${layout.tray.height}px`;
    trayList.style.maxHeight = `${layout.tray.height}px`;
    tray.style.visibility = '';
  } else {
    tray.style.visibility = 'hidden';
  }

  const existingRows = new Map();
  for (const row of trayRows()) {
    const id = String(row.dataset.notificationId || '');
    if (id) existingRows.set(id, row);
  }
  const fragment = document.createDocumentFragment();
  let rowsChanged = existingRows.size !== list.length;
  trayList.dataset.avatarOverlaySize = 'notification-tray-list';
  trayList.setAttribute('aria-label', 'Activity notifications');
  list.forEach((notification: LooseBoundaryValue, index: LooseBoundaryValue) => {
    const id = String(notification.id);
    const key = rowRenderKey(notification);
    const existing = existingRows.get(id);
    if (existing && renderedRowKeys.get(id) === key) {
      fragment.appendChild(existing);
      return;
    }
    rowsChanged = true;
    const row = makeRow(notification, index);
    renderedRowKeys.set(id, key);
    fragment.appendChild(row);
  });
  const ids = new Set(list.map((notification: LooseBoundaryValue) => String(notification.id)));
  for (const id of renderedRowKeys.keys()) {
    if (!ids.has(id)) renderedRowKeys.delete(id);
  }
  for (const id of rowMeasurementKeys.keys()) {
    if (!ids.has(id)) rowMeasurementKeys.delete(id);
  }
  if (rowsChanged || trayList.children.length !== list.length) {
    trayList.replaceChildren(fragment);
  }
  scheduleRowOverflowMeasurement(list, { force: rowsChanged });
  updateScrollState();

  const existingControls = tray.querySelectorAll('.pet-scroll-control');
  existingControls.forEach((node) => node.remove());
  if (hasNotifications && trayOpen && scrollState.hasLatestNotificationsAbove) {
    tray.appendChild(makeScrollButton('latest', 0));
  }
  if (hasNotifications && trayOpen && scrollState.hiddenOlderNotificationCount > 0) {
    tray.appendChild(makeScrollButton('older', scrollState.hiddenOlderNotificationCount));
  }
}

function updateCounts(list: LooseBoundaryValue) {
  const counts = visibleSessionCount(list);
  if (window.agentUI && typeof window.agentUI.reportSessionCounts === 'function') {
    window.agentUI.reportSessionCounts({ active: counts.active, inReview: counts.review });
  }
}

function reportElementSize(list: LooseBoundaryValue) {
  if (!window.agentUI || typeof window.agentUI.reportPetElementSize !== 'function') return;
  requestAnimationFrame(() => {
    const avatar = mascot ? mascot.querySelector('.codex-avatar-root') : null;
    const avatarRect = avatar ? avatar.getBoundingClientRect() : null;
    const trayWidth = tray ? tray.offsetWidth || DEFAULT_LAYOUT.tray.width : DEFAULT_LAYOUT.tray.width;
    const trayHeight = trayList ? trayList.scrollHeight : DEFAULT_LAYOUT.tray.height;
    const payload = {
      isTrayVisible: trayOpen && list.length > 0,
      mascot: {
        width: Math.ceil(avatarRect && avatarRect.width > 0 ? avatarRect.width : DEFAULT_LAYOUT.mascot.width),
        height: Math.ceil(avatarRect && avatarRect.height > 0 ? avatarRect.height : DEFAULT_LAYOUT.mascot.height),
      },
      tray:
        list.length > 0
          ? {
              width: Math.ceil(trayWidth),
              height: Math.ceil(trayHeight),
            }
          : null,
    };
    const key = JSON.stringify(payload);
    if (key === lastElementSizePayload) return;
    lastElementSizePayload = key;
    window.agentUI.reportPetElementSize(payload);
  });
}

function renderAllNow() {
  renderFrame = null;
  const list = notifications();
  if (root) root.hidden = false;
  if (shell) shell.hidden = false;
  renderMascot(list);
  renderTray(list);
  updateCounts(list);
  reportElementSize(list);
  schedulePetPointerInteraction();
  reportEvalUiState(list);
  traceEvalEvent('pet_rendered', { notificationCount: list.length });
}

function renderAll() {
  if (renderFrame != null) return;
  renderFrame = window.requestAnimationFrame(renderAllNow);
}

function finishLineFromPayload(payload: AgentUIPayload = {}) {
  for (const key of ['finishBubbleLine', 'result']) {
    const value = payload[key] != null ? String(payload[key]).trim() : '';
    if (value) return value;
  }
  return '';
}

function upsertSession(payload: AgentUIPayload = {}) {
  const conversationId = String(payload.conversationId || '').trim();
  if (!conversationId) return null;
  const existing = sessions.get(conversationId) || {
    conversationId,
    prompt: '',
    kind: null,
    status: 'running',
    streamBubble: '',
    finishLine: '',
    updatedAt: 0,
  };
  existing.prompt = payload.prompt != null ? String(payload.prompt) : existing.prompt;
  existing.kind = payload.kind != null ? String(payload.kind) : existing.kind;
  existing.status = payload.status != null ? String(payload.status) : existing.status || 'running';
  existing.finishLine = finishLineFromPayload(payload) || existing.finishLine;
  existing.updatedAt = Date.now();
  sessions.set(conversationId, existing);
  return existing;
}

function applyStreamBubble(ev: AgentUIPayload = {}) {
  const conversationId = String(ev.conversationId || '').trim();
  if (!conversationId) return;
  const session = sessions.get(conversationId) || upsertSession({ conversationId, status: 'running' });
  if (!session) return;
  const text = String(ev.text || '').trim();
  if (!text) return;
  if (session.streamBubble === text && normalizeStatus(session.status) === 'running') return;
  session.streamBubble = text;
  if (normalizeStatus(session.status) === 'idle') session.status = 'running';
  session.updatedAt = Date.now();
  sessions.set(conversationId, session);
  traceEvalEvent('stream_bubble_rendered', { conversationId, textLength: text.length });
  renderAll();
}

function applyFinish(ev: AgentUIPayload = {}) {
  const conversationId = String(ev.conversationId || '').trim();
  if (!conversationId) return;
  const session = sessions.get(conversationId) || upsertSession({ conversationId });
  if (!session) return;
  session.status = ev.status != null ? String(ev.status) : session.status;
  session.finishLine = finishLineFromPayload(ev) || session.finishLine;
  session.streamBubble = '';
  session.updatedAt = Date.now();
  sessions.set(conversationId, session);
  pendingFinishes.delete(conversationId);
  traceEvalEvent('terminal_visual_rendered', {
    conversationId,
    status: normalizeStatus(session.status),
    textLength: String(session.finishLine || '').length,
  });
  renderAll();
}

function reactivate(conversationId: LooseBoundaryValue) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const session = sessions.get(id);
  if (!session) return;
  session.status = 'running';
  session.updatedAt = Date.now();
  session.streamBubble = '';
  session.finishLine = '';
  renderAll();
}

function removeSession(conversationId: LooseBoundaryValue) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  sessions.delete(id);
  pendingFinishes.delete(id);
  pendingStreams.delete(id);
  expandedRows.delete(id);
  expandableRows.delete(id);
  renderAll();
}

async function boot() {
  await loadPetOptionsFromBridge();
  if (!window.agentUI) {
    renderAll();
    return;
  }

  if (typeof window.agentUI.onPetLayoutChanged === 'function') {
    window.agentUI.onPetLayoutChanged((payload: LooseBoundaryValue) => {
      if (payload && payload.layout) {
        layout = {
          mascot: payload.layout.mascot || DEFAULT_LAYOUT.mascot,
          placement: payload.layout.placement || DEFAULT_LAYOUT.placement,
          tray: payload.layout.tray || null,
          viewport: payload.layout.viewport || DEFAULT_LAYOUT.viewport,
        };
        renderAll();
      }
    });
  }

  if (typeof window.agentUI.onPetCharacterChanged === 'function') {
    window.agentUI.onPetCharacterChanged((payload: LooseBoundaryValue) => {
      if (payload && Array.isArray(payload.options)) {
        setPetOptions(
          payload.options,
          payload.id,
          payload.selectedSpriteUrl || (payload.selected && payload.selected.spriteUrl),
        );
        void preloadActivePetAsset();
        renderAll();
      } else {
        setSelectedPet(payload && payload.id);
      }
    });
  }

  if (typeof window.agentUI.onSessionStarted === 'function') {
    window.agentUI.onSessionStarted((payload: LooseBoundaryValue) => {
      const session = upsertSession(payload);
      if (!session) return;
      renderAll();
      if (pendingStreams.has(String(session.conversationId))) {
        applyStreamBubble(pendingStreams.get(String(session.conversationId)));
        pendingStreams.delete(String(session.conversationId));
      }
      if (pendingFinishes.has(String(session.conversationId))) {
        applyFinish(pendingFinishes.get(String(session.conversationId)));
        pendingFinishes.delete(String(session.conversationId));
      }
      traceEvalEvent('session_row_rendered', {
        conversationId: String(session.conversationId),
        kind: session.kind || null,
      });
    });
  }

  if (typeof window.agentUI.onAgentFinished === 'function') {
    window.agentUI.onAgentFinished((ev: LooseBoundaryValue) => {
      const id = String(ev && ev.conversationId ? ev.conversationId : '').trim();
      if (!id) return;
      if (!sessions.has(id)) {
        pendingFinishes.set(id, ev || {});
        return;
      }
      applyFinish(ev || {});
    });
  }

  if (typeof window.agentUI.onAgentStreamBubble === 'function') {
    window.agentUI.onAgentStreamBubble((ev: LooseBoundaryValue) => {
      const id = String(ev && ev.conversationId ? ev.conversationId : '').trim();
      if (!id) return;
      if (!sessions.has(id)) {
        pendingStreams.set(id, ev || {});
        return;
      }
      applyStreamBubble(ev || {});
    });
  }

  if (typeof window.agentUI.onAgentRestarted === 'function') {
    window.agentUI.onAgentRestarted((ev: LooseBoundaryValue) => {
      if (ev && ev.conversationId != null) reactivate(ev.conversationId);
    });
  }

  if (typeof window.agentUI.onRemoveSession === 'function') {
    window.agentUI.onRemoveSession((payload: LooseBoundaryValue) => {
      if (payload && payload.conversationId != null) removeSession(payload.conversationId);
    });
  }

  installPetPointerInteractivity();
  shell?.addEventListener('pointerdown', onPetPointerDown);
  shell?.addEventListener('pointermove', onPetPointerMove);
  shell?.addEventListener('lostpointercapture', (e) => {
    if (typeof e.buttons === 'number' && (e.buttons & 1) !== 0) return;
    finishPetDrag(e.pointerId);
  });
  window.addEventListener('pointerup', (e) => {
    finishPetDrag(e.pointerId, { shouldOpenMainWindow: true });
  });
  window.addEventListener('pointercancel', (e) => {
    finishPetDrag(e.pointerId);
  });
  if (badgeEl) {
    badgeEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    badgeEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      trayOpen = !trayOpen;
      renderAll();
    });
  }

  mascot?.addEventListener('pointerenter', () => {
    mascotHover = true;
    renderMascot(notifications());
  });
  mascot?.addEventListener('pointerleave', () => {
    mascotHover = false;
    renderMascot(notifications());
  });
  mascot?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (window.agentUI && typeof window.agentUI.showPetContextMenu === 'function') {
      window.agentUI.showPetContextMenu();
    }
  });

  trayList?.addEventListener(
    'scroll',
    () => {
      updateScrollState();
    },
    { passive: true },
  );
  window.addEventListener('resize', () => {
    reportElementSize(notifications());
    reportEvalUiState();
  });
  window.addEventListener('beforeunload', () => {
    if (petDrag) finishPetDrag(petDrag.pointerId);
    if (renderFrame != null) window.cancelAnimationFrame(renderFrame);
    clearPetPointerInteraction({ force: true });
    if (pointerInteractionObserver) pointerInteractionObserver.disconnect();
  });

  if (typeof window.agentUI.overlayReady === 'function') {
    window.agentUI.overlayReady();
    traceEvalEvent('overlay_ready', {});
  }

  renderAll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  void boot();
}
