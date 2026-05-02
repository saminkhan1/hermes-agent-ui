/* global agentUI */

import catSpriteUrl from '../../../assets/cats/cat.png';

const root = document.getElementById('pet-root');
const shell = document.getElementById('pet-shell');
const mascot = document.getElementById('pet-mascot');
const mascotSprite = document.getElementById('pet-mascot-sprite');
const badgeEl = document.getElementById('pet-badge');
const statusEl = document.getElementById('pet-status');
const subtitleEl = document.getElementById('pet-subtitle');
const tray = document.getElementById('pet-tray');
const trayList = document.getElementById('pet-tray-list');

const pendingFinishes = new Map();
const pendingStreams = new Map();
const sessions = new Map();
const assetsReady = new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve(true);
  img.onerror = () => resolve(false);
  img.src = catSpriteUrl;
});

const STATUS_PRIORITY = {
  waiting: 0,
  failed: 1,
  review: 2,
  running: 3,
  idle: 4,
};

function traceEvalEvent(type, payload = {}) {
  if (!window.agentUI || typeof window.agentUI.traceEvalEvent !== 'function') return;
  window.agentUI.traceEvalEvent({ type, ...payload });
}

function summarize(text, max = 90) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function baseName(value) {
  const text = String(value || '').replace(/[\\/]+$/, '');
  const bits = text.split(/[\\/]/).filter(Boolean);
  return bits.length ? bits[bits.length - 1] : text;
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'review' || s === 'completed') return 'review';
  if (s === 'failed' || s === 'error' || s === 'cancelled') return 'failed';
  if (s === 'waiting') return 'waiting';
  return 'idle';
}

function labelForStatus(status) {
  switch (normalizeStatus(status)) {
    case 'running': return 'Running';
    case 'review': return 'Review';
    case 'failed': return 'Failed';
    case 'waiting': return 'Waiting';
    default: return 'Idle';
  }
}

function sessionPriority(session) {
  return STATUS_PRIORITY[normalizeStatus(session.status)] ?? STATUS_PRIORITY.idle;
}

function topSession() {
  const list = [...sessions.values()];
  list.sort((a, b) => {
    const pa = sessionPriority(a);
    const pb = sessionPriority(b);
    if (pa !== pb) return pa - pb;
    return (Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  });
  return list[0] || null;
}

function visibleSessionCount() {
  let active = 0;
  let review = 0;
  for (const session of sessions.values()) {
    const state = normalizeStatus(session.status);
    if (state === 'running') active += 1;
    else if (state !== 'idle') review += 1;
  }
  return { active, review };
}

function ensureRootVisibility() {
  const visible = sessions.size > 0;
  if (root) root.hidden = !visible;
  if (shell) shell.hidden = !visible;
  if (!visible && trayList) trayList.replaceChildren();
  if (badgeEl) {
    const { active, review } = visibleSessionCount();
    badgeEl.textContent = active + review > 0 ? String(active + review) : '0';
  }
}

function setSpriteStyle(el) {
  if (!el) return;
  el.style.backgroundImage = `url("${catSpriteUrl}")`;
}

function ensureSprite(el) {
  setSpriteStyle(el);
}

function sessionTitle(session) {
  const title = summarize(session.prompt, 48);
  if (title) return title;
  if (session.folder) return baseName(session.folder);
  return `Pet ${String(session.catId || '').slice(0, 4)}`.trim();
}

function sessionSubtitle(session) {
  if (session.finishLine) return summarize(session.finishLine, 96);
  if (session.streamBubble) return summarize(session.streamBubble, 96);
  if (session.prompt) return summarize(session.prompt, 96);
  if (session.folder) return session.folder;
  return '';
}

function updateMascot() {
  const top = topSession();
  const status = top ? normalizeStatus(top.status) : 'idle';
  if (mascot) mascot.dataset.state = status;
  if (statusEl) statusEl.textContent = top ? labelForStatus(status) : 'Idle';
  if (subtitleEl) {
    subtitleEl.textContent = top
      ? sessionSubtitle(top) || 'Tap a row to open the conversation.'
      : 'Cmd+Shift+C to start a pet.';
  }
}

function postCatRects() {
  if (!window.agentUI || typeof window.agentUI.postCatScreenRects !== 'function') return;
  const shellRect = shell && !shell.hidden ? shell.getBoundingClientRect() : null;
  const wx = window.screenX ?? window.screenLeft ?? 0;
  const wy = window.screenY ?? window.screenTop ?? 0;
  const rects = [];
  const top = topSession();
  if (top && mascot && !shell.hidden) {
    const rect = mascot.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      rects.push({
        catId: String(top.catId),
        left: Math.round(wx + rect.left),
        top: Math.round(wy + rect.top),
        right: Math.round(wx + rect.right),
        bottom: Math.round(wy + rect.bottom),
      });
    }
  }
  for (const row of trayList ? trayList.querySelectorAll('.pet-row') : []) {
    if (!(row instanceof HTMLElement)) continue;
    const rect = row.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    if (shellRect && (rect.bottom < shellRect.top || rect.top > shellRect.bottom)) continue;
    const catId = row.dataset.catId;
    if (!catId) continue;
    rects.push({
      catId,
      left: Math.round(wx + rect.left),
      top: Math.round(wy + rect.top),
      right: Math.round(wx + rect.right),
      bottom: Math.round(wy + rect.bottom),
    });
  }
  window.agentUI.postCatScreenRects(rects);
}

function scheduleRects() {
  requestAnimationFrame(() => postCatRects());
}

function updateCounts() {
  const counts = visibleSessionCount();
  if (window.agentUI && typeof window.agentUI.reportCatCounts === 'function') {
    window.agentUI.reportCatCounts(counts);
  }
  if (badgeEl) badgeEl.textContent = String(counts.active + counts.review);
}

function renderSession(session) {
  let row = trayList.querySelector(`.pet-row[data-cat-id="${CSS.escape(String(session.catId))}"]`);
  const isNew = !row;
  if (!row) {
    row = document.createElement('button');
    row.type = 'button';
    row.className = 'pet-row';
    row.dataset.catId = String(session.catId);
    row.addEventListener('click', () => {
      if (window.agentUI && typeof window.agentUI.openCatConversation === 'function') {
        window.agentUI.openCatConversation(String(session.catId));
      }
    });

    const spriteWrap = document.createElement('div');
    spriteWrap.className = 'pet-row-sprite-wrap';
    const sprite = document.createElement('span');
    sprite.className = 'pet-row-sprite';
    ensureSprite(sprite);
    spriteWrap.appendChild(sprite);

    const content = document.createElement('div');
    content.className = 'pet-row-content';
    const title = document.createElement('div');
    title.className = 'pet-row-title';
    const subtitle = document.createElement('div');
    subtitle.className = 'pet-row-subtitle';
    content.append(title, subtitle);

    const status = document.createElement('div');
    status.className = 'pet-row-status';

    row.append(spriteWrap, content, status);
    trayList.appendChild(row);
  }

  const titleEl = row.querySelector('.pet-row-title');
  const subtitleEl = row.querySelector('.pet-row-subtitle');
  const statusEl = row.querySelector('.pet-row-status');
  row.dataset.state = normalizeStatus(session.status);
  if (titleEl) titleEl.textContent = sessionTitle(session);
  if (subtitleEl) subtitleEl.textContent = sessionSubtitle(session) || 'Open conversation';
  if (statusEl) statusEl.textContent = labelForStatus(session.status);

  if (isNew) {
    traceEvalEvent('cat_spawn_rendered', {
      catId: String(session.catId),
      kind: session.kind || null,
    });
  }
}

function renderAll() {
  ensureRootVisibility();
  if (!trayList) return;

  const sorted = [...sessions.values()].sort((a, b) => {
    const pa = sessionPriority(a);
    const pb = sessionPriority(b);
    if (pa !== pb) return pa - pb;
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  });

  const existing = new Set();
  for (const session of sorted) {
    existing.add(String(session.catId));
    renderSession(session);
  }

  for (const row of [...trayList.querySelectorAll('.pet-row')]) {
    if (!existing.has(String(row.dataset.catId || ''))) row.remove();
  }

  if (!sorted.length) {
    trayList.replaceChildren();
  }

  updateMascot();
  updateCounts();
  scheduleRects();
}

function upsertSession(payload = {}) {
  const catId = String(payload.catId || '').trim();
  if (!catId) return null;
  const existing = sessions.get(catId) || {
    catId,
    folder: '',
    prompt: '',
    kind: null,
    status: 'idle',
    streamBubble: '',
    finishLine: '',
    updatedAt: 0,
  };
  existing.folder = payload.folder != null ? String(payload.folder) : existing.folder;
  existing.prompt = payload.prompt != null ? String(payload.prompt) : existing.prompt;
  existing.kind = payload.kind != null ? String(payload.kind) : existing.kind;
  if (payload.status != null) existing.status = String(payload.status);
  if (payload.result != null && String(payload.result).trim()) existing.finishLine = String(payload.result).trim();
  if (payload.finishBubbleLine != null && String(payload.finishBubbleLine).trim()) existing.finishLine = String(payload.finishBubbleLine).trim();
  existing.updatedAt = Date.now();
  sessions.set(catId, existing);
  return existing;
}

function applyStreamBubble(ev = {}) {
  const catId = String(ev.catId || '').trim();
  if (!catId) return;
  const session = sessions.get(catId) || upsertSession({ catId });
  if (!session) return;
  const text = String(ev.text || '').trim();
  if (!text) return;
  session.streamBubble = text;
  session.updatedAt = Date.now();
  sessions.set(catId, session);
  const row = trayList.querySelector(`.pet-row[data-cat-id="${CSS.escape(catId)}"]`);
  if (row) {
    const subtitleEl = row.querySelector('.pet-row-subtitle');
    if (subtitleEl) subtitleEl.textContent = summarize(text, 96);
    if (!row.dataset.streamTraced) {
      row.dataset.streamTraced = '1';
      traceEvalEvent('stream_bubble_rendered', { catId, textLength: text.length });
    }
  }
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
  const row = trayList.querySelector(`.pet-row[data-cat-id="${CSS.escape(catId)}"]`);
  if (row) {
    row.dataset.state = normalizeStatus(session.status);
    const subtitleEl = row.querySelector('.pet-row-subtitle');
    if (subtitleEl) subtitleEl.textContent = summarize(session.finishLine || session.streamBubble || session.prompt, 96) || 'Finished';
    const statusEl = row.querySelector('.pet-row-status');
    if (statusEl) statusEl.textContent = labelForStatus(session.status);
    if (!row.dataset.terminalTraced) {
      row.dataset.terminalTraced = '1';
      traceEvalEvent('terminal_visual_rendered', {
        catId,
        status: normalizeStatus(session.status),
        textLength: String(session.finishLine || '').length,
      });
    }
  }
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
  const row = trayList.querySelector(`.pet-row[data-cat-id="${CSS.escape(id)}"]`);
  if (row) {
    row.dataset.streamTraced = '';
    row.dataset.terminalTraced = '';
  }
  renderAll();
}

function removeSession(catId) {
  const id = String(catId || '').trim();
  if (!id) return;
  sessions.delete(id);
  pendingFinishes.delete(id);
  pendingStreams.delete(id);
  const row = trayList.querySelector(`.pet-row[data-cat-id="${CSS.escape(id)}"]`);
  if (row) row.remove();
  renderAll();
}

async function boot() {
  await assetsReady;
  if (!window.agentUI) {
    const fallback = document.createElement('div');
    fallback.className = 'pet-shell';
    fallback.innerHTML = '<div class="pet-stage"><div class="pet-title">agent-UI</div><div class="pet-subtitle">Electron preload missing.</div></div>';
    document.body.appendChild(fallback);
    return;
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

  if (typeof window.agentUI.onClearFinishedCats === 'function') {
    window.agentUI.onClearFinishedCats(() => {
      for (const session of [...sessions.values()]) {
        if (normalizeStatus(session.status) !== 'running' && window.agentUI && typeof window.agentUI.dismissCat === 'function') {
          window.agentUI.dismissCat(String(session.catId));
        }
      }
    });
  }

  if (mascot) {
    mascot.addEventListener('click', () => {
      const top = topSession();
      if (top && window.agentUI && typeof window.agentUI.openCatConversation === 'function') {
        window.agentUI.openCatConversation(String(top.catId));
      }
    });
  }

  trayList?.addEventListener('scroll', scheduleRects, { passive: true });
  window.addEventListener('resize', scheduleRects);

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
