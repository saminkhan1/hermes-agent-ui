/* global cursorcats */

import catSpriteUrl from '../../../assets/cats/cat.png';
import { insertNewlineAtCursor } from './insert-newline-at-cursor.js';

const promptEl = document.getElementById('prompt');
const headerAppIcon = document.getElementById('header-app-icon');
if (headerAppIcon) {
  headerAppIcon.style.backgroundImage = `url("${catSpriteUrl}")`;
}
const errorEl = document.getElementById('error');
const hintEl = document.getElementById('spawn-hint');
const promptSendHintEl = document.getElementById('prompt-send-hint');

const isApple =
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.userAgentData?.platform || '').toLowerCase().includes('mac');

if (promptSendHintEl) {
  if (isApple) {
    promptSendHintEl.innerHTML =
      '<kbd>Enter</kbd> send · <kbd>⌘</kbd>+<kbd>Enter</kbd> new line';
  } else {
    promptSendHintEl.innerHTML =
      '<kbd>Enter</kbd> send · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> new line';
  }
}

if (hintEl) {
  if (isApple) {
    hintEl.innerHTML = '<kbd>⌘</kbd>+<kbd>O</kbd> folder · <kbd>Esc</kbd> cancel';
  } else {
    hintEl.innerHTML = '<kbd>Ctrl</kbd>+<kbd>O</kbd> folder · <kbd>Esc</kbd> cancel';
  }
}
const btnChoose = document.getElementById('btn-choose-folder');
const recentFoldersContainer = document.getElementById('recent-folders-container');
const recentFoldersList = document.getElementById('recent-folders-list');
const modelPicker = document.getElementById('model-picker');
const modelChipLabel = document.getElementById('model-chip-label');
const modelMenu = document.getElementById('model-menu');

const DEFAULT_MODEL_ID = 'composer-2';

/** @type {Array<{ id: string, displayName: string, description: string }>} */
let modelsList = [];
let selectedModelId = DEFAULT_MODEL_ID;
let modelMenuOpen = false;

let selectedFolder = '';

function setError(msg) {
  if (!msg) {
    errorEl.hidden = true;
    errorEl.textContent = '';
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = msg;
}

function syncFolderDisplay() {
  document.querySelectorAll('.recent-folder-item').forEach(el => {
    if (el.dataset.folder === selectedFolder) {
      el.classList.add('selected');
    } else {
      el.classList.remove('selected');
    }
  });
}

function addFolderToList(folder, isSelected, append = false) {
  // Don't add duplicate
  const existing = document.querySelector(`.recent-folder-item[data-folder="${folder.replace(/"/g, '\\"')}"]`);
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
  
  contentDiv.appendChild(titleDiv);
  contentDiv.appendChild(subtitleDiv);
  
  item.appendChild(iconDiv);
  item.appendChild(contentDiv);
  
  item.addEventListener('click', () => {
    selectedFolder = folder;
    syncFolderDisplay();
    promptEl.focus();
  });
  
  if (append) {
    recentFoldersList.appendChild(item);
  } else {
    recentFoldersList.prepend(item);
  }
  
  recentFoldersContainer.hidden = false;
}

async function loadRecentFolders() {
  if (!window.cursorcats?.getRecentFolders) return;
  try {
    const folders = await window.cursorcats.getRecentFolders();
    if (folders && folders.length > 0) {
      if (!selectedFolder) {
        selectedFolder = folders[0];
      }
      
      recentFoldersList.innerHTML = '';
      folders.forEach(folder => {
        addFolderToList(folder, folder === selectedFolder, true);
      });
    }
  } catch (e) {
    // ignore
  }
  syncPromptHeight();
}

async function onChooseFolder() {
  if (!window.cursorcats?.chooseFolder) return;
  setError('');
  try {
    const picked = await window.cursorcats.chooseFolder();
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
  const prompt = (promptEl.value || '').trim();
  if (!selectedFolder.trim()) {
    setError('Choose a folder.');
    return;
  }
  if (!prompt) {
    setError('Enter a prompt.');
    return;
  }
  if (window.cursorcats?.addRecentFolder) {
    window.cursorcats.addRecentFolder(selectedFolder);
  }
  if (window.cursorcats?.submitNewCat) {
    window.cursorcats.submitNewCat({
      folder: selectedFolder,
      prompt,
      model: selectedModelId,
    });
  }
}

function cancel() {
  if (window.cursorcats?.cancelNewCat) {
    window.cursorcats.cancelNewCat();
  }
}

function updateModelChipLabel() {
  if (!modelChipLabel) return;
  const m = modelsList.find((x) => x.id === selectedModelId);
  modelChipLabel.textContent = m ? m.displayName || m.id : selectedModelId;
}

function renderModelMenu() {
  if (!modelMenu) return;
  modelMenu.innerHTML = '';
  for (const m of modelsList) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-menu-item';
    btn.setAttribute('role', 'option');
    btn.dataset.modelId = m.id;
    btn.setAttribute('aria-selected', m.id === selectedModelId ? 'true' : 'false');
    const title = document.createElement('span');
    title.textContent = m.displayName || m.id;
    btn.appendChild(title);
    if (m.description && m.description.trim()) {
      const desc = document.createElement('span');
      desc.className = 'model-menu-item-desc';
      desc.textContent = m.description.trim();
      btn.appendChild(desc);
    }
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void selectModel(m.id);
      closeModelMenu();
      promptEl.focus();
    });
    modelMenu.appendChild(btn);
  }
}

function syncModelMenuWrapPadding() {
  const w = document.querySelector('.wrap');
  if (!w) return;
  if (!modelMenuOpen || !modelMenu || modelMenu.hidden) {
    w.style.paddingBottom = '';
    pushContentHeight();
    return;
  }
  const h = Math.min(modelMenu.scrollHeight, 220) + 14;
  w.style.paddingBottom = `${h}px`;
  pushContentHeight();
}

function openModelMenu() {
  if (!modelMenu || !modelPicker) return;
  modelMenuOpen = true;
  modelMenu.hidden = false;
  modelPicker.setAttribute('aria-expanded', 'true');
  renderModelMenu();
  syncModelMenuWrapPadding();
}

function closeModelMenu() {
  if (!modelMenu || !modelPicker) return;
  modelMenuOpen = false;
  modelMenu.hidden = true;
  modelPicker.setAttribute('aria-expanded', 'false');
  syncModelMenuWrapPadding();
}

async function selectModel(id) {
  const next = String(id || '').trim() || DEFAULT_MODEL_ID;
  selectedModelId = next;
  if (window.cursorcats?.setSelectedModel) {
    try {
      await window.cursorcats.setSelectedModel(next);
    } catch {
      /* ignore */
    }
  }
  updateModelChipLabel();
}

async function initModels() {
  if (!window.cursorcats?.listModels) {
    modelsList = [{ id: DEFAULT_MODEL_ID, displayName: 'Composer 2', description: '' }];
    selectedModelId = DEFAULT_MODEL_ID;
    updateModelChipLabel();
    return;
  }
  try {
    const list = await window.cursorcats.listModels();
    if (Array.isArray(list) && list.length > 0) {
      modelsList = list;
    } else {
      modelsList = [{ id: DEFAULT_MODEL_ID, displayName: 'Composer 2', description: '' }];
    }
  } catch {
    modelsList = [{ id: DEFAULT_MODEL_ID, displayName: 'Composer 2', description: '' }];
  }
  let saved = null;
  if (window.cursorcats?.getSelectedModel) {
    try {
      saved = await window.cursorcats.getSelectedModel();
    } catch {
      saved = null;
    }
  }
  const savedId = saved && saved.id ? String(saved.id).trim() : '';
  if (savedId && modelsList.some((m) => m.id === savedId)) {
    selectedModelId = savedId;
  } else {
    selectedModelId = modelsList[0].id;
  }
  updateModelChipLabel();
  syncPromptHeight();
}

if (modelPicker) {
  modelPicker.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modelMenuOpen) {
      closeModelMenu();
    } else {
      openModelMenu();
    }
  });
}

document.addEventListener(
  'mousedown',
  (e) => {
    if (!modelMenuOpen || !modelPicker || !modelMenu) return;
    const t = e.target;
    if (modelPicker.contains(t)) return;
    if (modelMenu.contains(t)) return;
    closeModelMenu();
  },
  true
);

btnChoose.addEventListener('click', () => {
  onChooseFolder();
});

function syncPromptHeight() {
  if (!promptEl) return;
  promptEl.style.height = '1px';
  const sh = promptEl.scrollHeight;
  promptEl.style.height = `${sh}px`;
  pushContentHeight();
}

promptEl.addEventListener('input', () => {
  syncPromptHeight();
});

window.addEventListener('resize', () => {
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (modelMenuOpen) {
      e.preventDefault();
      closeModelMenu();
      return;
    }
    e.preventDefault();
    cancel();
  } else if (e.key === 'o' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    onChooseFolder();
  }
});

const wrap = document.querySelector('.wrap');
const header = document.querySelector('.header');
const sectionTitle = document.querySelector('.section-title');
const listEl = document.querySelector('.list');
const footer = document.querySelector('.footer');

function measureListNaturalHeight() {
  // .list has flex: 1, so its clientHeight/scrollHeight expand to fill the
  // window — using them here creates a resize feedback loop. Sum the direct
  // children's offsetHeights (plus the list's own vertical padding) to get
  // the true intrinsic content height instead.
  if (!listEl) return 0;
  const style = getComputedStyle(listEl);
  const padding =
    parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0');
  let total = padding;
  for (const child of listEl.children) {
    if (child.hidden || child.offsetParent === null) continue;
    const rect = child.getBoundingClientRect();
    if (rect.height > 0) total += rect.height;
  }
  return total;
}

function pushContentHeight() {
  if (!window.cursorcats?.resizeModal || !wrap) return;
  const bodyStyle = getComputedStyle(document.body);
  const bodyPad =
    parseFloat(bodyStyle.paddingTop || '0') + parseFloat(bodyStyle.paddingBottom || '0');
  const wrapStyle = getComputedStyle(wrap);
  const wrapBorder =
    parseFloat(wrapStyle.borderTopWidth || '0') + parseFloat(wrapStyle.borderBottomWidth || '0');
  const wrapPadY =
    parseFloat(wrapStyle.paddingTop || '0') + parseFloat(wrapStyle.paddingBottom || '0');
  const headerH = header ? header.getBoundingClientRect().height : 0;
  const sectionH = sectionTitle ? sectionTitle.getBoundingClientRect().height : 0;
  const footerH = footer ? footer.getBoundingClientRect().height : 0;
  const listNatural = measureListNaturalHeight();
  const total = bodyPad + wrapBorder + wrapPadY + headerH + sectionH + listNatural + footerH;
  window.cursorcats.resizeModal(total);
}

if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => pushContentHeight());
  if (header) ro.observe(header);
  if (footer) ro.observe(footer);
  if (sectionTitle) ro.observe(sectionTitle);
  if (modelMenu) {
    const rom = new ResizeObserver(() => {
      if (modelMenuOpen) syncModelMenuWrapPadding();
    });
    rom.observe(modelMenu);
  }
}
const mo = new MutationObserver(() => pushContentHeight());
if (recentFoldersList) {
  mo.observe(recentFoldersList, { childList: true, subtree: true });
}
window.addEventListener('load', () => {
  syncPromptHeight();
});

void (async () => {
  await Promise.all([loadRecentFolders(), initModels()]);
  promptEl.focus();
  syncPromptHeight();
})();
