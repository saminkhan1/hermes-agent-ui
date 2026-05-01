/* global agentUI */

import { insertNewlineAtCursor } from './insert-newline-at-cursor.js';

const params = new URLSearchParams(window.location.search);
const catId = params.get('catId');
const logEl = document.getElementById('log');
const metaEl = document.getElementById('meta');
const closeBtn = document.getElementById('btn-close');
const dismissBtn = document.getElementById('btn-dismiss');
const revertBtn = document.getElementById('btn-revert');
const revertErrorRow = document.getElementById('revert-error-row');
const revertErrorEl = document.getElementById('revert-error');
const followupInput = document.getElementById('followup-input');
const sendBtn = document.getElementById('btn-send');

let unsubUpdated = null;
/** @type {{ runStatus?: string, canRevert?: boolean, reverted?: boolean, revertError?: string | null } | null} */
let lastData = null;
let revertInFlight = false;

function kindToLabel(k) {
  return (
    {
      user: 'You',
      assistant: 'Agent',
      thinking: 'Thinking',
      tool: 'Tool',
      task: 'Task',
      system: 'System',
      error: 'Error',
    }[k] || k
  );
}

function kindClass(k) {
  const safe = String(k).replace(/[^a-z0-9-]/gi, '') || 'item';
  return `line--${safe}`;
}

function renderLogItems(items) {
  logEl.replaceChildren();
  for (const item of items || []) {
    if (!item || item.kind === 'status') continue;

    const line = document.createElement('div');
    line.className = `line ${kindClass(item.kind)}`;

    const label = document.createElement('span');
    label.className = 'line-label';
    label.textContent = kindToLabel(item.kind);

    const text = document.createElement('div');
    text.className = 'line-text';
    text.textContent = item.text == null ? '' : String(item.text);

    line.append(label, text);
    logEl.appendChild(line);
  }
}

function updateComposerFromData(data) {
  if (!followupInput || !sendBtn) return;
  const running = data && String(data.runStatus || '').toLowerCase() === 'running';
  const ok = data && data.found;
  followupInput.disabled = !ok;
  sendBtn.disabled = !ok || running;
}

/**
 * @param {{ canRevert?: boolean, reverted?: boolean, runStatus?: string, found?: boolean } | null} data
 */
function updateRevertFromData(data) {
  if (!revertBtn) return;
  if (!data || !data.found || !data.canRevert) {
    revertBtn.hidden = true;
    return;
  }
  revertBtn.hidden = false;
  const running = String(data.runStatus || '').toLowerCase() === 'running';
  if (revertInFlight) {
    revertBtn.disabled = true;
    revertBtn.textContent = 'Reverting…';
  } else if (data.reverted) {
    revertBtn.disabled = true;
    revertBtn.textContent = 'Reverted';
  } else {
    revertBtn.disabled = running;
    revertBtn.textContent = 'Revert changes';
  }
}

/**
 * @param {{ found?: boolean, revertError?: string | null } | null} data
 */
function updateRevertErrorRow(data) {
  if (!revertErrorRow || !revertErrorEl) return;
  if (!data || !data.found || !data.revertError) {
    revertErrorRow.hidden = true;
    revertErrorEl.textContent = '';
    return;
  }
  revertErrorRow.hidden = false;
  revertErrorEl.textContent = `Could not revert: ${data.revertError}`;
}

async function render() {
  if (!window.agentUI?.getAgentConversation || !catId) {
    logEl.textContent = 'No conversation to show.';
    updateComposerFromData(null);
    updateRevertFromData(null);
    updateRevertErrorRow(null);
    return;
  }
  const data = await window.agentUI.getAgentConversation(catId);
  lastData = data;
  if (!data || !data.found) {
    logEl.textContent = 'This conversation is not available yet, or the agent was not started.';
    updateComposerFromData(null);
    updateRevertFromData(null);
    updateRevertErrorRow(null);
    return;
  }

  if (data.locationLabel || data.folder) {
    metaEl.hidden = false;
    const location = data.locationLabel || data.folder;
    metaEl.textContent = data.prompt ? `${location} — “${data.prompt}”` : location;
  } else {
    metaEl.hidden = true;
  }

  renderLogItems(data.items || []);
  logEl.scrollTop = logEl.scrollHeight;
  updateComposerFromData(data);
  updateRevertFromData(data);
  updateRevertErrorRow(data);
}

function sendFollowup() {
  if (!catId || !followupInput) return;
  const text = followupInput.value;
  if (!text.trim()) return;
  if (lastData && String(lastData.runStatus || '').toLowerCase() === 'running') return;
  if (typeof window.agentUI.sendFollowup !== 'function') return;
  followupInput.value = '';
  void window.agentUI.sendFollowup(catId, text);
  void render();
}

if (catId) {
  void render();
  if (typeof window.agentUI.onConversationUpdated === 'function') {
    unsubUpdated = window.agentUI.onConversationUpdated((ev) => {
      if (ev && String(ev.catId) === String(catId)) {
        void render();
      }
    });
  }
} else {
  logEl.textContent = 'Missing cat id.';
}

function close() {
  if (typeof window.agentUI.closeConversationWindow === 'function') {
    window.agentUI.closeConversationWindow();
  }
}

function dismiss() {
  if (!catId) return;
  if (typeof window.agentUI.dismissCat === 'function') {
    window.agentUI.dismissCat(catId);
  }
}

closeBtn.addEventListener('click', () => {
  close();
});

if (dismissBtn) {
  dismissBtn.addEventListener('click', () => {
    dismiss();
  });
}

if (revertBtn) {
  revertBtn.addEventListener('click', async () => {
    if (!catId || typeof window.agentUI?.revertCat !== 'function') return;
    if (revertInFlight) return;
    if (lastData && String(lastData.runStatus || '').toLowerCase() === 'running') return;
    if (lastData && lastData.reverted) return;
    revertInFlight = true;
    updateRevertFromData(lastData);
    try {
      await window.agentUI.revertCat(catId);
    } finally {
      revertInFlight = false;
      void render();
    }
  });
}

if (sendBtn) {
  sendBtn.addEventListener('click', () => {
    sendFollowup();
  });
}

if (followupInput) {
  followupInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      insertNewlineAtCursor(followupInput);
      return;
    }
    if (e.shiftKey) return;
    e.preventDefault();
    sendFollowup();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
});

window.addEventListener('beforeunload', () => {
  if (unsubUpdated) {
    try {
      unsubUpdated();
    } catch {
      // ignore
    }
  }
});
