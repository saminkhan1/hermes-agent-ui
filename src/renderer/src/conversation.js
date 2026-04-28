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
const answerToggleBar = document.getElementById('answer-toggle-bar');
const btnViewConversation = document.getElementById('btn-view-conversation');
const btnViewAnswer = document.getElementById('btn-view-answer');
const answerErrorRow = document.getElementById('answer-error-row');
const answerPageErr = document.getElementById('answer-page-error');
const answerPreviewPane = document.getElementById('answer-preview-pane');
const answerPreviewIframe = document.getElementById('answer-preview-iframe');
const conversationSection = document.getElementById('conversation-section');
const cloudResultRow = document.getElementById('cloud-result-row');
/** @type {string | null} */
let answerPageUrl = null;
/** @type {string | null} */
let lastBoundAnswerUrl = null;
/** @type {string | null} */
let lastIframeBoundUrl = null;
/** @type {'answer' | 'conversation'} */
let answerViewMode = 'answer';
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
      assistant: 'Cat',
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

function clearAnswerPreview() {
  answerPageUrl = null;
  lastIframeBoundUrl = null;
  if (answerPreviewIframe) answerPreviewIframe.removeAttribute('src');
}

function updateAnswerPagePanel(data) {
  const elsOk =
    answerToggleBar &&
    btnViewConversation &&
    btnViewAnswer &&
    answerErrorRow &&
    answerPageErr &&
    answerPreviewPane &&
    answerPreviewIframe &&
    conversationSection;
  if (!elsOk) return;

  answerPageUrl = null;
  btnViewConversation.hidden = true;
  btnViewAnswer.hidden = true;
  answerPageErr.textContent = '';

  if (!data || !data.found) {
    answerToggleBar.hidden = true;
    answerErrorRow.hidden = true;
    answerPreviewPane.hidden = true;
    conversationSection.hidden = false;
    lastBoundAnswerUrl = null;
    clearAnswerPreview();
    return;
  }

  const url = data.answerHtmlFileUrl;
  const writeErr = data.answerHtmlWriteError;

  if (writeErr) {
    answerToggleBar.hidden = true;
    answerErrorRow.hidden = false;
    answerPageErr.textContent = `Could not save answer page: ${writeErr}`;
    answerPreviewPane.hidden = true;
    conversationSection.hidden = false;
    lastBoundAnswerUrl = null;
    clearAnswerPreview();
    return;
  }

  answerErrorRow.hidden = true;

  answerPageUrl = url ? String(url) : null;
  if (answerPageUrl !== lastBoundAnswerUrl && answerPageUrl) {
    answerViewMode = 'answer';
    lastBoundAnswerUrl = answerPageUrl;
  }

  answerToggleBar.hidden = answerViewMode === 'answer';
  btnViewConversation.hidden = answerViewMode !== 'answer';
  btnViewAnswer.hidden = answerViewMode !== 'conversation';

  const answerWorkingPane = document.getElementById('answer-working-pane');
  if (answerPageUrl) {
    if (lastIframeBoundUrl !== answerPageUrl) {
      answerPreviewIframe.src = answerPageUrl;
      lastIframeBoundUrl = answerPageUrl;
    }
    answerPreviewIframe.hidden = false;
    if (answerWorkingPane) answerWorkingPane.hidden = true;
  } else {
    answerPreviewIframe.hidden = true;
    if (answerWorkingPane) answerWorkingPane.hidden = false;
  }

  if (answerViewMode === 'answer') {
    answerPreviewPane.hidden = false;
    conversationSection.hidden = true;
  } else {
    answerPreviewPane.hidden = true;
    conversationSection.hidden = false;
  }
}

async function render() {
  if (!window.cursorcats?.getAgentConversation || !catId) {
    logEl.textContent = 'No conversation to show.';
    updateComposerFromData(null);
    updateAnswerPagePanel(null);
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
    updateAnswerPagePanel(null);
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

  logEl.innerHTML = (data.items || [])
    .filter((item) => item.kind !== 'status')
    .map(
      (item) => `
  <div class="line ${kindClass(item.kind)}">
    <span class="line-label">${escapeText(kindToLabel(item.kind))}</span>
    <div class="line-text">${escapeText(item.text).replace(/\n/g, '<br>')}</div>
  </div>
`
    )
    .join('');
  logEl.scrollTop = logEl.scrollHeight;
  updateComposerFromData(data);
  updateAnswerPagePanel(data);
  updateRevertFromData(data);
  updateRevertErrorRow(data);
  updateCloudResultRow(data);
}

function sendFollowup() {
  if (!catId || !followupInput) return;
  const text = followupInput.value.trim();
  if (!text) return;
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

function applyAnswerViewFromState() {
  if (!lastData) return;
  updateAnswerPagePanel(lastData);
}

if (btnViewConversation) {
  btnViewConversation.addEventListener('click', () => {
    answerViewMode = 'conversation';
    applyAnswerViewFromState();
  });
}

if (btnViewAnswer) {
  btnViewAnswer.addEventListener('click', () => {
    answerViewMode = 'answer';
    applyAnswerViewFromState();
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
