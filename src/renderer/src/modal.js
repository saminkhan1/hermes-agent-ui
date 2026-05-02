/* global agentUI */

import catSpriteUrl from '../../../assets/cats/cat.png';
import { insertNewlineAtCursor } from './insert-newline-at-cursor.js';

const params = new URLSearchParams(window.location.search);
const modalContextId = params.get('modalContextId') || '';

const promptEl = document.getElementById('prompt');
const headerAppIcon = document.getElementById('header-app-icon');
const errorEl = document.getElementById('error');
const hintEl = document.getElementById('spawn-hint');
const promptSendHintEl = document.getElementById('prompt-send-hint');
const btnCreateCat = document.getElementById('btn-create-cat');
const btnDictate = document.getElementById('btn-dictate');

if (headerAppIcon) {
  headerAppIcon.style.backgroundImage = `url("${catSpriteUrl}")`;
}

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
let dictationInFlight = false;

function traceEvalEvent(type, payload = {}) {
  if (!window.agentUI || typeof window.agentUI.traceEvalEvent !== 'function') return;
  window.agentUI.traceEvalEvent({ type, modalContextId: modalContextId || null, ...payload });
}

function setError(msg) {
  if (!errorEl) return;
  if (!msg) {
    errorEl.hidden = true;
    errorEl.textContent = '';
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = msg;
}

function submit() {
  setError('');
  const prompt = promptEl?.value || '';
  traceEvalEvent('submit_requested_from_modal', {
    promptLength: prompt.length,
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

async function startDictation() {
  if (dictationInFlight || !window.agentUI?.startVoiceDictation || !promptEl) return;
  dictationInFlight = true;
  if (btnDictate) {
    btnDictate.classList.add('recording');
    btnDictate.setAttribute('aria-pressed', 'true');
  }
  setError('');
  try {
    const result = await window.agentUI.startVoiceDictation();
    if (!result || !result.ok) {
      setError((result && result.error) || 'Could not start dictation.');
      return;
    }
    const transcript = String(result.transcript || '').trim();
    if (transcript) {
      const prefix = promptEl.value && !/\s$/.test(promptEl.value) ? ' ' : '';
      promptEl.value = `${promptEl.value || ''}${prefix}${transcript}`;
      promptTypedTraced = true;
      traceEvalEvent('voice_transcript_inserted', {
        deterministic: !!result.deterministic,
        transcriptLength: transcript.length,
      });
      syncPromptHeight();
      promptEl.focus();
    }
  } catch {
    setError('Could not start dictation.');
  } finally {
    dictationInFlight = false;
    if (btnDictate) {
      btnDictate.classList.remove('recording');
      btnDictate.setAttribute('aria-pressed', 'false');
    }
  }
}

function syncPromptHeight() {
  if (!promptEl) return;
  promptEl.style.height = '1px';
  promptEl.style.height = `${promptEl.scrollHeight}px`;
}

btnCreateCat?.addEventListener('click', submit);

btnDictate?.addEventListener('click', () => {
  void startDictation();
});

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
window.addEventListener('load', syncPromptHeight);

void (async () => {
  promptEl?.focus();
  syncPromptHeight();
})();
