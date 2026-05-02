/* global agentUI */

import { insertNewlineAtCursor } from './insert-newline-at-cursor.js';

const params = new URLSearchParams(window.location.search);
const catId = params.get('catId');
const logEl = document.getElementById('log');
const metaEl = document.getElementById('meta');
const closeBtn = document.getElementById('btn-close');
const dismissBtn = document.getElementById('btn-dismiss');
const followupInput = document.getElementById('followup-input');
const sendBtn = document.getElementById('btn-send');
const composerError = document.getElementById('composer-error');

let unsubUpdated = null;
let lastData = null;

function rectFor(el) {
  if (!(el instanceof HTMLElement)) return null;
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

function reportEvalUiState() {
  if (!window.agentUI || typeof window.agentUI.reportEvalUiState !== 'function') return;
  const visibleText = document.body && typeof document.body.innerText === 'string'
    ? document.body.innerText.replace(/\s+/g, ' ').trim()
    : '';
  const lineEntries = Array.from(document.querySelectorAll('.line')).slice(0, 20).map((line) => {
    const label = line.querySelector('.line-label');
    const text = line.querySelector('.line-text');
    return {
      label: label && typeof label.textContent === 'string' ? label.textContent : '',
      text: text && typeof text.textContent === 'string' ? text.textContent : '',
    };
  });
  window.agentUI.reportEvalUiState('conversation', {
    catId: catId || null,
    logRect: rectFor(logEl),
    followupRect: rectFor(followupInput),
    activeElement: document.activeElement ? { id: document.activeElement.id || '', tag: document.activeElement.tagName || '' } : null,
    visibleTextLength: visibleText.length,
    visibleTextPreview: visibleText.slice(0, 4000),
    lineEntries,
  });
}

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

function isRunningConversation(data) {
  return data && String(data.runStatus || '').toLowerCase() === 'running';
}

function isDismissibleConversation(data) {
  const status = String((data && data.runStatus) || '').toLowerCase();
  return status === 'completed' || status === 'error' || status === 'failed' || status === 'cancelled' || status === 'canceled';
}

function updateComposerFromData(data) {
  if (!followupInput || !sendBtn) return;
  const running = isRunningConversation(data);
  const ok = data && data.found;
  followupInput.disabled = !ok || running;
  sendBtn.disabled = !ok || running;
  if (dismissBtn) {
    const canDismiss = ok && isDismissibleConversation(data);
    dismissBtn.disabled = !canDismiss;
    dismissBtn.title = canDismiss ? 'Dismiss session' : 'Dismiss is available after Hermes finishes';
  }
}

function setComposerError(message) {
  if (!composerError) return;
  const text = String(message || '').trim();
  composerError.hidden = !text;
  composerError.textContent = text;
}

async function render() {
  if (!window.agentUI?.getAgentConversation || !catId) {
    logEl.textContent = 'No conversation to show.';
    updateComposerFromData(null);
    reportEvalUiState();
    return;
  }
  const data = await window.agentUI.getAgentConversation(catId);
  lastData = data;
  if (!data || !data.found) {
    logEl.textContent = 'This conversation is not available yet, or the agent was not started.';
    updateComposerFromData(null);
    reportEvalUiState();
    return;
  }

  if (data.locationLabel) {
    metaEl.hidden = false;
    metaEl.textContent = data.prompt ? `${data.locationLabel} - "${data.prompt}"` : data.locationLabel;
  } else {
    metaEl.hidden = true;
  }

  renderLogItems(data.items || []);
  logEl.scrollTop = logEl.scrollHeight;
  updateComposerFromData(data);
  reportEvalUiState();
}

async function sendFollowup() {
  if (!catId || !followupInput) return;
  const text = followupInput.value;
  if (!text.trim()) return;
  if (lastData && String(lastData.runStatus || '').toLowerCase() === 'running') return;
  if (typeof window.agentUI.sendFollowup !== 'function') return;
  setComposerError('');
  if (sendBtn) sendBtn.disabled = true;
  try {
    const result = await window.agentUI.sendFollowup(catId, text);
    if (result && result.ok === false) {
      setComposerError(result.error || 'Unable to send follow-up.');
      updateComposerFromData(lastData);
      return;
    }
    followupInput.value = '';
    await render();
  } catch {
    setComposerError('Unable to send follow-up.');
    updateComposerFromData(lastData);
  }
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
  logEl.textContent = 'Missing session id.';
}

function close() {
  if (typeof window.agentUI.closeConversationWindow === 'function') {
    window.agentUI.closeConversationWindow();
  }
}

function dismiss() {
  if (!catId) return;
  if (!isDismissibleConversation(lastData)) return;
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

if (sendBtn) {
  sendBtn.addEventListener('click', () => {
    void sendFollowup();
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
    void sendFollowup();
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

window.addEventListener('resize', reportEvalUiState);
window.addEventListener('load', reportEvalUiState);
