/* global agentUI */

import { insertNewlineAtCursor } from './insert-newline-at-cursor.js';

const params = new URLSearchParams(window.location.search);
const catId = params.get('catId');
const logEl = document.getElementById('log');
const metaEl = document.getElementById('meta');
const statusEl = document.getElementById('typing-status');
const closeBtn = document.getElementById('btn-close');
const cancelBtn = document.getElementById('btn-cancel');
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

function kindToLabel(k, item = {}) {
  if (k === 'attachment') {
    const type = String(item.attachmentType || '').trim().toLowerCase();
    if (type === 'image') return 'Image';
    if (type === 'video') return 'Video';
    if (type === 'voice') return 'Audio';
    return 'Document';
  }
  return (
    {
      user: 'You',
      assistant: 'Agent',
      error: 'Error',
    }[k] || k
  );
}

function kindClass(k) {
  const safe = String(k).replace(/[^a-z0-9-]/gi, '') || 'item';
  return `line--${safe}`;
}

function attachmentStateText(reason) {
  return (
    {
      missing: 'Attachment unavailable',
      not_file: 'Attachment unavailable',
      unsupported_type: 'Unsupported attachment',
      too_large: 'Attachment too large',
      missing_ref: 'Attachment unavailable',
      unsupported_ref: 'Unsupported attachment',
    }[String(reason || '')] || 'Attachment unavailable'
  );
}

function attachmentName(item = {}) {
  const descriptor = item.attachment || {};
  return String(descriptor.fileName || item.caption || `${item.attachmentType || 'file'} attachment`);
}

function renderAttachmentContent(item = {}) {
  const descriptor = item.attachment || {};
  const type = String(item.attachmentType || '').toLowerCase();
  const wrap = document.createElement('div');
  wrap.className = 'attachment';

  const caption = String(item.caption || '').trim();
  if (caption) {
    const captionEl = document.createElement('div');
    captionEl.className = 'attachment-caption';
    captionEl.textContent = caption;
    wrap.appendChild(captionEl);
  }

  if (descriptor.status === 'ready' && descriptor.url) {
    if (type === 'image') {
      const img = document.createElement('img');
      img.className = 'attachment-media';
      img.src = descriptor.url;
      img.alt = caption || attachmentName(item);
      img.loading = 'lazy';
      wrap.appendChild(img);
      return wrap;
    }
    if (type === 'video') {
      const video = document.createElement('video');
      video.className = 'attachment-media';
      video.src = descriptor.url;
      video.controls = true;
      video.preload = 'metadata';
      wrap.appendChild(video);
      return wrap;
    }
    if (type === 'voice') {
      const audio = document.createElement('audio');
      audio.className = 'attachment-media';
      audio.src = descriptor.url;
      audio.controls = true;
      audio.preload = 'metadata';
      wrap.appendChild(audio);
      return wrap;
    }

    const file = document.createElement('div');
    file.className = 'attachment-file';
    const name = document.createElement('span');
    name.className = 'attachment-file-name';
    name.textContent = attachmentName(item);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'attachment-open';
    open.textContent = 'Open';
    open.addEventListener('click', async () => {
      if (typeof window.agentUI?.openAgentAttachment !== 'function') return;
      setComposerError('');
      try {
        const result = await window.agentUI.openAgentAttachment(descriptor.url);
        if (result && result.ok === false) setComposerError(result.error || 'Unable to open attachment.');
      } catch {
        setComposerError('Unable to open attachment.');
      }
    });
    file.append(name, open);
    wrap.appendChild(file);
    return wrap;
  }

  const state = document.createElement('div');
  state.className = 'attachment-state';
  const text = document.createElement('span');
  text.className = 'attachment-state-text';
  text.textContent = `${attachmentStateText(descriptor.reason)} - ${attachmentName(item)}`;
  state.appendChild(text);
  wrap.appendChild(state);
  return wrap;
}

function renderLogItems(items) {
  logEl.replaceChildren();
  for (const item of items || []) {
    if (!item || !['user', 'assistant', 'error', 'attachment'].includes(item.kind)) continue;

    const line = document.createElement('div');
    line.className = `line ${kindClass(item.kind)}`;

    const label = document.createElement('span');
    label.className = 'line-label';
    label.textContent = kindToLabel(item.kind, item);

    const text = document.createElement('div');
    text.className = 'line-text';
    if (item.kind === 'attachment') {
      text.appendChild(renderAttachmentContent(item));
    } else {
      text.textContent = item.text == null ? '' : String(item.text);
    }

    line.append(label, text);
    logEl.appendChild(line);
  }
}

function isDismissibleConversation(data) {
  const status = String((data && data.runStatus) || '').toLowerCase();
  return status === 'completed' || status === 'error' || status === 'failed' || status === 'cancelled' || status === 'canceled';
}

function isCancelableConversation(data) {
  return String((data && data.runStatus) || '').toLowerCase() === 'running';
}

function updateComposerFromData(data) {
  if (!followupInput || !sendBtn) return;
  const ok = data && data.found;
  followupInput.disabled = !ok;
  sendBtn.disabled = !ok;
  if (cancelBtn) {
    const canCancel = ok && isCancelableConversation(data);
    cancelBtn.disabled = !canCancel;
    cancelBtn.title = canCancel ? 'Cancel Hermes run' : 'Cancel is available while Hermes is running';
  }
  if (dismissBtn) {
    const canDismiss = ok && isDismissibleConversation(data);
    dismissBtn.disabled = !canDismiss;
    dismissBtn.title = canDismiss ? 'Dismiss session' : 'Dismiss is available after Hermes finishes';
  }
}

function updateStatusFromData(data) {
  if (!statusEl) return;
  if (!data || !data.found) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    return;
  }
  const status = String(data.runStatus || '').toLowerCase();
  const typing = data.typing && data.typing.active;
  const label = typing
    ? 'Typing'
    : status === 'running'
      ? 'Running'
      : status === 'completed'
        ? 'Done'
        : status === 'cancelled' || status === 'canceled'
          ? 'Stopped'
          : status === 'error' || status === 'failed'
            ? 'Error'
            : '';
  statusEl.hidden = !label;
  statusEl.textContent = label;
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
    updateStatusFromData(null);
    reportEvalUiState();
    return;
  }
  const data = await window.agentUI.getAgentConversation(catId);
  lastData = data;
  if (!data || !data.found) {
    logEl.textContent = 'This conversation is not available yet, or the agent was not started.';
    updateComposerFromData(null);
    updateStatusFromData(null);
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
  updateStatusFromData(data);
  reportEvalUiState();
}

async function sendFollowup() {
  if (!catId || !followupInput) return;
  const text = followupInput.value;
  if (!text.trim()) return;
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

async function cancelRun() {
  if (!catId) return;
  if (!isCancelableConversation(lastData)) return;
  if (typeof window.agentUI.cancelAgent !== 'function') return;
  setComposerError('');
  if (cancelBtn) cancelBtn.disabled = true;
  try {
    const result = await window.agentUI.cancelAgent(catId);
    if (result && result.ok === false) {
      setComposerError(result.error || 'Unable to cancel session.');
      updateComposerFromData(lastData);
      return;
    }
    await render();
  } catch {
    setComposerError('Unable to cancel session.');
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

if (cancelBtn) {
  cancelBtn.addEventListener('click', () => {
    void cancelRun();
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
