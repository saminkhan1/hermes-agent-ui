import {
  activeElementForEval,
  rectForEvalElement,
  textControlValueForEval,
  visibleTextForEval,
} from './eval-ui-state.ts';
import { insertNewlineAtCursor } from './insert-newline-at-cursor.ts';
import type {
  AgentConversationItem as ConversationItem,
  AgentConversationSnapshot,
  AgentTypingState,
} from '../../shared/contracts.ts';

const params = new URLSearchParams(window.location.search);
const conversationId = params.get('conversationId');
const logEl = document.getElementById('log');
const metaEl = document.getElementById('meta');
const statusEl = document.getElementById('typing-status');
const closeBtn = document.getElementById('btn-close');
const cancelBtn = document.getElementById('btn-cancel') as HTMLButtonElement | null;
const dismissBtn = document.getElementById('btn-dismiss') as HTMLButtonElement | null;
const followupInput = document.getElementById('followup-input') as HTMLTextAreaElement | null;
const sendBtn = document.getElementById('btn-send') as HTMLButtonElement | null;
const composerError = document.getElementById('composer-error');

type ConversationData = Partial<AgentConversationSnapshot> & {
  found?: boolean;
  locationLabel?: string;
  launchContext?: LooseBoundaryValue;
  items?: ConversationItem[];
  typing?: AgentTypingState;
};

type ConversationUpdatedEvent = {
  conversationId?: LooseBoundaryValue;
};

let unsubUpdated: null | (() => void) = null;
let lastData: ConversationData | null = null;
const CONVERSATION_ITEM_KINDS = new Set(['user', 'assistant', 'error', 'attachment']);
const AUTH_ERROR_MARKERS = [
  'provider authentication failed',
  'no inference provider configured',
  'run `hermes model`',
  "run 'hermes model'",
  'hermes model',
  'primary provider auth failed',
  'no api key',
  'api key is missing',
  'authentication failed',
];

function reportEvalUiState() {
  if (!window.agentUI || typeof window.agentUI.reportEvalUiState !== 'function') return;
  const visibleText = visibleTextForEval();
  const followupValue = textControlValueForEval(followupInput);
  const lineEntries = Array.from(document.querySelectorAll('.line'))
    .slice(0, 20)
    .map((line) => {
      const label = line.querySelector('.line-label');
      const text = line.querySelector('.line-text');
      return {
        label: label && typeof label.textContent === 'string' ? label.textContent : '',
        text: text && typeof text.textContent === 'string' ? text.textContent : '',
      };
    });
  window.agentUI.reportEvalUiState('conversation', {
    conversationId: conversationId || null,
    logRect: rectForEvalElement(logEl, { includeHidden: true }),
    followupRect: rectForEvalElement(followupInput, { includeHidden: true }),
    sendButtonRect: rectForEvalElement(sendBtn, { includeHidden: true }),
    activeElement: activeElementForEval(),
    followupValueLength: followupValue.length,
    followupValuePreview: followupValue.preview,
    ...visibleText,
    lineEntries,
  });
}

function kindToLabel(k: string, item: Partial<ConversationItem> = {}) {
  if (k === 'attachment') {
    const type = String(item.attachmentType || '')
      .trim()
      .toLowerCase();
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

function kindClass(k: string) {
  const safe = String(k).replace(/[^a-z0-9-]/gi, '') || 'item';
  return `line--${safe}`;
}

function attachmentStateText(reason: LooseBoundaryValue) {
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

function attachmentName(item: Partial<ConversationItem> = {}) {
  const descriptor = item.attachment || {};
  return String(descriptor.fileName || item.caption || `${item.attachmentType || 'file'} attachment`);
}

type AttachmentDescriptor = NonNullable<ConversationItem['attachment']>;

function isRemoteAttachmentUrl(value: LooseBoundaryValue) {
  try {
    const protocol = new URL(String(value || '')).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isRemoteAttachmentDescriptor(descriptor: Partial<AttachmentDescriptor> = {}) {
  return descriptor.source === 'remote' || isRemoteAttachmentUrl(descriptor.url);
}

function appendAttachmentOpenCard(
  wrap: HTMLElement,
  item: Partial<ConversationItem>,
  descriptor: Partial<AttachmentDescriptor>,
) {
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

function renderAttachmentContent(item: Partial<ConversationItem> = {}) {
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
    if (isRemoteAttachmentDescriptor(descriptor)) {
      return appendAttachmentOpenCard(wrap, item, descriptor);
    }
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

    return appendAttachmentOpenCard(wrap, item, descriptor);
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

function isAuthErrorText(value: LooseBoundaryValue) {
  const text = String(value || '').toLowerCase();
  return AUTH_ERROR_MARKERS.some((marker) => text.includes(marker));
}

function renderAuthErrorAction() {
  const wrap = document.createElement('div');
  wrap.className = 'line-action-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'line-action';
  button.textContent = 'Connect Hermes';
  button.addEventListener('click', () => {
    if (typeof window.agentUI?.openHermesAuth === 'function') {
      window.agentUI.openHermesAuth();
    }
  });
  wrap.appendChild(button);
  return wrap;
}

function renderLogItems(items: ConversationItem[] = []) {
  logEl!.replaceChildren();
  for (const item of items || []) {
    if (!item || !CONVERSATION_ITEM_KINDS.has(item.kind)) continue;

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
      if (item.kind === 'error' && isAuthErrorText(text.textContent)) {
        text.appendChild(renderAuthErrorAction());
      }
    }

    line.append(label, text);
    logEl!.appendChild(line);
  }
}

function isDismissibleConversation(data: ConversationData | null) {
  const status = String((data && data.runStatus) || '').toLowerCase();
  return (
    status === 'completed' ||
    status === 'error' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'canceled'
  );
}

function isCancelableConversation(data: ConversationData | null) {
  return String((data && data.runStatus) || '').toLowerCase() === 'running';
}

function updateComposerFromData(data: ConversationData | null) {
  if (!followupInput || !sendBtn) return;
  const ok = data && data.found;
  const canFollowup = ok;
  followupInput.disabled = !canFollowup;
  sendBtn.disabled = !canFollowup;
  followupInput.title = canFollowup ? 'Send message' : 'Session is not available';
  sendBtn.title = canFollowup ? 'Send message' : 'Session is not available';
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

function updateStatusFromData(data: ConversationData | null) {
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

function setComposerError(message: LooseBoundaryValue) {
  if (!composerError) return;
  const text = String(message || '').trim();
  composerError.hidden = !text;
  composerError.textContent = text;
}

async function render() {
  if (!window.agentUI?.getAgentConversation || !conversationId) {
    logEl!.textContent = 'No session to show.';
    updateComposerFromData(null);
    updateStatusFromData(null);
    reportEvalUiState();
    return;
  }
  const data = (await window.agentUI.getAgentConversation(conversationId)) as ConversationData | null;
  lastData = data;
  if (!data || !data.found) {
    logEl!.textContent = 'This conversation is not available yet, or the agent was not started.';
    updateComposerFromData(null);
    updateStatusFromData(null);
    reportEvalUiState();
    return;
  }

  if (data.locationLabel) {
    metaEl!.hidden = false;
    metaEl!.textContent = data.prompt ? `${data.locationLabel} - "${data.prompt}"` : data.locationLabel;
  } else {
    metaEl!.hidden = true;
  }

  renderLogItems(data.items || []);
  logEl!.scrollTop = logEl!.scrollHeight;
  updateComposerFromData(data);
  updateStatusFromData(data);
  reportEvalUiState();
}

async function sendFollowup() {
  if (!conversationId || !followupInput) return;
  const text = followupInput.value;
  if (!text.trim()) return;
  if (typeof window.agentUI.sendFollowup !== 'function') return;
  setComposerError('');
  if (sendBtn) sendBtn.disabled = true;
  try {
    const result = await window.agentUI.sendFollowup(conversationId, text);
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
  if (!conversationId) return;
  if (!isCancelableConversation(lastData)) return;
  if (typeof window.agentUI.cancelAgent !== 'function') return;
  setComposerError('');
  if (cancelBtn) cancelBtn.disabled = true;
  try {
    const result = await window.agentUI.cancelAgent(conversationId);
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

if (conversationId) {
  void render();
  if (typeof window.agentUI.onConversationUpdated === 'function') {
    unsubUpdated = window.agentUI.onConversationUpdated((ev: ConversationUpdatedEvent) => {
      if (ev && String(ev.conversationId) === String(conversationId)) {
        void render();
      }
    });
  }
} else {
  logEl!.textContent = 'Missing conversation id.';
}

function close() {
  if (typeof window.agentUI.closeConversationWindow === 'function') {
    window.agentUI.closeConversationWindow();
  }
}

function dismiss() {
  if (!conversationId) return;
  if (!isDismissibleConversation(lastData)) return;
  if (typeof window.agentUI.dismissSession === 'function') {
    window.agentUI.dismissSession(conversationId);
  }
}

closeBtn!.addEventListener('click', () => {
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
  followupInput.addEventListener('input', () => {
    reportEvalUiState();
  });

  followupInput.addEventListener('paste', () => {
    window.setTimeout(reportEvalUiState, 0);
  });

  followupInput.addEventListener('focus', () => {
    reportEvalUiState();
  });

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
window.addEventListener('load', () => {
  if (followupInput && !followupInput.disabled) followupInput.focus();
  reportEvalUiState();
});
