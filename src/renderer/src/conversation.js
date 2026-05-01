/* global cursorcats */

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
const cloudResultRow = document.getElementById('cloud-result-row');
const followupInput = document.getElementById('followup-input');
const sendBtn = document.getElementById('btn-send');

let unsubUpdated = null;
/** @type {{ runStatus?: string, canRevert?: boolean, reverted?: boolean, revertError?: string | null } | null} */
let lastData = null;
let revertInFlight = false;

function escapeText(s) {
  const t = String(s);
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function updateCloudResultRow(data) {
  if (!cloudResultRow) return;
  if (!data || !data.found || data.runtime !== 'cloud') {
    cloudResultRow.hidden = true;
    cloudResultRow.innerHTML = '';
    return;
  }
  const branches = Array.isArray(data.gitBranches) ? data.gitBranches : [];
  const prLinks = branches.filter((b) => b && b.prUrl).map((b) => String(b.prUrl));
  const branchNames = branches.filter((b) => b && b.branch).map((b) => String(b.branch));
  const repo = data.cloudRepoUrl ? String(data.cloudRepoUrl) : '';
  const ref = data.cloudStartingRef ? String(data.cloudStartingRef) : '';
  const metaBits = ['Cloud'];
  if (repo) metaBits.push(repo);
  if (ref) metaBits.push(`ref ${ref}`);

  const linksHtml = prLinks
    .map((url, i) => {
      const label = prLinks.length > 1 ? `Open PR ${i + 1}` : 'Open PR';
      return `<button type="button" class="cloud-result-link" data-url="${escapeText(url)}">${escapeText(label)}</button>`;
    })
    .join(' ');
  const branchHtml =
    prLinks.length === 0 && branchNames.length > 0
      ? `Branch: ${escapeText(branchNames.join(', '))}`
      : prLinks.length === 0
        ? 'PR link will appear here when Cursor returns it.'
        : '';

  cloudResultRow.hidden = false;
  cloudResultRow.innerHTML = `
    <span class="cloud-result-meta">${escapeText(metaBits.join(' · '))}</span>
    ${linksHtml || `<span>${branchHtml}</span>`}
  `;
}

async function render() {
  if (!window.cursorcats?.getAgentConversation || !catId) {
    logEl.textContent = 'No conversation to show.';
    updateComposerFromData(null);
    updateRevertFromData(null);
    updateRevertErrorRow(null);
    updateCloudResultRow(null);
    return;
  }
  const data = await window.cursorcats.getAgentConversation(catId);
  lastData = data;
  if (!data || !data.found) {
    logEl.textContent = 'This conversation is not available yet, or the agent was not started.';
    updateComposerFromData(null);
    updateRevertFromData(null);
    updateRevertErrorRow(null);
    updateCloudResultRow(null);
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
  updateCloudResultRow(data);
}

function sendFollowup() {
  if (!catId || !followupInput) return;
  const text = followupInput.value;
  if (!text.trim()) return;
  if (lastData && String(lastData.runStatus || '').toLowerCase() === 'running') return;
  if (typeof window.cursorcats.sendFollowup !== 'function') return;
  followupInput.value = '';
  void window.cursorcats.sendFollowup(catId, text);
  void render();
}

if (catId) {
  void render();
  if (typeof window.cursorcats.onConversationUpdated === 'function') {
    unsubUpdated = window.cursorcats.onConversationUpdated((ev) => {
      if (ev && String(ev.catId) === String(catId)) {
        void render();
      }
    });
  }
} else {
  logEl.textContent = 'Missing cat id.';
}

function close() {
  if (typeof window.cursorcats.closeConversationWindow === 'function') {
    window.cursorcats.closeConversationWindow();
  }
}

function dismiss() {
  if (!catId) return;
  if (typeof window.cursorcats.dismissCat === 'function') {
    window.cursorcats.dismissCat(catId);
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
    if (!catId || typeof window.cursorcats?.revertCat !== 'function') return;
    if (revertInFlight) return;
    if (lastData && String(lastData.runStatus || '').toLowerCase() === 'running') return;
    if (lastData && lastData.reverted) return;
    revertInFlight = true;
    updateRevertFromData(lastData);
    try {
      await window.cursorcats.revertCat(catId);
    } finally {
      revertInFlight = false;
      void render();
    }
  });
}

if (cloudResultRow) {
  cloudResultRow.addEventListener('click', (e) => {
    const target = e.target;
    const btn = target && typeof target.closest === 'function' ? target.closest('[data-url]') : null;
    const url = btn && btn.getAttribute('data-url');
    if (url && typeof window.cursorcats?.openExternalUrl === 'function') {
      void window.cursorcats.openExternalUrl(url);
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
