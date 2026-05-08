/* global agentUI */

import type {
  HermesAuthContext as AuthContext,
  HermesAuthEvent as AuthEvent,
  HermesAuthFlow as AuthFlow,
  HermesAuthProvider as Provider,
  HermesAuthStatus as AuthStatus,
} from '../../shared/contracts.ts';

const params = new URLSearchParams(window.location.search);

const titleEl = document.getElementById('title');
const headerAppIcon = document.getElementById('header-app-icon');
const subtitleEl = document.getElementById('subtitle');
const closeBtn = document.getElementById('btn-close');
const pendingBanner = document.getElementById('pending-banner');
const stepSignin = document.getElementById('step-signin');
const stepModel = document.getElementById('step-model');
const stepStart = document.getElementById('step-start');
const connectStep = document.getElementById('connect-step');
const modelStep = document.getElementById('model-step');
const providerSelect = document.getElementById('provider-select') as HTMLSelectElement | null;
const apiPanel = document.getElementById('api-panel');
const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement | null;
const labelInput = document.getElementById('label-input') as HTMLInputElement | null;
const oauthPanel = document.getElementById('oauth-panel');
const oauthStatus = document.getElementById('oauth-status');
const oauthSummary = document.getElementById('oauth-summary');
const oauthUrlEl = document.getElementById('oauth-url') as HTMLInputElement | null;
const oauthCodeEl = document.getElementById('oauth-code') as HTMLInputElement | null;
const oauthOutput = document.getElementById('oauth-output');
const openLinkBtn = document.getElementById('btn-open-link') as HTMLButtonElement | null;
const checkOauthBtn = document.getElementById('btn-check-oauth') as HTMLButtonElement | null;
const retryOauthBtn = document.getElementById('btn-retry-oauth') as HTMLButtonElement | null;
const cancelOauthBtn = document.getElementById('btn-cancel-oauth') as HTMLButtonElement | null;
const copyLinkBtn = document.getElementById('btn-copy-link') as HTMLButtonElement | null;
const copyCodeBtn = document.getElementById('btn-copy-code') as HTMLButtonElement | null;
const modelProviderSelect = document.getElementById('model-provider-select') as HTMLSelectElement | null;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement | null;
const customModelLabel = document.getElementById('custom-model-label');
const customModelInput = document.getElementById('custom-model-input') as HTMLInputElement | null;
const modelNote = document.getElementById('model-note');
const errorEl = document.getElementById('error');
const hintEl = document.getElementById('hint');
const backBtn = document.getElementById('btn-back') as HTMLButtonElement | null;
const primaryBtn = document.getElementById('btn-primary') as HTMLButtonElement | null;

let status: AuthStatus | null = null;
let mode = '';
let step = 'connect';
let hasPendingRun = params.get('pending') === '1';
let activeOauthSessionId = '';
let latestOauthUrl = '';
let openedOauthUrl = '';
let latestUserCode = '';
let oauthTranscript = '';
let oauthCancelRequested = false;
let oauthMonitorState = 'idle';
let autoStartedOAuth = false;

function stripAnsi(value: any) {
  return String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function cleanHermesOutput(value: any) {
  return stripAnsi(value).replace(/\r/g, '');
}

function extractUrls(value: any) {
  const text = cleanHermesOutput(value);
  return Array.from(new Set((text.match(/https?:\/\/[^\s)>"']+/g) || []).map((url) => url.replace(/[.,;]+$/, ''))));
}

function extractUserCode(value: any) {
  const text = cleanHermesOutput(value);
  const explicit = text.match(/enter (?:this )?code:\s*\n\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  if (explicit) return explicit[1].trim();
  const inline = text.match(/\b(?:user[_ -]?code|code):\s*([A-Z0-9][A-Z0-9-]{3,})\b/i);
  return inline ? inline[1].trim() : '';
}

function providerLabel(provider: Provider = {}) {
  return String(provider.name || provider.id || provider.slug || '').trim();
}

function providerId(provider: Provider = {}) {
  return String(provider.id || provider.slug || '').trim();
}

function authenticatedProviderIds() {
  return new Set((status?.providers || []).map((provider) => String(provider.slug || '').trim()).filter(Boolean));
}

function sortedCatalog() {
  const authed = authenticatedProviderIds();
  const catalog = Array.isArray(status?.provider_catalog) ? status.provider_catalog : [];
  return [...catalog].sort((a, b) => {
    const aAuthed = authed.has(providerId(a)) ? 0 : 1;
    const bAuthed = authed.has(providerId(b)) ? 0 : 1;
    if (aAuthed !== bAuthed) return aAuthed - bAuthed;
    const aOauth = a.oauth_capable || a.auth_type !== 'api_key' ? 0 : 1;
    const bOauth = b.oauth_capable || b.auth_type !== 'api_key' ? 0 : 1;
    if (aOauth !== bOauth) return aOauth - bOauth;
    return providerLabel(a).localeCompare(providerLabel(b));
  });
}

function selectedCatalogProvider() {
  const id = providerSelect?.value || '';
  return sortedCatalog().find((provider) => providerId(provider) === id) || null;
}

function setError(message: unknown) {
  const text = String(message || '').trim();
  if (!errorEl) return;
  errorEl.hidden = !text;
  errorEl.textContent = text;
}

function setBusy(busy: boolean, label = '') {
  for (const el of [providerSelect, checkOauthBtn, retryOauthBtn, modelProviderSelect, modelSelect, customModelInput, primaryBtn, backBtn]) {
    if (el) el.disabled = !!busy;
  }
  if (primaryBtn && label) primaryBtn.textContent = label;
  if (!busy) {
    syncProviderMode();
    syncFooter();
  }
}

async function loadHeaderAppIcon() {
  if (!headerAppIcon || typeof window.agentUI?.getPetCharacters !== 'function') return;
  try {
    const payload = await window.agentUI.getPetCharacters();
    const spriteUrl = String(
      (payload && payload.selectedSpriteUrl) ||
      (payload && payload.selected && payload.selected.spriteUrl) ||
      ''
    ).trim();
    if (spriteUrl) headerAppIcon.style.backgroundImage = `url("${spriteUrl}")`;
  } catch {
    // Decorative only.
  }
}

function syncFooter() {
  const hasCredentials = Array.isArray(status?.providers) && status.providers.length > 0;
  if (backBtn) backBtn.hidden = step !== 'model';
  if (primaryBtn) {
    const waitingForOauth = step === 'connect' && mode === 'oauth' && !!activeOauthSessionId && (oauthMonitorState === 'waiting' || oauthMonitorState === 'stale');
    primaryBtn.hidden = false;
    primaryBtn.disabled = waitingForOauth;
    primaryBtn.textContent = step === 'model'
      ? (hasPendingRun ? 'Save & Start Task' : 'Save Model')
      : hasCredentials
        ? 'Continue'
        : waitingForOauth
          ? 'Waiting for Sign-In'
        : mode === 'api'
          ? 'Save API Key'
          : 'Open Browser Sign-In';
  }
  if (hintEl) {
    const escLabel = hasPendingRun || activeOauthSessionId || oauthMonitorState !== 'idle' ? '<kbd>Esc</kbd> hide' : '<kbd>Esc</kbd> close';
    hintEl.innerHTML = step === 'model' ? 'Choose once; Hermes remembers it' : escLabel;
  }
}

function syncSetupChrome() {
  if (pendingBanner) pendingBanner.hidden = !hasPendingRun;
  if (titleEl) titleEl.textContent = hasPendingRun ? 'Finish setup to start' : 'Finish setup';
  for (const el of [stepSignin, stepModel, stepStart]) {
    el?.classList.remove('is-active', 'is-complete');
  }
  const hasCredentials = Array.isArray(status?.providers) && status.providers.length > 0;
  if (step === 'connect') {
    stepSignin?.classList.add('is-active');
  } else {
    stepSignin?.classList.add('is-complete');
    stepModel?.classList.add('is-active');
  }
  if (status?.ready) {
    stepModel?.classList.remove('is-active');
    stepModel?.classList.add('is-complete');
    if (hasPendingRun) stepStart?.classList.add('is-active');
  } else if (hasCredentials && step === 'connect') {
    stepSignin?.classList.add('is-complete');
    stepModel?.classList.add('is-active');
  }
}

function showStep(nextStep: string) {
  step = nextStep;
  if (connectStep) connectStep.hidden = step !== 'connect';
  if (modelStep) modelStep.hidden = step !== 'model';
  syncSetupChrome();
  syncFooter();
}

function setMode(nextMode: string) {
  mode = nextMode;
  if (oauthPanel) oauthPanel.hidden = mode !== 'oauth';
  if (apiPanel) apiPanel.hidden = mode !== 'api';
  syncFooter();
}

function populateProviderSelect() {
  if (!providerSelect) return;
  const prior = providerSelect.value;
  providerSelect.replaceChildren();
  for (const provider of sortedCatalog()) {
    const option = document.createElement('option');
    option.value = providerId(provider);
    option.textContent = providerLabel(provider);
    providerSelect.appendChild(option);
  }
  if (prior && Array.from(providerSelect.options).some((option) => option.value === prior)) {
    providerSelect.value = prior;
  } else if (status?.current_provider && Array.from(providerSelect.options).some((option) => option.value === status!.current_provider)) {
    providerSelect.value = status.current_provider;
  }
  syncProviderMode();
  syncSetupChrome();
}

function syncProviderMode() {
  const provider = selectedCatalogProvider();
  const oauthCapable = !!(provider && (provider.oauth_capable || provider.auth_type !== 'api_key'));
  if (!mode) {
    setMode(oauthCapable ? 'oauth' : 'api');
  } else if (mode === 'oauth' && !oauthCapable) {
    setMode('api');
  }
}

function providerBySlug(slug: unknown) {
  return (status?.providers || []).find((provider) => String(provider.slug || '') === String(slug || '')) || null;
}

function populateModelProviders() {
  if (!modelProviderSelect) return;
  const providers = Array.isArray(status?.providers) ? status.providers : [];
  const prior = modelProviderSelect.value || status?.current_provider || '';
  modelProviderSelect.replaceChildren();
  for (const provider of providers) {
    const option = document.createElement('option');
    option.value = String(provider.slug || '');
    option.textContent = String(provider.name || provider.slug || '');
    modelProviderSelect.appendChild(option);
  }
  if (prior && Array.from(modelProviderSelect.options).some((option) => option.value === prior)) {
    modelProviderSelect.value = prior;
  }
  populateModelsForSelectedProvider();
}

function populateModelsForSelectedProvider() {
  const provider = providerBySlug(modelProviderSelect?.value);
  const models = Array.isArray(provider?.models) ? provider.models : [];
  const current = status?.current_provider === modelProviderSelect?.value ? String(status!.current_model || '') : '';
  if (modelSelect) {
    modelSelect.replaceChildren();
    for (const model of models) {
      const option = document.createElement('option');
      option.value = String(model);
      option.textContent = String(model);
      modelSelect.appendChild(option);
    }
    if (current && models.includes(current)) modelSelect.value = current;
  }
  const needsCustom = models.length === 0;
  if (customModelLabel) customModelLabel.hidden = !needsCustom;
  if (customModelInput) {
    customModelInput.hidden = !needsCustom;
    customModelInput.value = needsCustom ? current : '';
  }
  if (modelNote) {
    const total = Number(provider?.total_models || models.length || 0);
    modelNote.textContent = needsCustom
      ? 'Hermes did not return a curated model list for this provider. Enter the model id from the provider.'
      : `Showing ${models.length}${total > models.length ? ` of ${total}` : ''} models from Hermes.`;
  }
}

async function refreshStatus() {
  setError('');
  const result = await window.agentUI.getHermesAuthStatus();
  if (!result || result.ok === false) {
    status = null;
    setError((result && result.error) || 'Could not read Hermes auth status.');
    if (subtitleEl) subtitleEl.textContent = 'Hermes status is unavailable.';
    return null;
  }
  status = result;
  populateProviderSelect();
  populateModelProviders();
  syncFooter();
  if (subtitleEl) {
    if (status!.ready) {
      subtitleEl.textContent = `Ready: ${status!.current_provider} / ${status!.current_model}`;
    } else if (status!.needs_model) {
      subtitleEl.textContent = hasPendingRun
        ? 'Choose a model and your task will start automatically.'
        : 'Choose the model Hermes should use.';
    } else {
      subtitleEl.textContent = hasPendingRun
        ? 'Sign in once and your task will continue automatically.'
        : 'Sign in once, choose a model, then start working from the desktop shortcut.';
    }
  }
  return status;
}

async function saveApiKey() {
  const provider = providerSelect?.value || '';
  const apiKey = apiKeyInput?.value || '';
  const label = labelInput?.value || '';
  setBusy(true, 'Connecting');
  setError('');
  try {
    const result = await window.agentUI.addHermesApiKey({ provider, apiKey, label });
    if (!result || result.ok === false) {
      setError((result && result.error) || 'Hermes could not save that credential.');
      return;
    }
    if (apiKeyInput) apiKeyInput.value = '';
    await refreshStatus();
    showStep('model');
  } finally {
    setBusy(false);
  }
}

function appendOauthOutput(text: any) {
  oauthTranscript += cleanHermesOutput(text);
  const urls = extractUrls(oauthTranscript);
  latestOauthUrl = urls.length ? urls[urls.length - 1] : latestOauthUrl;
  latestUserCode = extractUserCode(oauthTranscript) || latestUserCode;
  updateOauthSummary();
}

function setOauthMessage(message: unknown) {
  if (!oauthOutput) return;
  oauthOutput.textContent = String(message || '').trim();
}

function setOauthStatus(message: unknown) {
  if (!oauthStatus) return;
  oauthStatus.textContent = String(message || '').trim();
}

function syncOauthActions() {
  const hasSession = !!activeOauthSessionId;
  const isStale = oauthMonitorState === 'stale';
  const isFailed = oauthMonitorState === 'failed';
  const isSuccess = oauthMonitorState === 'success';
  if (openLinkBtn) openLinkBtn.disabled = !latestOauthUrl || isSuccess;
  if (copyLinkBtn) copyLinkBtn.disabled = !latestOauthUrl;
  if (copyCodeBtn) copyCodeBtn.disabled = !latestUserCode;
  if (checkOauthBtn) {
    checkOauthBtn.hidden = !isStale;
    checkOauthBtn.disabled = !isStale;
  }
  if (retryOauthBtn) {
    retryOauthBtn.hidden = !(isStale || isFailed);
    retryOauthBtn.disabled = !(isStale || isFailed);
  }
  if (cancelOauthBtn) cancelOauthBtn.disabled = !(hasSession || isStale || isFailed);
}

function updateOauthSummary() {
  if (oauthUrlEl) oauthUrlEl.value = latestOauthUrl || '';
  if (oauthCodeEl) oauthCodeEl.value = latestUserCode || '';
  if (oauthSummary) oauthSummary.hidden = !latestOauthUrl && !latestUserCode;
  syncOauthActions();
  if (!activeOauthSessionId || oauthMonitorState !== 'waiting') return;
  if (latestOauthUrl && latestUserCode) {
    maybeOpenOauthUrl();
    setOauthStatus(openedOauthUrl === latestOauthUrl ? 'Browser opened. Enter the code there.' : 'Open the link, then paste the code.');
    setOauthMessage('Waiting for sign-in to finish.');
  } else if (latestOauthUrl) {
    maybeOpenOauthUrl();
    setOauthStatus(openedOauthUrl === latestOauthUrl ? 'Browser opened. Finish sign-in there.' : 'Open the link to continue.');
    setOauthMessage('Waiting for Hermes to provide a code.');
  } else {
    setOauthStatus('Starting browser sign-in.');
    setOauthMessage('Waiting for Hermes.');
  }
}

function maybeOpenOauthUrl() {
  if (!latestOauthUrl || openedOauthUrl === latestOauthUrl || typeof window.agentUI?.openExternalUrl !== 'function') return;
  openedOauthUrl = latestOauthUrl;
  void window.agentUI.openExternalUrl(latestOauthUrl).then((result: any) => {
    if (!result || result.ok !== false) return;
    openedOauthUrl = '';
    setError(result.error || 'Could not open the sign-in link.');
  });
}

function resetCopyButton(button: HTMLButtonElement | null) {
  if (!button) return;
  button.textContent = 'Copy';
}

async function copyText(value: unknown, button: HTMLButtonElement | null) {
  const text = String(value || '').trim();
  if (!text) return;
  try {
    const result = typeof window.agentUI?.copyText === 'function'
      ? await window.agentUI.copyText(text)
      : null;
    if (!result || result.ok === false) {
      throw new Error((result && result.error) || 'Could not copy.');
    }
    if (button) {
      button.textContent = 'Copied';
      window.setTimeout(() => resetCopyButton(button), 1200);
    }
  } catch (error) {
    const err = error as Error;
    setError(err && err.message ? err.message : 'Could not copy.');
  }
}

async function applyAuthFlowSnapshot(flow: AuthFlow = {}, reason = '') {
  if (!flow || typeof flow !== 'object') return;
  const nextState = String(flow.state || 'idle');
  oauthMonitorState = nextState;
  activeOauthSessionId = String(flow.sessionId || '');
  latestOauthUrl = String(flow.latestUrl || '');
  if (!latestOauthUrl) openedOauthUrl = '';
  latestUserCode = String(flow.userCode || '');
  if (flow.provider && providerSelect && Array.from(providerSelect.options).some((option) => option.value === flow.provider)) {
    providerSelect.value = flow.provider;
  }
  if (nextState !== 'idle') setMode('oauth');
  updateOauthSummary();
  setError('');

  if (nextState === 'waiting') {
    if (latestOauthUrl) maybeOpenOauthUrl();
    setOauthStatus(latestOauthUrl
      ? openedOauthUrl === latestOauthUrl
        ? 'Browser opened. Finish sign-in there.'
        : 'Open the link, then paste the code.'
      : 'Starting browser sign-in.');
    setOauthMessage(latestOauthUrl ? 'Waiting for sign-in to finish.' : 'Waiting for Hermes.');
  } else if (nextState === 'stale') {
    setOauthStatus('Still waiting for browser sign-in.');
    setOauthMessage('Complete sign-in in your browser, or check again if you already finished.');
  } else if (nextState === 'failed') {
    setOauthStatus('Sign-in failed.');
    setOauthMessage('Retry browser sign-in or choose another provider.');
    setError(flow.lastError || 'Hermes sign-in failed.');
  } else if (nextState === 'success') {
    activeOauthSessionId = '';
    setOauthStatus('Sign-in completed.');
    setOauthMessage('Loading models.');
    const current = await refreshStatus();
    if (current?.ready || current?.needs_model || (Array.isArray(current?.providers) && current.providers.length > 0)) {
      showStep('model');
    }
  } else if (reason === 'auth-reset') {
    activeOauthSessionId = '';
    latestOauthUrl = '';
    openedOauthUrl = '';
    latestUserCode = '';
    setOauthStatus('Ready to open the provider sign-in page.');
    setOauthMessage('');
    updateOauthSummary();
  }
  syncOauthActions();
  syncFooter();
}

async function startOAuth(opts: { retry?: boolean } = {}) {
  if (activeOauthSessionId && !opts.retry) return;
  const provider = providerSelect?.value || '';
  setMode('oauth');
  setError('');
  latestOauthUrl = '';
  openedOauthUrl = '';
  latestUserCode = '';
  oauthTranscript = '';
  oauthCancelRequested = false;
  oauthMonitorState = 'waiting';
  activeOauthSessionId = '';
  setOauthStatus('Starting browser sign-in.');
  setOauthMessage('Waiting for Hermes.');
  resetCopyButton(copyLinkBtn);
  resetCopyButton(copyCodeBtn);
  updateOauthSummary();
  if (cancelOauthBtn) cancelOauthBtn.disabled = true;
  const result = await window.agentUI.startHermesOAuth({ provider, retry: !!opts.retry });
  if (!result || result.ok === false) {
    oauthMonitorState = 'failed';
    setError((result && result.error) || 'Hermes could not start sign-in.');
    setOauthStatus('Sign-in could not start.');
    setOauthMessage('Retry browser sign-in or choose another provider.');
    syncOauthActions();
    return;
  }
  activeOauthSessionId = result.sessionId || '';
  if (result.authFlow) await applyAuthFlowSnapshot(result.authFlow, 'auth-started');
  setOauthStatus('Starting browser sign-in.');
  if (cancelOauthBtn) cancelOauthBtn.disabled = false;
  syncOauthActions();
}

async function cancelOAuth() {
  oauthCancelRequested = true;
  await window.agentUI.cancelHermesOAuth({ sessionId: activeOauthSessionId });
  oauthMonitorState = 'idle';
  activeOauthSessionId = '';
  latestOauthUrl = '';
  openedOauthUrl = '';
  latestUserCode = '';
  setOauthStatus('Sign-in canceled.');
  setOauthMessage('');
  updateOauthSummary();
  if (cancelOauthBtn) cancelOauthBtn.disabled = true;
}

async function checkOAuthNow() {
  if (typeof window.agentUI?.checkHermesAuthNow !== 'function') return;
  const result = await window.agentUI.checkHermesAuthNow();
  if (result?.authFlow) await applyAuthFlowSnapshot(result.authFlow, result.reason || 'check-now');
}

async function saveModelAndFinish() {
  const provider = modelProviderSelect?.value || '';
  const providerInfo = providerBySlug(provider);
  const models = Array.isArray(providerInfo?.models) ? providerInfo.models : [];
  const model = models.length ? (modelSelect?.value || '') : (customModelInput?.value || '');
  setBusy(true, hasPendingRun ? 'Starting' : 'Saving');
  setError('');
  try {
    const result = await window.agentUI.saveHermesModel({ provider, model });
    if (!result || result.ok === false) {
      setError((result && result.error) || 'Hermes could not save the model.');
      return;
    }
    await window.agentUI.finishHermesAuth();
  } finally {
    setBusy(false);
  }
}

async function continueFromConnect() {
  if (status?.providers && status.providers.length > 0) {
    showStep('model');
    return;
  }
  if (mode === 'oauth') {
    await startOAuth();
  } else {
    await saveApiKey();
  }
}

function maybeAutoStartOAuth() {
  if (autoStartedOAuth || !hasPendingRun || step !== 'connect' || mode !== 'oauth') return;
  if (activeOauthSessionId || oauthMonitorState !== 'idle') return;
  if (status?.providers && status.providers.length > 0) return;
  autoStartedOAuth = true;
  void startOAuth();
}

async function closeWindow() {
  if (typeof window.agentUI.dismissHermesAuth === 'function') {
    await window.agentUI.dismissHermesAuth();
  } else if (typeof window.agentUI.closeHermesAuth === 'function') {
    window.agentUI.closeHermesAuth();
  }
}

providerSelect?.addEventListener('change', () => {
  mode = '';
  autoStartedOAuth = false;
  syncProviderMode();
  syncFooter();
});

openLinkBtn?.addEventListener('click', () => {
  if (latestOauthUrl && typeof window.agentUI.openExternalUrl === 'function') {
    void (async () => {
      const result = await window.agentUI.openExternalUrl(latestOauthUrl);
      if ((!result || result.ok !== false) && activeOauthSessionId && latestOauthUrl && latestUserCode && typeof window.agentUI.dismissHermesAuth === 'function') {
        await window.agentUI.dismissHermesAuth();
      }
    })();
  }
});

checkOauthBtn?.addEventListener('click', () => {
  void checkOAuthNow();
});

retryOauthBtn?.addEventListener('click', () => {
  void startOAuth({ retry: true });
});

copyLinkBtn?.addEventListener('click', () => {
  void copyText(latestOauthUrl, copyLinkBtn);
});

copyCodeBtn?.addEventListener('click', () => {
  void copyText(latestUserCode, copyCodeBtn);
});

for (const el of [oauthUrlEl, oauthCodeEl]) {
  el?.addEventListener('focus', () => el.select());
  el?.addEventListener('click', () => el.select());
}

cancelOauthBtn?.addEventListener('click', () => {
  void cancelOAuth();
});

modelProviderSelect?.addEventListener('change', populateModelsForSelectedProvider);

backBtn?.addEventListener('click', () => {
  showStep('connect');
});

primaryBtn?.addEventListener('click', () => {
  if (step === 'model') {
    void saveModelAndFinish();
  } else {
    void continueFromConnect();
  }
});

closeBtn?.addEventListener('click', () => {
  void closeWindow();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    void closeWindow();
  }
});

window.agentUI?.onHermesAuthEvent?.((event: AuthEvent = {}) => {
  void (async () => {
    if (event.sessionId && activeOauthSessionId && event.sessionId !== activeOauthSessionId) return;
    if (event.authFlow) {
      await applyAuthFlowSnapshot(event.authFlow, event.type || '');
      return;
    }
    if (event.type === 'output') {
      if (Array.isArray(event.urls) && event.urls.length) latestOauthUrl = event.urls[event.urls.length - 1];
      if (event.userCode) latestUserCode = String(event.userCode || '');
      appendOauthOutput(event.text || '');
      return;
    }
    if (event.type === 'exit' || event.type === 'error') {
      activeOauthSessionId = '';
      oauthMonitorState = event.ok ? 'success' : 'failed';
      if (event.ok) {
        await applyAuthFlowSnapshot({ state: 'success' }, 'exit');
      } else if (oauthCancelRequested) {
        oauthCancelRequested = false;
        setOauthStatus('Sign-in canceled.');
        setOauthMessage('');
      } else {
        await applyAuthFlowSnapshot({ state: 'failed', lastError: event.stderr || event.stdout || event.error || 'Hermes sign-in failed.' }, 'error');
      }
    }
  })();
});

window.agentUI?.onHermesAuthContext?.((payload: AuthContext = {}) => {
  hasPendingRun = !!payload.hasPendingRun;
  syncSetupChrome();
  syncFooter();
  if (payload.authFlow) void applyAuthFlowSnapshot(payload.authFlow, payload.reason || '');
  maybeAutoStartOAuth();
});

void (async () => {
  await loadHeaderAppIcon();
  showStep('connect');
  const currentStatus = await refreshStatus();
  if (currentStatus?.ready || currentStatus?.needs_model) {
    showStep('model');
  } else {
    showStep('connect');
    maybeAutoStartOAuth();
  }
})();
