/* global agentUI */

import { insertNewlineAtCursor } from './insert-newline-at-cursor.js';

const params = new URLSearchParams(window.location.search);
const modalContextId = params.get('modalContextId') || '';
const inputMode = params.get('inputMode') === 'voice' ? 'voice' : 'text';

const promptEl = document.getElementById('prompt');
const headerAppIcon = document.getElementById('header-app-icon');
const errorEl = document.getElementById('error');
const hintEl = document.getElementById('spawn-hint');
const promptSendHintEl = document.getElementById('prompt-send-hint');
const btnCreateCat = document.getElementById('btn-create-cat');

const isApple =
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.userAgentData?.platform || '').toLowerCase().includes('mac');

if (promptSendHintEl) {
  promptSendHintEl.innerHTML = isApple
    ? '<kbd>Enter</kbd> send · <kbd>⌘</kbd>+<kbd>Enter</kbd> new line'
    : '<kbd>Enter</kbd> send · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> new line';
}

if (hintEl) {
  hintEl.innerHTML = '<kbd>Esc</kbd> cancel';
}

let promptTypedTraced = false;
let voiceTranscriptReady = false;

async function loadHeaderAppIcon() {
  if (!headerAppIcon || !window.agentUI || typeof window.agentUI.getPetCharacters !== 'function') return;
  try {
    const payload = await window.agentUI.getPetCharacters();
    const spriteUrl = String(
      (payload && payload.selectedSpriteUrl) ||
      (payload && payload.selected && payload.selected.spriteUrl) ||
      ''
    ).trim();
    if (spriteUrl) headerAppIcon.style.backgroundImage = `url("${spriteUrl}")`;
  } catch {
    // The modal can render without the decorative pet icon.
  }
}

function traceEvalEvent(type, payload = {}) {
  if (!window.agentUI || typeof window.agentUI.traceEvalEvent !== 'function') return;
  window.agentUI.traceEvalEvent({ type, modalContextId: modalContextId || null, ...payload });
}

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
  window.agentUI.reportEvalUiState('modal', {
    modalContextId: modalContextId || null,
    promptRect: rectFor(promptEl),
    createButtonRect: rectFor(btnCreateCat),
    activeElement: document.activeElement ? { id: document.activeElement.id || '', tag: document.activeElement.tagName || '' } : null,
    promptValueLength: promptEl && typeof promptEl.value === 'string' ? promptEl.value.length : 0,
    promptValuePreview: promptEl && typeof promptEl.value === 'string' ? promptEl.value.slice(0, 120) : '',
    visibleTextLength: visibleText.length,
    visibleTextPreview: visibleText.slice(0, 4000),
  });
}

function setError(msg) {
  if (!errorEl) return;
  if (!msg) {
    errorEl.hidden = true;
    errorEl.textContent = '';
    reportEvalUiState();
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = msg;
  reportEvalUiState();
}

function setPromptDisabled(disabled) {
  if (!promptEl) return;
  promptEl.disabled = !!disabled;
  promptEl.setAttribute('aria-busy', disabled ? 'true' : 'false');
}

function setSubmitDisabled(disabled) {
  if (!btnCreateCat) return;
  btnCreateCat.disabled = !!disabled;
}

function setVoiceStatus(message) {
  if (!promptSendHintEl) return;
  promptSendHintEl.textContent = message;
  reportEvalUiState();
}

function setVoiceProgressPlaceholder() {
  if (!promptEl) return;
  promptEl.placeholder = '';
}

function applyVoiceStatus(payload = {}) {
  if (payload.modalContextId && modalContextId && payload.modalContextId !== modalContextId) return;
  const state = String(payload.state || '').trim();
  traceEvalEvent('voice_modal_status', { state });

  if (state === 'recording') {
    voiceTranscriptReady = false;
    setError('');
    setPromptDisabled(true);
    if (promptEl) {
      promptEl.value = '';
      setVoiceProgressPlaceholder();
    }
    setVoiceStatus('Listening');
    setSubmitDisabled(true);
    syncPromptHeight();
    return;
  }

  if (state === 'transcribing') {
    setPromptDisabled(true);
    setVoiceProgressPlaceholder();
    setVoiceStatus('Transcribing');
    setSubmitDisabled(true);
    syncPromptHeight();
    return;
  }

  if (state === 'transcript_ready') {
    const transcript = String(payload.transcript || '').trim();
    voiceTranscriptReady = true;
    setPromptDisabled(false);
    if (promptEl) {
      promptEl.value = transcript;
      promptEl.placeholder = 'Review or edit the transcript.';
      promptEl.focus();
    }
    setVoiceStatus('Review transcript, then press Enter to start');
    setSubmitDisabled(false);
    syncPromptHeight();
    return;
  }

  if (state === 'error') {
    voiceTranscriptReady = false;
    setPromptDisabled(false);
    if (promptEl) {
      promptEl.placeholder = 'Type a prompt or press Esc to cancel.';
      promptEl.focus();
    }
    setVoiceStatus('Voice input failed');
    setSubmitDisabled(false);
    setError(payload.error || 'Could not capture voice input.');
    syncPromptHeight();
  }
}

function submit() {
  setError('');
  const prompt = promptEl?.value || '';
  traceEvalEvent('submit_requested_from_modal', {
    promptLength: prompt.length,
    inputMode,
    voiceTranscriptReady,
  });
  if (!prompt.trim()) {
    setError('Enter a prompt.');
    return;
  }
  if (window.agentUI?.submitNewCat) {
    window.agentUI.submitNewCat({
      prompt,
      runtime: 'local',
      modalContextId,
    });
  } else {
    setError('Could not reach the app. Try reopening agent-UI.');
  }
}

function cancel() {
  if (window.agentUI?.cancelNewCat) {
    window.agentUI.cancelNewCat();
  }
}

function syncPromptHeight() {
  if (!promptEl) return;
  promptEl.style.height = '1px';
  promptEl.style.height = `${promptEl.scrollHeight}px`;
  reportEvalUiState();
}

btnCreateCat?.addEventListener('click', submit);

if (promptEl) {
  promptEl.addEventListener('input', () => {
    if (!promptTypedTraced && promptEl.value) {
      promptTypedTraced = true;
      traceEvalEvent('prompt_typed', { promptLength: promptEl.value.length });
    }
    syncPromptHeight();
  });

  promptEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      insertNewlineAtCursor(promptEl);
      syncPromptHeight();
      return;
    }
    e.preventDefault();
    submit();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  }
});

window.addEventListener('resize', syncPromptHeight);
window.addEventListener('load', () => {
  syncPromptHeight();
  reportEvalUiState();
});

void (async () => {
  await loadHeaderAppIcon();
  if (inputMode === 'voice') {
    setPromptDisabled(true);
    setVoiceProgressPlaceholder();
    setVoiceStatus('Listening');
    setSubmitDisabled(true);
  } else {
    promptEl?.focus();
  }
  syncPromptHeight();
  reportEvalUiState();
})();

if (inputMode === 'voice' && window.agentUI && typeof window.agentUI.onVoiceInputStatus === 'function') {
  window.agentUI.onVoiceInputStatus(applyVoiceStatus);
}
