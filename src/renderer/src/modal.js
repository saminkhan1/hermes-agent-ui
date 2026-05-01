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
const btnChoose = document.getElementById('btn-choose-folder');
const recentFoldersContainer = document.getElementById('recent-folders-container');
const recentFoldersList = document.getElementById('recent-folders-list');
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
  hintEl.innerHTML = isApple
    ? '<kbd>⌘</kbd>+<kbd>O</kbd> folder · <kbd>Esc</kbd> cancel'
    : '<kbd>Ctrl</kbd>+<kbd>O</kbd> folder · <kbd>Esc</kbd> cancel';
}

let selectedFolder = '';
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

function syncFolderDisplay() {
  document.body.dataset.selectedFolder = selectedFolder || '';
  document.querySelectorAll('.recent-folder-item').forEach((el) => {
    el.classList.toggle('selected', el.dataset.folder === selectedFolder);
  });
}

function existingFolderItem(folder) {
  return Array.from(document.querySelectorAll('.recent-folder-item')).find((el) => el.dataset.folder === folder) || null;
}

function addFolderToList(folder, isSelected, append = false) {
  if (!recentFoldersList || !folder) return;
  const existing = existingFolderItem(folder);
  if (existing) {
    if (isSelected) {
      selectedFolder = folder;
      syncFolderDisplay();
    }
    return;
  }

  const item = document.createElement('div');
  item.className = 'list-item recent-folder-item';
  if (isSelected) item.classList.add('selected');
  item.dataset.folder = folder;

  const iconDiv = document.createElement('div');
  iconDiv.className = 'item-icon';
  iconDiv.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
    </svg>
  `;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'item-content';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'item-title';
  titleDiv.textContent = folder.split(/[/\\]/).pop() || folder;

  const subtitleDiv = document.createElement('div');
  subtitleDiv.className = 'item-subtitle';
  subtitleDiv.textContent = folder;

  contentDiv.append(titleDiv, subtitleDiv);
  item.append(iconDiv, contentDiv);
  item.addEventListener('click', () => {
    selectedFolder = folder;
    syncFolderDisplay();
    promptEl.focus();
  });

  if (append) recentFoldersList.appendChild(item);
  else recentFoldersList.prepend(item);
  if (recentFoldersContainer) recentFoldersContainer.hidden = false;
}

async function loadRecentFolders() {
  if (!window.agentUI?.getRecentFolders) return;
  try {
    const folders = await window.agentUI.getRecentFolders();
    if (Array.isArray(folders) && folders.length > 0) {
      if (!selectedFolder) selectedFolder = folders[0];
      recentFoldersList.replaceChildren();
      folders.forEach((folder) => addFolderToList(folder, folder === selectedFolder, true));
    }
  } catch {
    /* ignore */
  }
  syncPromptHeight();
}

async function onChooseFolder() {
  if (!window.agentUI?.chooseFolder) return;
  setError('');
  try {
    const picked = await window.agentUI.chooseFolder();
    if (picked) {
      selectedFolder = picked;
      addFolderToList(picked, true, false);
      syncFolderDisplay();
      promptEl.focus();
    }
  } catch {
    setError('Could not open folder picker.');
  }
}

function submit() {
  setError('');
  const prompt = promptEl.value || '';
  traceEvalEvent('submit_requested_from_modal', {
    promptLength: prompt.length,
    hasSelectedFolder: !!selectedFolder.trim(),
    selectedFolder,
  });
  if (!selectedFolder.trim()) {
    setError('Choose a folder.');
    return;
  }
  if (!prompt.trim()) {
    setError('Enter a prompt.');
    return;
  }
  if (window.agentUI?.addRecentFolder) {
    window.agentUI.addRecentFolder(selectedFolder);
  }
  if (window.agentUI?.submitNewCat) {
    window.agentUI.submitNewCat({
      folder: selectedFolder,
      prompt,
      model: 'hermes-cli',
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
  if (dictationInFlight || !window.agentUI?.startVoiceDictation) return;
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

function pushContentHeight() {
  // Static modal height; retained so textarea resizing does not resize the window.
}

function syncPromptHeight() {
  if (!promptEl) return;
  promptEl.style.height = '1px';
  promptEl.style.height = `${promptEl.scrollHeight}px`;
  pushContentHeight();
}

if (btnChoose) {
  btnChoose.addEventListener('click', () => {
    void onChooseFolder();
  });
}

if (btnCreateCat) {
  btnCreateCat.addEventListener('click', submit);
}

if (btnDictate) {
  btnDictate.addEventListener('click', () => {
    void startDictation();
  });
}

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
  } else if (e.key === 'o' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void onChooseFolder();
  }
});

window.addEventListener('resize', syncPromptHeight);
window.addEventListener('load', syncPromptHeight);

void (async () => {
  await loadRecentFolders();
  syncFolderDisplay();
  promptEl?.focus();
  syncPromptHeight();
})();
