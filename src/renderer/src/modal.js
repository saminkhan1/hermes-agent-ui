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
const btnCreateCat = document.getElementById('btn-create-cat');
const runtimeLocalBtn = document.getElementById('runtime-local');
const runtimeCloudBtn = document.getElementById('runtime-cloud');
const projectSectionTitle = document.getElementById('project-section-title');
const localProjectSection = document.getElementById('local-project-section');
const cloudProjectSection = document.getElementById('cloud-project-section');
const cloudReposList = document.getElementById('cloud-repos-list');
const cloudStartingRefInput = document.getElementById('cloud-starting-ref');
const cloudRepoSearchInput = document.getElementById('cloud-repo-search');

const DEFAULT_MODEL_ID = 'hermes-cli';

/** @type {Array<{ id: string, displayName: string, description: string }>} */
let modelsList = [];
let selectedModelId = DEFAULT_MODEL_ID;
let modelMenuOpen = false;

let selectedFolder = '';
/** @type {'local'} */
let selectedRuntime = 'local';
/** @type {Array<{ url: string }>} */
let cloudReposListData = [];
let selectedCloudRepoUrl = '';
let cloudReposLoaded = false;
let cloudReposLoadingPromise = null;

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

function syncCloudRepoDisplay() {
  document.querySelectorAll('.cloud-repo-item').forEach(el => {
    if (el.dataset.repoUrl === selectedCloudRepoUrl) {
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

function repoDisplayName(url) {
  const u = String(url || '').replace(/\/$/, '');
  const parts = u.split('/');
  const name = parts.slice(-2).join('/');
  return name || u;
}

function addCloudRepoToList(repo, isSelected) {
  if (!cloudReposList || !repo || !repo.url) return;
  const item = document.createElement('div');
  item.className = 'list-item cloud-repo-item';
  if (isSelected) item.classList.add('selected');
  item.dataset.repoUrl = repo.url;

  const iconDiv = document.createElement('div');
  iconDiv.className = 'item-icon';
  iconDiv.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
      <path d="M8 13h8"></path>
    </svg>
  `;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'item-content';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'item-title';
  titleDiv.textContent = repoDisplayName(repo.url);

  const subtitleDiv = document.createElement('div');
  subtitleDiv.className = 'item-subtitle';
  subtitleDiv.textContent = repo.url;

  contentDiv.appendChild(titleDiv);
  contentDiv.appendChild(subtitleDiv);
  item.appendChild(iconDiv);
  item.appendChild(contentDiv);

  item.addEventListener('click', () => {
    selectedCloudRepoUrl = repo.url;
    syncCloudRepoDisplay();
    promptEl.focus();
  });

  cloudReposList.appendChild(item);
}

function filteredCloudRepositories() {
  const q = cloudRepoSearchInput ? cloudRepoSearchInput.value.trim().toLowerCase() : '';
  if (!q) return cloudReposListData;
  return cloudReposListData.filter((repo) => {
    const url = String(repo.url || '').toLowerCase();
    const name = repoDisplayName(repo.url).toLowerCase();
    return url.includes(q) || name.includes(q);
  });
}

function renderCloudRepositories() {
  if (!cloudReposList) return;
  cloudReposList.innerHTML = '';
  const visibleRepos = filteredCloudRepositories();

  if (cloudReposListData.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-item';
    empty.innerHTML = `
      <div class="item-content">
        <div class="item-title">No connected repositories</div>
        <div class="item-subtitle">Connect GitHub repositories in Cursor to use cloud cats.</div>
      </div>
    `;
    cloudReposList.appendChild(empty);
  } else if (visibleRepos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-item';
    empty.innerHTML = `
      <div class="item-content">
        <div class="item-title">No matching repositories</div>
        <div class="item-subtitle">Try a different owner, repo name, or URL.</div>
      </div>
    `;
    cloudReposList.appendChild(empty);
  } else {
    visibleRepos.forEach((repo) => {
      addCloudRepoToList(repo, repo.url === selectedCloudRepoUrl);
    });
  }
  syncCloudRepoDisplay();
  syncPromptHeight();
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

async function loadCloudRepositories() {
  if (!cloudReposList) return;
  cloudReposList.innerHTML = '';
  cloudReposList.textContent = 'Loading repositories...';
  if (!window.cursorcats?.listCloudRepositories) {
    cloudReposList.textContent = 'Cloud repositories are unavailable.';
    return;
  }
  try {
    const repos = await window.cursorcats.listCloudRepositories();
    cloudReposListData = Array.isArray(repos) ? repos.filter((r) => r && r.url) : [];
  } catch {
    cloudReposListData = [];
  }

  let saved = null;
  if (window.cursorcats?.getSelectedCloudRepository) {
    try {
      saved = await window.cursorcats.getSelectedCloudRepository();
    } catch {
      saved = null;
    }
  }
  const savedUrl = saved && saved.url ? String(saved.url).trim() : '';
  if (saved && cloudStartingRefInput && typeof saved.startingRef === 'string') {
    cloudStartingRefInput.value = saved.startingRef;
  }
  if (savedUrl && cloudReposListData.some((r) => r.url === savedUrl)) {
    selectedCloudRepoUrl = savedUrl;
  } else if (!selectedCloudRepoUrl && cloudReposListData.length > 0) {
    selectedCloudRepoUrl = cloudReposListData[0].url;
  }

  renderCloudRepositories();
}

function ensureCloudRepositoriesLoaded() {
  if (cloudReposLoaded) return Promise.resolve();
  if (cloudReposLoadingPromise) return cloudReposLoadingPromise;
  cloudReposLoadingPromise = loadCloudRepositories()
    .then(() => {
      cloudReposLoaded = true;
    })
    .finally(() => {
      cloudReposLoadingPromise = null;
    });
  return cloudReposLoadingPromise;
}

function normalizeRuntime() {
  return 'local';
}

function syncRuntimeDisplay() {
  selectedRuntime = normalizeRuntime(selectedRuntime);
  const cloud = selectedRuntime === 'cloud';
  if (runtimeLocalBtn) {
    runtimeLocalBtn.classList.toggle('selected', !cloud);
    runtimeLocalBtn.setAttribute('aria-checked', cloud ? 'false' : 'true');
  }
  if (runtimeCloudBtn) {
    runtimeCloudBtn.hidden = true;
    runtimeCloudBtn.classList.toggle('selected', cloud);
    runtimeCloudBtn.setAttribute('aria-checked', cloud ? 'true' : 'false');
  }
  if (localProjectSection) localProjectSection.hidden = cloud;
  if (cloudProjectSection) cloudProjectSection.hidden = !cloud;
  if (projectSectionTitle) projectSectionTitle.textContent = cloud ? 'Cloud Repositories' : 'Projects';
  if (hintEl) {
    if (cloud) {
      hintEl.innerHTML = '<kbd>Esc</kbd> cancel';
    } else if (isApple) {
      hintEl.innerHTML = '<kbd>⌘</kbd>+<kbd>O</kbd> folder · <kbd>Esc</kbd> cancel';
    } else {
      hintEl.innerHTML = '<kbd>Ctrl</kbd>+<kbd>O</kbd> folder · <kbd>Esc</kbd> cancel';
    }
  }
  syncPromptHeight();
}

async function selectRuntime(runtime) {
  selectedRuntime = normalizeRuntime(runtime);
  syncRuntimeDisplay();
  if (selectedRuntime === 'cloud') {
    void ensureCloudRepositoriesLoaded();
  }
  if (window.cursorcats?.setSelectedRuntime) {
    try {
      await window.cursorcats.setSelectedRuntime(selectedRuntime);
    } catch {
      /* ignore */
    }
  }
  promptEl.focus();
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
  const prompt = promptEl.value || '';
  const runtime = normalizeRuntime(selectedRuntime);
  if (runtime === 'local') {
    if (!selectedFolder.trim()) {
      setError('Choose a folder.');
      return;
    }
  } else {
    if (!selectedCloudRepoUrl.trim()) {
      setError('Choose a cloud repository.');
      return;
    }
  }
  if (!prompt.trim()) {
    setError('Enter a prompt.');
    return;
  }
  if (runtime === 'local' && window.cursorcats?.addRecentFolder) {
    window.cursorcats.addRecentFolder(selectedFolder);
  }
  const startingRef = cloudStartingRefInput ? cloudStartingRefInput.value.trim() : '';
  if (runtime === 'cloud' && window.cursorcats?.setSelectedCloudRepository) {
    window.cursorcats.setSelectedCloudRepository({
      url: selectedCloudRepoUrl,
      startingRef,
    });
  }
  if (window.cursorcats?.submitNewCat) {
    window.cursorcats.submitNewCat({
      folder: runtime === 'local' ? selectedFolder : '',
      prompt,
      model: selectedModelId,
      runtime,
      cloudRepo:
        runtime === 'cloud'
          ? {
              url: selectedCloudRepoUrl,
              startingRef,
            }
          : null,
    });
  } else {
    setError('Could not reach the app. Try reopening CursorCats.');
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
    modelsList = [{ id: DEFAULT_MODEL_ID, displayName: 'Local CLI', description: '' }];
    selectedModelId = DEFAULT_MODEL_ID;
    updateModelChipLabel();
    return;
  }
  try {
    const list = await window.cursorcats.listModels();
    if (Array.isArray(list) && list.length > 0) {
      modelsList = list;
    } else {
      modelsList = [{ id: DEFAULT_MODEL_ID, displayName: 'Local CLI', description: '' }];
    }
  } catch {
    modelsList = [{ id: DEFAULT_MODEL_ID, displayName: 'Local CLI', description: '' }];
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

if (runtimeLocalBtn) {
  runtimeLocalBtn.addEventListener('click', () => {
    void selectRuntime('local');
  });
}

if (runtimeCloudBtn) {
  runtimeCloudBtn.addEventListener('click', () => {
    void selectRuntime('local');
  });
}

if (cloudStartingRefInput) {
  cloudStartingRefInput.addEventListener('input', () => {
    syncPromptHeight();
  });
  cloudStartingRefInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
}

if (cloudRepoSearchInput) {
  cloudRepoSearchInput.addEventListener('input', () => {
    renderCloudRepositories();
  });
  cloudRepoSearchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = filteredCloudRepositories()[0];
    if (first && first.url) {
      selectedCloudRepoUrl = first.url;
      syncCloudRepoDisplay();
      promptEl.focus();
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

if (btnCreateCat) {
  btnCreateCat.addEventListener('click', () => {
    submit();
  });
}

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
    e.preventDefault();
    cancel();
  } else if (e.key === 'o' && (e.metaKey || e.ctrlKey)) {
    if (selectedRuntime !== 'local') return;
    e.preventDefault();
    onChooseFolder();
  }
});

const wrap = document.querySelector('.wrap');
const header = document.querySelector('.header');
const sectionTitle = document.querySelector('.section-title');
const listEls = Array.from(document.querySelectorAll('.list'));
const footer = document.querySelector('.footer');

function pushContentHeight() {
  // No-op: modal is now a static 500px height
}

if (typeof ResizeObserver !== 'undefined') {
  if (modelMenu) {
    const rom = new ResizeObserver(() => {
      if (modelMenuOpen) syncModelMenuWrapPadding();
    });
    rom.observe(modelMenu);
  }
}
window.addEventListener('load', () => {
  syncPromptHeight();
});

void (async () => {
  syncRuntimeDisplay();
  await Promise.all([loadRecentFolders(), initModels()]);
  promptEl.focus();
  syncPromptHeight();
})();
