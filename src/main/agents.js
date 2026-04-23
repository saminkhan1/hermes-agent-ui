'use strict';

/**
 * One Cursor SDK agent per on-screen cat; multiple `send` runs over its lifetime.
 * Streams `run.stream()` into a per-cat conversation log for the UI.
 */

/** @typedef {{ agent: import('@cursor/february').Agent, run: import('@cursor/february').Run | null, folder: string, busy: boolean, runPromise?: Promise<void> }} ActiveEntry */

/** @type {Map<string, ActiveEntry>} */
const active = new Map();

/** @type {Map<string, { folder: string, prompt: string, items: Array<{ kind: string, text: string, at: number, streamId?: string }>, runStatus: string, endResult?: string, durationMs?: number, activeAssistantBubble?: boolean }>} */
const conversations = new Map();

/** @type {(info: { catId: string, streamBubble?: string | null }) => void} */
let onConversationPushed = () => {};

function setOnConversationPushed(fn) {
  onConversationPushed = typeof fn === 'function' ? fn : () => {};
}

/** Max chars of user task embedded in the cat-bubble system prefix (keeps sends bounded). */
const CAT_TASK_SNIPPET_MAX = 420;

/**
 * System text prepended to each `agent.send()` so replies match the on-screen cat bubble
 * and the playful first line fits the actual task.
 * @param {string} userTask
 */
function buildAddedSystemInstruction(userTask) {
  const task = String(userTask || '')
    .trim()
    .replace(/\s+/g, ' ');
  const snippet =
    task.length > CAT_TASK_SNIPPET_MAX ? `${task.slice(0, CAT_TASK_SNIPPET_MAX)}…` : task;
  const taskGrounding =
    snippet.length > 0
      ? `Ground that metaphor in this job—same topic, files, or outcome—not random cat jokes. You are working on: ${JSON.stringify(snippet)}`
      : 'Ground that metaphor in what you are doing this turn—tools, paths, errors, wins—not random cat jokes.';

  return (
    "A pixel cat on the user's screen represents this run. In each assistant " +
    'message, if you are sharing progress or a final result, start with a single ' +
    'very short, playful line (ideally 6 words or fewer), as if the cat is ' +
    'speaking: use a tiny metaphor or image (trails, maps, knots, hearths, weather, ' +
    'small crafts) that still clearly fits the real work. Then a blank line, then the rest. ' +
    'Avoid a long first line.\n\n' +
    `${taskGrounding}\n\n`
  );
}

/** First line before a paragraph break — matches the overlay “cat line” system prompt. */
function leadAssistantBubbleText(fullText) {
  const raw = String(fullText || '').trim();
  if (!raw) return null;
  const para = raw.indexOf('\n\n');
  const head = para >= 0 ? raw.slice(0, para) : raw;
  const firstLine = head.split('\n')[0].trim();
  if (!firstLine) return null;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

function getNotify(getMainWindow) {
  return (payload) => {
    const win = getMainWindow && getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent-finished', payload);
    }
  };
}

function notifyRestarted(getMainWindow, catId) {
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent-restarted', { catId: String(catId) });
  }
}

function now() {
  return Date.now();
}

/**
 * Dispose agent + clear active entry (does not touch conversation map).
 * @param {string} catId
 * @param {{ log?: Console }} [opts]
 */
async function disposeAgentResources(catId, opts = {}) {
  const { log = console } = opts;
  const id = String(catId);
  const entry = active.get(id);
  if (!entry) return;

  if (entry.run && typeof entry.run.cancel === 'function') {
    try {
      await entry.run.cancel();
    } catch {
      /* ignore */
    }
  }
  if (entry.runPromise) {
    try {
      await entry.runPromise;
    } catch {
      /* ignore */
    }
  }
  if (entry.agent && typeof entry.agent[Symbol.asyncDispose] === 'function') {
    try {
      await entry.agent[Symbol.asyncDispose]();
    } catch (e) {
      log.warn('agent dispose failed', e);
    }
  }
  active.delete(id);
}

/**
 * @param {import('@cursor/february').SDKMessage} ev
 * @param {string} catId
 */
function applyStreamMessage(ev, catId) {
  const rec = conversations.get(catId);
  if (!rec) return;

  let line = null;
  switch (ev.type) {
    case 'user': {
      const parts = (ev.message && ev.message.content) || [];
      const text = parts
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text) {
        if (
          rec.items.length === 1 &&
          rec.items[0].kind === 'user' &&
          rec.items[0].text === text
        ) {
          return; // stream replayed the same prompt we seeded
        }
        rec.activeAssistantBubble = false;
        line = { kind: 'user', text, at: now() };
      }
      break;
    }
    case 'assistant': {
      const parts = (ev.message && ev.message.content) || [];
      const chunks = [];
      for (const b of parts) {
        if (b && b.type === 'text' && b.text) chunks.push(b.text);
        else if (b && b.type === 'tool_use' && b.name) chunks.push(`[tool: ${b.name}]`);
      }
      const text = chunks.join('');
      if (!text.trim()) return;

      const msgId = ev.message && ev.message.id != null ? String(ev.message.id) : null;
      const last = rec.items.length ? rec.items[rec.items.length - 1] : null;
      let merge = false;
      if (last && last.kind === 'assistant') {
        if (msgId && last.streamId === msgId) merge = true;
        else if (!msgId && last.streamId == null && rec.activeAssistantBubble) merge = true;
      }
      if (merge && last) {
        if (text.startsWith(last.text)) {
          last.text = text;
        } else {
          last.text = (last.text || '') + text;
        }
        last.at = now();
        if (msgId) last.streamId = msgId;
        onConversationPushed({ catId, streamBubble: leadAssistantBubbleText(last.text) });
        return;
      }
      line = { kind: 'assistant', text, at: now() };
      if (msgId) line.streamId = msgId;
      rec.activeAssistantBubble = true;
      rec.items.push(line);
      onConversationPushed({ catId, streamBubble: leadAssistantBubbleText(text) });
      return;
    }
    case 'thinking': {
      if (!ev.text) break;
      const thinkId = ev.id != null ? String(ev.id) : null;
      const last = rec.items.length ? rec.items[rec.items.length - 1] : null;
      let merge = false;
      if (last && last.kind === 'thinking') {
        if (thinkId && last.streamId === thinkId) merge = true;
        else if (!thinkId && last.streamId == null) merge = true;
      }
      if (merge && last) {
        last.text = ev.text;
        last.at = now();
        if (thinkId) last.streamId = thinkId;
        onConversationPushed({ catId });
        return;
      }
      line = { kind: 'thinking', text: ev.text, at: now() };
      if (thinkId) line.streamId = thinkId;
      rec.items.push(line);
      onConversationPushed({ catId });
      return;
    }
    case 'tool_call': {
      rec.activeAssistantBubble = false;
      const extra = [ev.name, ev.status, ev.call_id].filter(Boolean).join(' · ');
      let more = extra;
      try {
        if (ev.args != null) more += `\nargs: ${JSON.stringify(ev.args).slice(0, 2000)}`;
      } catch {
        /* ignore */
      }
      line = { kind: 'tool', text: more, at: now() };
      break;
    }
    case 'status': {
      line = {
        kind: 'status',
        text: [ev.status, ev.message].filter(Boolean).join(' '),
        at: now(),
      };
      break;
    }
    case 'task': {
      const t = [ev.text, ev.status].filter(Boolean).join(' — ');
      if (t) line = { kind: 'task', text: t, at: now() };
      break;
    }
    case 'system': {
      line = { kind: 'system', text: 'system', at: now() };
      break;
    }
    default:
      break;
  }

  if (line) {
    rec.items.push(line);
    onConversationPushed({ catId });
  }
}

/**
 * @param {import('@cursor/february').Run} run
 * @param {string} catId
 */
async function drainStream(run, catId) {
  if (!run || typeof run.stream !== 'function') return;
  try {
    for await (const ev of run.stream()) {
      applyStreamMessage(ev, catId);
    }
  } catch (e) {
    const rec = conversations.get(catId);
    if (rec) {
      rec.items.push({ kind: 'error', text: (e && e.message) || String(e), at: now() });
      onConversationPushed({ catId });
    }
  }
}

function initConversationState(catId, { folder, prompt }) {
  conversations.set(catId, {
    folder: String(folder || ''),
    prompt: String(prompt || ''),
    items: prompt ? [{ kind: 'user', text: String(prompt), at: now() }] : [],
    runStatus: 'running',
    activeAssistantBubble: false,
  });
  onConversationPushed({ catId });
}

function getAgentConversation(catId) {
  const c = conversations.get(String(catId));
  if (!c) return { found: false, items: [] };
  return {
    found: true,
    folder: c.folder,
    prompt: c.prompt,
    items: c.items.map(({ kind, text, at }) => ({ kind, text, at })),
    runStatus: c.runStatus,
    endResult: c.endResult,
    durationMs: c.durationMs,
  };
}

function deleteConversationState(catId) {
  conversations.delete(String(catId));
}

/**
 * @param {string} catId
 * @param {{ getMainWindow?: () => import('electron').BrowserWindow | null, log?: Console }} opts
 */
async function dismissAgent(catId, opts = {}) {
  const { getMainWindow, log = console } = opts;
  const id = String(catId);
  await disposeAgentResources(id, { log });
  deleteConversationState(id);
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('remove-cat', { catId: id });
  }
}

/**
 * @param {string} catId
 * @param {(payload: { catId: string, status: string, result?: string, durationMs?: number }) => void} notify
 * @param {Console} log
 * @param {string} folder
 */
async function ensureAgent(catId, folder, notify, log) {
  const id = String(catId);
  const folderStr = String(folder || '');
  const existing = active.get(id);

  if (existing && existing.agent && existing.folder === folderStr) {
    return existing.agent;
  }
  if (existing && existing.agent && existing.folder !== folderStr) {
    await disposeAgentResources(id, { log });
  }

  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    throw new Error('CURSOR_API_KEY is not set');
  }

  const { Agent } = require('@cursor/february/agent');
  /** Tied to the desktop pet: short first lines read best in a tiny cat speech bubble. */

  const agent = Agent.create({
    apiKey,
    model: { id: 'composer-2' },
    local: { cwd: folderStr },
  });
  active.set(id, { agent, run: null, folder: folderStr, busy: false });
  return agent;
}

/**
 * @param {string} catId
 * @param {(payload: { catId: string, status: string, result?: string, durationMs?: number }) => void} notify
 * @param {Console} log
 * @param {string} prompt
 */
function runOnAgent(catId, notify, log, prompt) {
  const id = String(catId);
  const entry = active.get(id);
  if (!entry?.agent) {
    log.warn('runOnAgent: no agent for', id);
    return Promise.resolve();
  }
  if (entry.busy || entry.run) {
    log.warn('runOnAgent: busy', id);
    return Promise.resolve();
  }

  entry.busy = true;

  const work = (async () => {
    try {
      let run;
      const addedSystemInstruction = buildAddedSystemInstruction(prompt);
      try {
        run = await entry.agent.send(String(addedSystemInstruction + prompt));
      } catch (e) {
        log.warn('agent.send failed', e);
        const r = conversations.get(id);
        if (r) {
          const errText = (e && e.message) || String(e);
          r.runStatus = 'error';
          r.endResult = errText;
          r.items.push({ kind: 'error', text: errText, at: now() });
          r.activeAssistantBubble = false;
          onConversationPushed({ catId: id });
        }
        notify({ catId: id, status: 'error', result: (e && e.message) || String(e) });
        try {
          if (entry.agent && typeof entry.agent[Symbol.asyncDispose] === 'function') {
            await entry.agent[Symbol.asyncDispose]();
          }
        } catch (disposeErr) {
          log.warn('agent dispose after send failure', disposeErr);
        }
        active.delete(id);
        return;
      }

      entry.run = run;
      const streamP = drainStream(run, id);

      try {
        const result = await run.wait();
        await streamP;
        const r = conversations.get(id);
        if (r) {
          const st = result && result.status != null ? result.status : 'finished';
          r.runStatus = String(st);
          if (result && result.result != null) {
            r.endResult = String(result.result);
          } else {
            r.endResult = undefined;
          }
          if (result && result.durationMs != null) {
            r.durationMs = result.durationMs;
          } else {
            r.durationMs = undefined;
          }
          r.activeAssistantBubble = false;
          onConversationPushed({ catId: id });
        }
        const status = result && result.status != null ? result.status : 'finished';
        const res = result && result.result != null ? String(result.result) : undefined;
        const durationMs = result && result.durationMs != null ? result.durationMs : undefined;
        notify({ catId: id, status: String(status), result: res, durationMs });
      } catch (e) {
        log.warn('run.wait failed', e);
        const r = conversations.get(id);
        if (r) {
          r.runStatus = 'error';
          const errText = (e && e.message) || String(e);
          r.endResult = errText;
          r.items.push({ kind: 'error', text: errText, at: now() });
          r.activeAssistantBubble = false;
          onConversationPushed({ catId: id });
        }
        notify({ catId: id, status: 'error', result: (e && e.message) || String(e) });
      } finally {
        entry.run = null;
        const r2 = conversations.get(id);
        if (r2) r2.activeAssistantBubble = false;
      }
    } finally {
      entry.busy = false;
    }
  })();

  entry.runPromise = work;
  return work;
}

async function runAgentLifecycle({ catId, folder, prompt, notify, log }) {
  const id = String(catId);
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    log.warn('CURSOR_API_KEY is not set; the run will not execute.');
    const noKeyMsg = 'Set CURSOR_API_KEY in the environment to run the agent.';
    conversations.set(id, {
      folder: String(folder || ''),
      prompt: String(prompt || ''),
      items: prompt ? [{ kind: 'user', text: String(prompt), at: now() }] : [],
      runStatus: 'error',
      endResult: noKeyMsg,
      activeAssistantBubble: false,
    });
    onConversationPushed({ catId: id });
    notify({ catId: id, status: 'error', result: noKeyMsg });
    return;
  }

  initConversationState(id, { folder, prompt });

  try {
    await ensureAgent(id, folder, notify, log);
  } catch (e) {
    log.warn('Failed to create Cursor agent', e);
    const rec = conversations.get(id);
    if (rec) {
      const errText = (e && e.message) || String(e);
      rec.runStatus = 'error';
      rec.endResult = errText;
      rec.items.push({ kind: 'error', text: errText, at: now() });
      onConversationPushed({ catId: id });
    }
    notify({ catId: id, status: 'error', result: (e && e.message) || String(e) });
    return;
  }

  void runOnAgent(id, notify, log, String(prompt));
}

/**
 * Starts an async agent run for this cat. Does not block. Completion is
 * reported via `agent-finished` on the main window.
 */
function startAgentForCat({ catId, folder, prompt }, { getMainWindow, log = console } = {}) {
  const notify = getNotify(getMainWindow);
  void runAgentLifecycle({ catId: String(catId), folder, prompt, notify, log });
}

/**
 * @param {string} catId
 * @param {string} text
 * @param {{ getMainWindow?: () => import('electron').BrowserWindow | null, log?: Console }} opts
 */
function sendFollowup(catId, text, opts = {}) {
  const { getMainWindow, log = console } = opts;
  const id = String(catId);
  const t = String(text || '').trim();
  if (!t) return;

  const entry = active.get(id);
  if (!entry?.agent || entry.busy || entry.run) {
    log.warn('sendFollowup: no agent or busy', id);
    return;
  }
  if (!conversations.has(id)) {
    log.warn('sendFollowup: no conversation', id);
    return;
  }

  const rec = conversations.get(id);
  if (rec) {
    rec.items.push({ kind: 'user', text: t, at: now() });
    rec.runStatus = 'running';
    rec.endResult = undefined;
    rec.durationMs = undefined;
    rec.activeAssistantBubble = false;
    onConversationPushed({ catId: id });
  }

  notifyRestarted(getMainWindow, id);
  const notify = getNotify(getMainWindow);
  void runOnAgent(id, notify, log, t);
}

/** Best-effort cancel in-flight runs (e.g. app quit). */
function cancelAllAgents() {
  for (const [, entry] of active) {
    if (entry && entry.run && typeof entry.run.cancel === 'function') {
      void entry.run.cancel().catch(() => {});
    }
    if (entry?.agent && typeof entry.agent[Symbol.asyncDispose] === 'function') {
      void entry.agent[Symbol.asyncDispose]().catch(() => {});
    }
  }
  active.clear();
}

module.exports = {
  startAgentForCat,
  cancelAllAgents,
  getAgentConversation,
  setOnConversationPushed,
  deleteConversationState,
  dismissAgent,
  sendFollowup,
};
