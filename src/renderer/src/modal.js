/* global cursorcats */

import appIconUrl from '../../../assets/icon.png';

const promptEl = document.getElementById('prompt');
const headerAppIcon = document.getElementById('header-app-icon');
if (headerAppIcon) {
  headerAppIcon.src = appIconUrl;
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
      '<kbd>Enter</kbd> new line · <kbd>⌘</kbd>+<kbd>Enter</kbd> send';
  } else {
    promptSendHintEl.innerHTML =
      '<kbd>Enter</kbd> new line · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> send';
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
    window.cursorcats.submitNewCat({ folder: selectedFolder, prompt });
  }
}

function cancel() {
  if (window.cursorcats?.cancelNewCat) {
    window.cursorcats.cancelNewCat();
  }
}

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
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submit();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
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
  const headerH = header ? header.getBoundingClientRect().height : 0;
  const sectionH = sectionTitle ? sectionTitle.getBoundingClientRect().height : 0;
  const footerH = footer ? footer.getBoundingClientRect().height : 0;
  const listNatural = measureListNaturalHeight();
  const total = bodyPad + wrapBorder + headerH + sectionH + listNatural + footerH;
  window.cursorcats.resizeModal(total);
}

if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => pushContentHeight());
  if (header) ro.observe(header);
  if (footer) ro.observe(footer);
  if (sectionTitle) ro.observe(sectionTitle);
}
const mo = new MutationObserver(() => pushContentHeight());
if (recentFoldersList) {
  mo.observe(recentFoldersList, { childList: true, subtree: true });
}
window.addEventListener('load', () => {
  syncPromptHeight();
});

loadRecentFolders();
promptEl.focus();
syncPromptHeight();
