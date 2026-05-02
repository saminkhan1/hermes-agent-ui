/* global agentUI */

import catSpriteUrl from '../../../assets/cats/cat.png';

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

const STATUS_PRIORITY = {
  waiting: 0,
  failed: 1,
  review: 2,
  running: 3,
  idle: 4,
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
  waiting: {
    badgeBackgroundColor: 'var(--color-token-editor-warning-foreground)',
    badgeForegroundColor: 'var(--color-token-bg-primary)',
    defaultBody: 'Needs input',
    icon: 'clock',
    label: 'Needs input',
    mascotState: 'waiting',
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

const AVATAR_COLUMNS = 12;
const AVATAR_ROWS = 7;
const IDLE_FRAMES = [
  { rowIndex: 0, columnIndex: 0, frameDurationMs: 280 },
  { rowIndex: 0, columnIndex: 1, frameDurationMs: 110 },
  { rowIndex: 0, columnIndex: 2, frameDurationMs: 110 },
  { rowIndex: 0, columnIndex: 3, frameDurationMs: 140 },
  { rowIndex: 0, columnIndex: 4, frameDurationMs: 140 },
  { rowIndex: 0, columnIndex: 5, frameDurationMs: 320 },
];
const LONG_IDLE_FRAMES = IDLE_FRAMES.map((frame) => ({ ...frame, frameDurationMs: frame.frameDurationMs * 6 }));
const AVATAR_FRAMES = {
  failed: linearFrames(6, 4, 140, 240),
  idle: IDLE_FRAMES,
  jumping: linearFrames(4, 3, 140, 280),
  review: linearFrames(3, 3, 150, 280),
  running: linearFrames(2, 8, 120, 220),
  'running-left': linearFrames(2, 8, 120, 220),
  'running-right': linearFrames(2, 8, 120, 220),
  waiting: linearFrames(5, 8, 150, 260),
};

const VISIBLE_SCROLL_STEP = 2;
const SCROLL_EDGE_SLOP = 2;
const COLLAPSED_BODY_MAX_HEIGHT = 32;
const EXPANDED_BODY_MAX_HEIGHT = 512;
const POINTER_HIT_REGION_SELECTOR = '[data-avatar-overlay-hit-region], [data-avatar-mascot="true"]';
const pendingFinishes = new Map();
const pendingStreams = new Map();
const replyDrafts = new Map();
const replyErrors = new Map();
const submittingReplies = new Set();
const sessions = new Map();
const expandedRows = new Set();
const avatarTimers = new WeakMap();

let layout = DEFAULT_LAYOUT;
let trayOpen = true;
let mascotHover = false;
let replyingTo = null;
let pendingReplyFocus = null;
let petPointerInteractionActive = false;
let petKeyboardInteractionActive = false;
let pointerInteractionPoint = null;
let pointerInteractionFrame = null;
let pointerInteractionObserver = null;
let scrollState = { hasLatestNotificationsAbove: false, hiddenOlderNotificationCount: 0 };
let lastElementSizePayload = '';

const assetsReady = new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve(true);
  img.onerror = () => resolve(false);
  img.src = catSpriteUrl;
});

function traceEvalEvent(type, payload = {}) {
  if (!window.agentUI || typeof window.agentUI.traceEvalEvent !== 'function') return;
  window.agentUI.traceEvalEvent({ type, ...payload });
}

function rectFor(el) {
  if (!(el instanceof HTMLElement)) return null;
  if (el.hidden || window.getComputedStyle(el).display === 'none') return null;
  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const wx = window.screenX ?? window.screenLeft ?? 0;
  const wy = window.screenY ?? window.screenTop ?? 0;
  return {
    left: Math.round(wx + rect.left),
    top: Math.round(wy + rect.top),
    right: Math.round(wx + rect.right),
    bottom: Math.round(wy + rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function reportEvalUiState(list = notifications()) {
  if (!window.agentUI || typeof window.agentUI.reportEvalUiState !== 'function') return;
  const top = list[0] || null;
  const cats = [];
  const push = (el, catId) => {
    const rect = rectFor(el);
    if (!rect || !catId) return;
    cats.push({ catId, ...rect });
  };
  push(mascot, top ? top.catId : '__idle_pet__');
  if (badgeEl && !badgeEl.hidden) push(badgeEl, top ? top.catId : '__idle_pet__');
  if (tray && !tray.hidden && tray.dataset.collapsed !== 'true') {
    push(tray, top ? top.catId : '__pet_tray__');
  }
  window.agentUI.reportEvalUiState('overlay', {
    layout,
    notificationCount: list.length,
    trayOpen,
    cats,
  });
}

function linearFrames(rowIndex, count, frameDurationMs, finalFrameDurationMs) {
  return Array.from({ length: count }, (_unused, columnIndex) => ({
    columnIndex,
    frameDurationMs: columnIndex === count - 1 ? finalFrameDurationMs : frameDurationMs,
    rowIndex,
  }));
}

function framePosition(frame) {
  return `${(frame.columnIndex / (AVATAR_COLUMNS - 1)) * 100}% ${(frame.rowIndex / (AVATAR_ROWS - 1)) * 100}%`;
}

function framesForState(state, prefersReducedMotion) {
  const frames = AVATAR_FRAMES[state] || AVATAR_FRAMES.idle;
  if (prefersReducedMotion) return { frames: [frames[0]], loopStartIndex: null };
  if (state === 'idle') return { frames: LONG_IDLE_FRAMES, loopStartIndex: 0 };
  const lead = [...frames, ...frames, ...frames];
  return { frames: [...lead, ...LONG_IDLE_FRAMES], loopStartIndex: lead.length };
}

function animateAvatar(el, state) {
  if (!el) return;
  const nextState = state || 'idle';
  if (el.dataset.avatarState === nextState && avatarTimers.has(el)) return;
  const cancel = avatarTimers.get(el);
  if (cancel) cancel();
  el.dataset.avatarState = nextState;
  el.dataset.avatarDirection = nextState === 'running-left' ? 'left' : 'right';
  el.style.backgroundImage = `url("${catSpriteUrl}")`;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animation = framesForState(nextState, prefersReducedMotion);
  let index = 0;
  let timer = null;
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

function ensureAvatarFrame(rootEl) {
  if (!rootEl) return null;
  let frame = rootEl.querySelector('.pet-avatar-frame');
  if (!frame) {
    frame = document.createElement('span');
    frame.className = 'pet-avatar-frame';
    frame.setAttribute('aria-hidden', 'true');
    rootEl.appendChild(frame);
  }
  return frame;
}

function iconMarkup(type) {
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

function summarize(text, max = 90) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running' || s === 'in_progress' || s === 'resuming') return 'running';
  if (s === 'review' || s === 'completed' || s === 'complete') return 'review';
  if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'canceled') return 'failed';
  if (s === 'waiting' || s === 'needs_input' || s === 'needs-input') return 'waiting';
  return 'idle';
}

function statusMeta(status) {
  return STATUS_META[normalizeStatus(status)] || STATUS_META.idle;
}

function sessionPriority(session) {
  return STATUS_PRIORITY[normalizeStatus(session.status)] ?? STATUS_PRIORITY.idle;
}

function sortedSessions() {
  return [...sessions.values()].sort((a, b) => {
    const pa = sessionPriority(a);
    const pb = sessionPriority(b);
    if (pa !== pb) return pa - pb;
    const updated = Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    return updated === 0 ? String(a.catId).localeCompare(String(b.catId)) : updated;
  });
}

function sessionTitle(session) {
  const title = summarize(session.prompt, 48);
  return title || 'New session';
}

function sessionBody(session) {
  if (session.streamBubble) return String(session.streamBubble);
  if (session.finishLine) return String(session.finishLine);
  return '';
}

function canDismissSession(session) {
  const status = normalizeStatus(session && session.status);
  return status === 'review' || status === 'failed';
}

function notificationForSession(session) {
  const state = normalizeStatus(session.status);
  if (state === 'idle') return null;
  const id = String(session.catId);
  const meta = statusMeta(state);
  const body = sessionBody(session);
  return {
    action: { catId: id },
    body: body || meta.defaultBody,
    catId: id,
    id,
    isLoading: state === 'running',
    level: state,
    canDismiss: canDismissSession(session),
    replyTarget: canReplyToSession(session) ? { catId: id } : null,
    source: 'local',
    title: sessionTitle(session),
    updatedAtMs: Number(session.updatedAt || 0),
  };
}

function notifications() {
  return sortedSessions()
    .map((session) => notificationForSession(session))
    .filter(Boolean)
    .sort((a, b) => {
      const priority = (STATUS_PRIORITY[a.level] ?? 4) - (STATUS_PRIORITY[b.level] ?? 4);
      if (priority !== 0) return priority;
      const updated = b.updatedAtMs - a.updatedAtMs;
      return updated === 0 ? a.id.localeCompare(b.id) : updated;
    });
}

function visibleSessionCount(list = notifications()) {
  let active = 0;
  let review = 0;
  for (const notification of list) {
    if (notification.level === 'running') active += 1;
    else review += 1;
  }
  return { active, review };
}

function canReplyToSession(session) {
  return !!(
    session &&
    normalizeStatus(session.status) === 'waiting' &&
    window.agentUI &&
    typeof window.agentUI.sendFollowup === 'function'
  );
}

function setPetKeyboardInteraction(active) {
  if (petKeyboardInteractionActive === !!active) return;
  petKeyboardInteractionActive = !!active;
  if (window.agentUI && typeof window.agentUI.setPetKeyboardInteraction === 'function') {
    window.agentUI.setPetKeyboardInteraction(petKeyboardInteractionActive);
  }
}

function reportPetPointerInteraction(active, { force = false } = {}) {
  const next = !!active;
  if (!force && petPointerInteractionActive === next) return;
  petPointerInteractionActive = next;
  if (window.agentUI && typeof window.agentUI.setPetPointerInteraction === 'function') {
    window.agentUI.setPetPointerInteraction(next);
  }
}

function elementIsUsableHitRegion(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden || el.closest('[hidden]')) return false;
  if (el.closest('[inert], [aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(el);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.pointerEvents === 'none' ||
    Number(style.opacity) <= 0.01
  ) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function pointHitsPetRegion(point) {
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
  const rememberPoint = (e) => {
    pointerInteractionPoint = { clientX: e.clientX, clientY: e.clientY };
    schedulePetPointerInteraction(pointerInteractionPoint);
  };
  window.addEventListener('mousemove', rememberPoint, { passive: true });
  window.addEventListener('pointermove', rememberPoint, { passive: true });
  window.addEventListener('mouseleave', () => clearPetPointerInteraction(), { passive: true });
  window.addEventListener('blur', () => {
    if (!petKeyboardInteractionActive) clearPetPointerInteraction();
  });
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

function openSessionConversation(catId) {
  if (window.agentUI && typeof window.agentUI.openCatConversation === 'function') {
    window.agentUI.openCatConversation(String(catId));
  }
}

async function submitInlineReply(notification, input) {
  const text = input && typeof input.value === 'string' ? input.value.trim() : '';
  if (!text || !notification.replyTarget) return;
  if (window.agentUI && typeof window.agentUI.sendFollowup === 'function') {
    const id = String(notification.id);
    replyDrafts.set(id, text);
    replyErrors.delete(id);
    submittingReplies.add(id);
    renderAll();
    try {
      const result = await window.agentUI.sendFollowup(String(notification.replyTarget.catId), text);
      if (result && result.ok === false) {
        replyErrors.set(id, result.error || 'Unable to send reply');
        return;
      }
      replyDrafts.delete(id);
      if (input) input.value = '';
      replyingTo = null;
      pendingReplyFocus = null;
    } catch {
      replyErrors.set(id, 'Unable to send reply');
    } finally {
      submittingReplies.delete(id);
      renderAll();
    }
    return;
  }
}

function dismissNotification(notification) {
  if (!notification || !notification.canDismiss) return;
  const id = String(notification.catId || notification.id || '').trim();
  if (!id) return;
  if (replyingTo === id) replyingTo = null;
  expandedRows.delete(id);
  if (window.agentUI && typeof window.agentUI.dismissCat === 'function') {
    window.agentUI.dismissCat(id);
    return;
  }
  removeSession(id);
}

function styleBox(el, box) {
  if (!el || !box) return;
  el.style.left = `${box.left}px`;
  el.style.top = `${box.top}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
}

function ensureMascotAvatar() {
  if (!mascot) return null;
  let avatar = mascot.querySelector('.codex-avatar-root');
  if (!avatar) {
    mascot.textContent = '';
    avatar = document.createElement('span');
    avatar.className = 'codex-avatar-root pet-mascot-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.dataset.testid = 'codex-avatar';
    mascot.appendChild(avatar);
  }
  return ensureAvatarFrame(avatar);
}

function renderMascot(list) {
  const top = list[0] || null;
  const meta = statusMeta(top ? top.level : 'idle');
  const state = mascotHover ? 'jumping' : meta.mascotState;
  const stage = mascot ? mascot.closest('.pet-stage') : null;
  styleBox(stage, layout.mascot);
  if (stage) {
    stage.dataset.avatarOverlayHitRegion = 'mascot';
  }
  if (mascot) {
    mascot.dataset.state = state;
    mascot.dataset.avatarMascot = 'true';
    mascot.dataset.testid = 'avatar-mascot-button';
    mascot.setAttribute('role', list.length > 0 ? 'group' : 'img');
    mascot.setAttribute('aria-label', 'Codex pet');
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
    trayOpen ? 'Collapse activity' : `Open activity tray, ${list.length} ${list.length === 1 ? 'item' : 'items'}`
  );
}

function notificationCanExpand(notification) {
  return String(notification.body || '').replace(/\s+/g, ' ').trim().length > 80;
}

function rowBody(notification) {
  const meta = statusMeta(notification.level);
  return notification.body || meta.defaultBody;
}

function makeStatusIcon(notification) {
  const meta = statusMeta(notification.level);
  const span = document.createElement('span');
  span.className = `pet-row-status pet-row-status-${notification.level}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = iconMarkup(meta.icon);
  return span;
}

function makeRow(notification, index) {
  const row = document.createElement('div');
  row.className = 'pet-row no-drag';
  row.dataset.notificationId = notification.id;
  row.dataset.state = notification.level;
  row.setAttribute('role', 'listitem');
  const canExpand = notificationCanExpand(notification);
  row.dataset.canExpand = canExpand ? 'true' : 'false';

  const card = document.createElement('div');
  card.className = 'pet-row-card';

  const action = document.createElement('div');
  action.className = 'pet-row-action';
  action.tabIndex = notification.action ? 0 : -1;
  if (notification.action) {
    action.setAttribute('role', 'button');
    action.setAttribute('aria-label', `${notification.title}. ${statusMeta(notification.level).label}. ${rowBody(notification)}. Open notification`);
    action.addEventListener('click', () => openSessionConversation(notification.action.catId));
    action.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      openSessionConversation(notification.action.catId);
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
  body.textContent = rowBody(notification);
  const isExpanded = expandedRows.has(notification.id);
  body.style.maxHeight = `${isExpanded ? EXPANDED_BODY_MAX_HEIGHT : COLLAPSED_BODY_MAX_HEIGHT}px`;
  if (isExpanded) body.dataset.expanded = 'true';

  action.append(titleWrap, body);
  card.append(action, makeStatusIcon(notification));

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

  if (notification.replyTarget && replyingTo !== notification.id) {
    const replyWrap = document.createElement('div');
    replyWrap.className = 'pet-row-control-wrap pet-row-reply-wrap';
    replyWrap.dataset.avatarOverlayControl = 'reply';
    const reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'pet-row-control pet-row-reply no-drag';
    reply.setAttribute('aria-label', `Reply to ${notification.title}`);
    reply.textContent = 'Reply';
    reply.addEventListener('pointerdown', (e) => e.stopPropagation());
    reply.addEventListener('click', (e) => {
      e.stopPropagation();
      replyingTo = notification.id;
      pendingReplyFocus = notification.id;
      replyDrafts.set(notification.id, '');
      replyErrors.delete(notification.id);
      renderAll();
    });
    replyWrap.appendChild(reply);
    card.appendChild(replyWrap);
  }

  if (replyingTo === notification.id && notification.replyTarget) {
    const form = document.createElement('form');
    form.className = 'pet-row-reply-form no-drag';
    form.addEventListener('click', (e) => e.stopPropagation());
    form.addEventListener('pointerdown', (e) => e.stopPropagation());
    const input = document.createElement('input');
    input.className = 'pet-row-reply-input';
    input.type = 'text';
    input.placeholder = 'Reply';
    input.setAttribute('aria-label', `Reply to ${notification.title}`);
    input.value = replyDrafts.get(notification.id) || '';
    input.disabled = submittingReplies.has(notification.id);
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'pet-row-control pet-row-reply-send';
    send.disabled = input.value.trim().length === 0 || submittingReplies.has(notification.id);
    send.setAttribute('aria-label', `Send reply to ${notification.title}`);
    send.textContent = 'Reply';
    form.append(input, send);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation();
      submitInlineReply(notification, input);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      replyDrafts.delete(notification.id);
      replyErrors.delete(notification.id);
      replyingTo = null;
      pendingReplyFocus = null;
      renderAll();
    });
    input.addEventListener('input', () => {
      replyDrafts.set(notification.id, input.value);
      replyErrors.delete(notification.id);
      send.disabled = input.value.trim().length === 0 || submittingReplies.has(notification.id);
    });
    const error = replyErrors.get(notification.id);
    if (error) {
      const message = document.createElement('div');
      message.className = 'pet-row-reply-error';
      message.role = 'alert';
      message.textContent = error;
      form.appendChild(message);
    }
    card.appendChild(form);
    if (pendingReplyFocus === notification.id) {
      requestAnimationFrame(() => input.focus());
    }
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

function trayRows() {
  if (!trayList) return [];
  return Array.from(trayList.children).filter((child) => child instanceof HTMLElement);
}

function isTrayScrollable() {
  return !!trayList && trayList.scrollHeight > trayList.clientHeight + SCROLL_EDGE_SLOP;
}

function isScrolledToOlderEnd(scrollTop = trayList ? trayList.scrollTop : 0) {
  if (!trayList || !isTrayScrollable()) return false;
  const maxScrollTop = Math.max(0, trayList.scrollHeight - trayList.clientHeight);
  return scrollTop >= maxScrollTop - SCROLL_EDGE_SLOP;
}

function visibleAnchorOffset(rows, scrollTop = trayList ? trayList.scrollTop : 0) {
  return scrollTop + (rows[0]?.offsetTop || 0) + SCROLL_EDGE_SLOP;
}

function rowIndexAtOffset(rows, offset) {
  let index = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].offsetTop <= offset) index = i;
  }
  return index;
}

function hiddenOlderCount(rows, anchorOffset) {
  if (!trayList) return 0;
  const lowerEdge = anchorOffset + trayList.clientHeight - SCROLL_EDGE_SLOP;
  return rows.filter((row) => row.offsetTop + row.offsetHeight > lowerEdge).length;
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

function makeScrollButton(kind, count) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `pet-scroll-control pet-scroll-${kind} no-drag`;
  button.dataset.avatarOverlayHitRegion = 'notification-scroll-control';
  if (kind === 'latest') {
    button.setAttribute('aria-label', 'Show latest activity');
    button.innerHTML = '<span>Latest</span>' + iconMarkup('chevron');
    button.addEventListener('click', () => {
      trayList.scrollTo({ behavior: 'smooth', top: 0 });
      requestAnimationFrame(() => updateScrollState(0));
    });
  } else {
    button.setAttribute('aria-label', `Show ${count} older activity items`);
    button.innerHTML = `<span class="pet-scroll-compact">+${count}</span><span class="pet-scroll-full">${count} more</span>${iconMarkup('chevron')}`;
    button.addEventListener('click', () => {
      const rows = trayRows();
      const currentIndex = rowIndexAtOffset(rows, visibleAnchorOffset(rows));
      const target = count <= VISIBLE_SCROLL_STEP
        ? trayList.scrollHeight
        : rows[currentIndex + VISIBLE_SCROLL_STEP]?.offsetTop ?? trayList.scrollHeight;
      trayList.scrollTo({ behavior: 'smooth', top: target });
      requestAnimationFrame(() => updateScrollState(target));
    });
  }
  return button;
}

function renderTray(list) {
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

  trayList.replaceChildren();
  trayList.dataset.avatarOverlaySize = 'notification-tray-list';
  trayList.setAttribute('aria-label', 'Activity notifications');
  list.forEach((notification, index) => trayList.appendChild(makeRow(notification, index)));
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

function updateCounts(list) {
  const counts = visibleSessionCount(list);
  if (window.agentUI && typeof window.agentUI.reportCatCounts === 'function') {
    window.agentUI.reportCatCounts({ active: counts.active, inReview: counts.review });
  }
}

function reportElementSize(list) {
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
      tray: list.length > 0 ? {
        width: Math.ceil(trayWidth),
        height: Math.ceil(trayHeight),
      } : null,
    };
    const key = JSON.stringify(payload);
    if (key === lastElementSizePayload) return;
    lastElementSizePayload = key;
    window.agentUI.reportPetElementSize(payload);
  });
}

function renderAll() {
  const list = notifications();
  if (root) root.hidden = false;
  if (shell) shell.hidden = false;
  renderMascot(list);
  renderTray(list);
  setPetKeyboardInteraction(replyingTo != null && list.some((notification) => notification.id === replyingTo));
  updateCounts(list);
  reportElementSize(list);
  schedulePetPointerInteraction();
  reportEvalUiState(list);
  traceEvalEvent('pet_rendered', { notificationCount: list.length });
}

function upsertSession(payload = {}) {
  const catId = String(payload.catId || '').trim();
  if (!catId) return null;
  const existing = sessions.get(catId) || {
    catId,
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
  if (payload.result != null && String(payload.result).trim()) existing.finishLine = String(payload.result).trim();
  if (payload.finishBubbleLine != null && String(payload.finishBubbleLine).trim()) existing.finishLine = String(payload.finishBubbleLine).trim();
  existing.updatedAt = Date.now();
  sessions.set(catId, existing);
  return existing;
}

function applyStreamBubble(ev = {}) {
  const catId = String(ev.catId || '').trim();
  if (!catId) return;
  const session = sessions.get(catId) || upsertSession({ catId, status: 'running' });
  if (!session) return;
  const text = String(ev.text || '').trim();
  if (!text) return;
  session.streamBubble = text;
  if (normalizeStatus(session.status) === 'idle') session.status = 'running';
  session.updatedAt = Date.now();
  sessions.set(catId, session);
  traceEvalEvent('stream_bubble_rendered', { catId, textLength: text.length });
  renderAll();
}

function applyFinish(ev = {}) {
  const catId = String(ev.catId || '').trim();
  if (!catId) return;
  const session = sessions.get(catId) || upsertSession({ catId });
  if (!session) return;
  session.status = ev.status != null ? String(ev.status) : session.status;
  if (ev.result != null && String(ev.result).trim()) session.finishLine = String(ev.result).trim();
  if (ev.finishBubbleLine != null && String(ev.finishBubbleLine).trim()) session.finishLine = String(ev.finishBubbleLine).trim();
  session.updatedAt = Date.now();
  sessions.set(catId, session);
  pendingFinishes.delete(catId);
  traceEvalEvent('terminal_visual_rendered', {
    catId,
    status: normalizeStatus(session.status),
    textLength: String(session.finishLine || '').length,
  });
  renderAll();
}

function reactivate(catId) {
  const id = String(catId || '').trim();
  if (!id) return;
  const session = sessions.get(id);
  if (!session) return;
  session.status = 'running';
  session.updatedAt = Date.now();
  session.streamBubble = '';
  session.finishLine = '';
  renderAll();
}

function removeSession(catId) {
  const id = String(catId || '').trim();
  if (!id) return;
  sessions.delete(id);
  pendingFinishes.delete(id);
  pendingStreams.delete(id);
  expandedRows.delete(id);
  replyDrafts.delete(id);
  replyErrors.delete(id);
  submittingReplies.delete(id);
  if (replyingTo === id) replyingTo = null;
  renderAll();
}

async function boot() {
  await assetsReady;
  if (!window.agentUI) {
    renderAll();
    return;
  }

  if (typeof window.agentUI.onPetLayoutChanged === 'function') {
    window.agentUI.onPetLayoutChanged((payload) => {
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

  if (typeof window.agentUI.onPetKeyboardInteractionReady === 'function') {
    window.agentUI.onPetKeyboardInteractionReady(() => {
      const input = trayList?.querySelector('.pet-row-reply-input');
      if (input instanceof HTMLElement) input.focus();
    });
  }

  if (typeof window.agentUI.onSpawnCat === 'function') {
    window.agentUI.onSpawnCat((payload) => {
      const session = upsertSession(payload);
      if (!session) return;
      renderAll();
      if (pendingStreams.has(String(session.catId))) {
        applyStreamBubble(pendingStreams.get(String(session.catId)));
        pendingStreams.delete(String(session.catId));
      }
      if (pendingFinishes.has(String(session.catId))) {
        applyFinish(pendingFinishes.get(String(session.catId)));
        pendingFinishes.delete(String(session.catId));
      }
      traceEvalEvent('cat_spawn_rendered', { catId: String(session.catId), kind: session.kind || null });
    });
  }

  if (typeof window.agentUI.onAgentFinished === 'function') {
    window.agentUI.onAgentFinished((ev) => {
      const id = String(ev && ev.catId ? ev.catId : '').trim();
      if (!id) return;
      if (!sessions.has(id)) {
        pendingFinishes.set(id, ev || {});
        return;
      }
      applyFinish(ev || {});
    });
  }

  if (typeof window.agentUI.onAgentStreamBubble === 'function') {
    window.agentUI.onAgentStreamBubble((ev) => {
      const id = String(ev && ev.catId ? ev.catId : '').trim();
      if (!id) return;
      if (!sessions.has(id)) {
        pendingStreams.set(id, ev || {});
        return;
      }
      applyStreamBubble(ev || {});
    });
  }

  if (typeof window.agentUI.onAgentRestarted === 'function') {
    window.agentUI.onAgentRestarted((ev) => {
      if (ev && ev.catId != null) reactivate(ev.catId);
    });
  }

  if (typeof window.agentUI.onRemoveCat === 'function') {
    window.agentUI.onRemoveCat((payload) => {
      if (payload && payload.catId != null) removeSession(payload.catId);
    });
  }

  installPetPointerInteractivity();
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
    } else if (window.agentUI && typeof window.agentUI.togglePetOverlay === 'function') {
      window.agentUI.togglePetOverlay();
    }
  });

  trayList?.addEventListener('scroll', () => {
    updateScrollState();
  }, { passive: true });
  window.addEventListener('resize', () => {
    reportElementSize(notifications());
    reportEvalUiState();
  });
  window.addEventListener('beforeunload', () => {
    clearPetPointerInteraction({ force: true });
    setPetKeyboardInteraction(false);
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
