'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { promisify } = require('util');
const { execFile } = require('child_process');

const execFileAsync = promisify(execFile);

/**
 * One Cursor SDK agent per on-screen cat; multiple `send` runs over its lifetime.
 * Streams `run.stream()` into a per-cat conversation log for the UI.
 */

/** @typedef {{ agent: import('@cursor/february').Agent, run: import('@cursor/february').Run | null, folder: string, modelId: string, busy: boolean, runPromise?: Promise<void> }} ActiveEntry */

/** @type {Map<string, { folder: string, prompt: string, items: Array<{ kind: string, text: string, at: number, streamId?: string }>, runStatus: string, endResult?: string, durationMs?: number, activeAssistantBubble?: boolean, answerHtmlFileUrl?: string, answerHtmlWriteError?: string, snapshotTree?: string, headShaAtSnapshot?: string, snapshotCapturedAt?: number, reverted?: boolean, revertError?: string }>} */
const conversations = new Map();

/** @type {Map<string, ActiveEntry>} */
const active = new Map();

const CURSORCATS_ANSWER_HTML_FENCE = 'cursorcats-answer-html';

function buildAnswerHtmlPageInstruction() {
  return (
    '\n\nWhen your work is complete and you send your final assistant message for this run ' +
    '(including the usual very short playful cat line, then a blank line, then the rest), ' +
    `also append a single fenced code block whose opening fence is exactly \`\`\`${CURSORCATS_ANSWER_HTML_FENCE} ` +
    'on its own line, followed by one complete HTML5 document (raw HTML only inside the block), ' +
    'then a closing ``` line. That HTML must be self-contained (embed CSS in <style> if needed), ' +
    'readable, and present your answer to the user’s prompt for standalone viewing. Prefer no JavaScript.\n' +
    '\n' +
    'Style that HTML page to match Cursorcats: the same warm, whimsical pixel-familiar ' +
    'aesthetic as the on-screen pet—cozy, playful, a little toy-box or yarn-basket, not a ' +
    'corporate report. In <head> you may @import a free bitmap/pixel font (e.g. “Press Start 2P” ' +
    'or “VT323” from Google Fonts) for headings or short labels; use legible text for long ' +
    'explanations (a crisp monospace stack is fine). ' +
    'Color story: light cream background and warm neutrals, ink foreground, orange accent ' +
    '— e.g. background #f7f7f4, main text #26251e, accent #f54e00, soft cards #f2f1ed ' +
    '(darker tints for depth: #f0efeb, #ebeae5). ' +
    'Add pixel-era polish: chunk borders, modest box-shadow “steps” or hard edges, ' +
    'image-rendering: pixelated on tiny decorations, an optional subtle grid or dot dither, ' +
    'and spare decorative touches (tiny paw, yarn, window sill) in CSS or Unicode—light touch, ' +
    'not noisy. The page should feel like the same run’s HTML souvenir as the desktop cat.\n'
  );
}

function extractAnswerHtmlBlock(fullText) {
  const re = new RegExp(
    '```' + CURSORCATS_ANSWER_HTML_FENCE + '\\s*\\n([\\s\\S]*?)```',
    'im'
  );
  const m = String(fullText || '').match(re);
  if (!m || !m[1]) return null;
  const inner = m[1].trim();
  return inner.length > 0 ? inner : null;
}

function stripAnswerHtmlFenceFromText(fullText) {
  return String(fullText || '')
    .replace(
      new RegExp('```' + CURSORCATS_ANSWER_HTML_FENCE + '[\\s\\S]*?```', 'im'),
      '\n\n[Answer layout is on the Answer page view.]\n\n'
    )
    .trim();
}

function getLastAssistantFullText(rec) {
  if (!rec || !Array.isArray(rec.items)) return '';
  for (let i = rec.items.length - 1; i >= 0; i--) {
    const it = rec.items[i];
    if (it && it.kind === 'assistant' && it.text) return String(it.text);
  }
  return '';
}

function escapeHtmlBody(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildFallbackAnswerDocument(title, bodyText) {
  const t = escapeHtmlBody((title || 'Answer').trim().slice(0, 200));
  const body = escapeHtmlBody(bodyText || '').replace(/\n/g, '<br>\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${t}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.95rem;
    line-height: 1.4;
    margin: 0;
    min-height: 100vh;
    color: #26251e;
    background: #f7f7f4
      linear-gradient(90deg, rgba(0,0,0,0.02) 1px, transparent 1px) 0 0/8px 8px;
    background-blend-mode: multiply;
  }
  .sill {
    max-width: 40rem;
    margin: 1.5rem auto;
    padding: 1.25rem 1.4rem 1.4rem;
    background: #f2f1ed;
    border: 3px solid #26251e;
    box-shadow: 4px 4px 0 #26251e, 6px 6px 0 rgba(245, 78, 0, 0.35);
    image-rendering: pixelated;
  }
  h1 {
    font-size: 1.05rem;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: #f54e00;
    margin: 0 0 0.9rem;
    text-shadow: 1px 1px 0 rgba(38, 37, 30, 0.12);
  }
  .body { white-space: pre-wrap; word-break: break-word; }
  .paw { font-size: 0.85rem; opacity: 0.4; user-select: none; }
</style>
</head>
<body>
  <div class="sill">
    <p class="paw" aria-hidden="true">🐾</p>
    <h1>${t}</h1>
    <div class="body">${body}</div>
  </div>
</body>
</html>
`;
}

function wrapFragmentAsHtml(fragment) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Answer</title>
</head>
<body>
${fragment}
</body>
</html>
`;
}

/**
 * @param {string} catId
 * @param {object} rec
 * @param {Console} log
 */
/**
 * Removes the on-disk answer page for this cat (`~/.cursorcats/answers/<catId>/`).
 * Called when the conversation is finished (dismiss) so HTML souvenirs do not linger.
 * @param {string} catId
 * @param {Console} log
 */
function deleteAnswerHtmlDirForCat(catId, log = console) {
  const id = String(catId);
  const dir = path.join(os.homedir(), '.cursorcats', 'answers', id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log.warn('answer html cleanup failed', e);
  }
}

function commitAnswerHtmlPage(catId, rec, log) {
  const id = String(catId);
  const dir = path.join(os.homedir(), '.cursorcats', 'answers', id);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    rec.answerHtmlFileUrl = undefined;
    rec.answerHtmlWriteError = (e && e.message) || String(e);
    log.warn('answer html mkdir failed', e);
    return;
  }
  const filePath = path.join(dir, 'index.html');
  const lastAssist = getLastAssistantFullText(rec);
  let html = lastAssist ? extractAnswerHtmlBlock(lastAssist) : null;
  if (!html) {
    const bodySrc = lastAssist ? stripAnswerHtmlFenceFromText(lastAssist) : '';
    html = buildFallbackAnswerDocument(rec.prompt, bodySrc || 'No assistant reply was recorded.');
  } else if (!/<!DOCTYPE/i.test(html) && !/<html[\s>]/i.test(html)) {
    html = wrapFragmentAsHtml(html);
  }
  try {
    fs.writeFileSync(filePath, html, 'utf8');
    rec.answerHtmlFileUrl = pathToFileURL(filePath).href;
    rec.answerHtmlWriteError = undefined;
  } catch (e) {
    rec.answerHtmlFileUrl = undefined;
    rec.answerHtmlWriteError = (e && e.message) || String(e);
    log.warn('answer html write failed', e);
  }
}

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
    'Avoid a long first line. Use the same pattern on your last message of the run—' +
    'never skip the short cat line on the closing reply.\n\n' +
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

/** Same line as live stream bubbles: last assistant turn’s short first line. */
function finishBubbleLineFromConversation(rec) {
  if (!rec || !Array.isArray(rec.items)) return undefined;
  for (let i = rec.items.length - 1; i >= 0; i--) {
    const it = rec.items[i];
    if (it && it.kind === 'assistant' && it.text) {
      const line = leadAssistantBubbleText(it.text);
      if (line) return line;
    }
  }
  return undefined;
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
 * Captures a git tree object for the current working tree (tracked + untracked, .gitignore respected)
 * using a temp index, without touching the user's real index. Returns null if not a git worktree
 * or on failure.
 * @param {string} folder
 * @param {Console} [log]
 * @returns {Promise<{ tree: string, headSha: string | null, capturedAt: number } | null>}
 */
async function captureGitSnapshotForFolder(folder, log = console) {
  const f = String(folder || '').trim();
  if (!f) return null;
  try {
    const { stdout: inTree } = await execFileAsync('git', ['-C', f, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    });
    if (String(inTree).trim() !== 'true') return null;
  } catch {
    return null;
  }
  let headSha = null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', f, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const h = String(stdout).trim();
    headSha = h || null;
  } catch {
    headSha = null;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorcats-git-'));
  const indexFile = path.join(tmp, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: f, env, encoding: 'utf8' });
    const { stdout: treeOut } = await execFileAsync('git', ['write-tree'], { cwd: f, env, encoding: 'utf8' });
    const tree = String(treeOut).trim();
    if (!/^[0-9a-f]{40}$/i.test(tree)) {
      log.warn('captureGitSnapshot: unexpected write-tree output', treeOut);
      return null;
    }
    return { tree, headSha, capturedAt: now() };
  } catch (e) {
    log.warn('captureGitSnapshot failed', e);
    return null;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Restores the cat's folder to the git tree captured at spawn. Git-only; requires a prior snapshot.
 * Refuses if the cat is still running, already reverted, or missing snapshot.
 * @param {string} catId
 * @param {{ log?: Console }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, error: string, cancelled?: boolean }>}
 */
async function revertAgentChanges(catId, opts = {}) {
  const { log = console } = opts;
  const id = String(catId);
  const rec = conversations.get(id);
  if (!rec || !rec.snapshotTree) {
    return { ok: false, error: 'No git snapshot to revert to.' };
  }
  if (rec.reverted) {
    return { ok: false, error: 'Already reverted.' };
  }
  if (String(rec.runStatus || '').toLowerCase() === 'running') {
    return { ok: false, error: 'Agent is still running. Wait for it to finish, then try again.' };
  }
  const folder = rec.folder;
  if (!String(folder || '').trim()) {
    return { ok: false, error: 'Missing folder for this cat.' };
  }
  const tree = rec.snapshotTree;
  try {
    await execFileAsync('git', ['read-tree', '--reset', '-u', tree], {
      cwd: folder,
      encoding: 'utf8',
    });
    await execFileAsync('git', ['clean', '-fd'], { cwd: folder, encoding: 'utf8' });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log.warn('revertAgentChanges failed', e);
    rec.revertError = msg;
    onConversationPushed({ catId: id });
    return { ok: false, error: msg };
  }
  rec.reverted = true;
  rec.revertError = undefined;
  rec.items.push({
    kind: 'system',
    text: 'Changes reverted to the folder state at spawn.',
    at: now(),
  });
  onConversationPushed({ catId: id });
  return { ok: true };
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

/**
 * @param {string} catId
 * @param {{ folder: string, prompt: string, snapshotTree?: string, headShaAtSnapshot?: string | null, snapshotCapturedAt?: number }} params
 */
function initConversationState(catId, { folder, prompt, snapshotTree, headShaAtSnapshot, snapshotCapturedAt }) {
  conversations.set(catId, {
    folder: String(folder || ''),
    prompt: String(prompt || ''),
    items: prompt ? [{ kind: 'user', text: String(prompt), at: now() }] : [],
    runStatus: 'running',
    activeAssistantBubble: false,
    answerHtmlFileUrl: undefined,
    answerHtmlWriteError: undefined,
    snapshotTree: snapshotTree || undefined,
    headShaAtSnapshot: headShaAtSnapshot != null ? String(headShaAtSnapshot) : undefined,
    snapshotCapturedAt: snapshotCapturedAt != null ? snapshotCapturedAt : undefined,
    reverted: false,
    revertError: undefined,
  });
  onConversationPushed({ catId });
}

function getAgentConversation(catId) {
  const c = conversations.get(String(catId));
  if (!c) return { found: false, items: [] };
  const hasSnapshot = !!c.snapshotTree;
  return {
    found: true,
    folder: c.folder,
    prompt: c.prompt,
    items: c.items.map(({ kind, text, at }) => ({ kind, text, at })),
    runStatus: c.runStatus,
    endResult: c.endResult,
    durationMs: c.durationMs,
    answerHtmlFileUrl: c.answerHtmlFileUrl || null,
    answerHtmlWriteError: c.answerHtmlWriteError || null,
    canRevert: hasSnapshot,
    reverted: !!c.reverted,
    revertError: c.revertError != null ? String(c.revertError) : null,
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
  deleteAnswerHtmlDirForCat(id, log);
  deleteConversationState(id);
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('remove-cat', { catId: id });
  }
}

const DEFAULT_AGENT_MODEL_ID = 'composer-2';

/**
 * @param {string} catId
 * @param {(payload: { catId: string, status: string, result?: string, durationMs?: number, finishBubbleLine?: string }) => void} notify
 * @param {Console} log
 * @param {string} folder
 * @param {string} [modelId]
 */
async function ensureAgent(catId, folder, notify, log, modelId) {
  const id = String(catId);
  const folderStr = String(folder || '');
  const modelIdStr = String(modelId || '').trim() || DEFAULT_AGENT_MODEL_ID;
  const existing = active.get(id);

  if (existing && existing.agent && existing.folder === folderStr && existing.modelId === modelIdStr) {
    return existing.agent;
  }
  if (existing && existing.agent && (existing.folder !== folderStr || existing.modelId !== modelIdStr)) {
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
    model: { id: modelIdStr },
    local: { cwd: folderStr },
  });
  active.set(id, { agent, run: null, folder: folderStr, modelId: modelIdStr, busy: false });
  return agent;
}

/**
 * @param {string} catId
 * @param {(payload: { catId: string, status: string, result?: string, durationMs?: number, finishBubbleLine?: string }) => void} notify
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
      const htmlExtra = buildAnswerHtmlPageInstruction();
      try {
        run = await entry.agent.send(String(addedSystemInstruction + htmlExtra + prompt));
      } catch (e) {
        log.warn('agent.send failed', e);
        const r = conversations.get(id);
        if (r) {
          const errText = (e && e.message) || String(e);
          r.runStatus = 'error';
          r.endResult = errText;
          r.items.push({ kind: 'error', text: errText, at: now() });
          r.activeAssistantBubble = false;
          commitAnswerHtmlPage(id, r, log);
          onConversationPushed({ catId: id });
        }
        notify({
          catId: id,
          status: 'error',
          result: (e && e.message) || String(e),
          finishBubbleLine: finishBubbleLineFromConversation(r),
        });
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
          commitAnswerHtmlPage(id, r, log);
          onConversationPushed({ catId: id });
        }
        const status = result && result.status != null ? result.status : 'finished';
        const res = result && result.result != null ? String(result.result) : undefined;
        const durationMs = result && result.durationMs != null ? result.durationMs : undefined;
        notify({
          catId: id,
          status: String(status),
          result: res,
          durationMs,
          finishBubbleLine: finishBubbleLineFromConversation(r),
        });
      } catch (e) {
        log.warn('run.wait failed', e);
        const r = conversations.get(id);
        if (r) {
          r.runStatus = 'error';
          const errText = (e && e.message) || String(e);
          r.endResult = errText;
          r.items.push({ kind: 'error', text: errText, at: now() });
          r.activeAssistantBubble = false;
          commitAnswerHtmlPage(id, r, log);
          onConversationPushed({ catId: id });
        }
        notify({
          catId: id,
          status: 'error',
          result: (e && e.message) || String(e),
          finishBubbleLine: finishBubbleLineFromConversation(r),
        });
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

async function runAgentLifecycle({ catId, folder, prompt, model, notify, log }) {
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
      answerHtmlFileUrl: undefined,
      answerHtmlWriteError: undefined,
      snapshotTree: undefined,
      headShaAtSnapshot: undefined,
      snapshotCapturedAt: undefined,
      reverted: false,
      revertError: undefined,
    });
    const recNoKey = conversations.get(id);
    if (recNoKey) commitAnswerHtmlPage(id, recNoKey, log);
    onConversationPushed({ catId: id });
    notify({ catId: id, status: 'error', result: noKeyMsg });
    return;
  }

  const snap = await captureGitSnapshotForFolder(String(folder), log);
  initConversationState(id, {
    folder,
    prompt,
    snapshotTree: snap?.tree,
    headShaAtSnapshot: snap?.headSha != null ? snap.headSha : undefined,
    snapshotCapturedAt: snap?.capturedAt,
  });

  try {
    await ensureAgent(id, folder, notify, log, model);
  } catch (e) {
    log.warn('Failed to create Cursor agent', e);
    const rec = conversations.get(id);
    if (rec) {
      const errText = (e && e.message) || String(e);
      rec.runStatus = 'error';
      rec.endResult = errText;
      rec.items.push({ kind: 'error', text: errText, at: now() });
      commitAnswerHtmlPage(id, rec, log);
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
function startAgentForCat({ catId, folder, prompt, model }, { getMainWindow, log = console } = {}) {
  const notify = getNotify(getMainWindow);
  void runAgentLifecycle({
    catId: String(catId),
    folder,
    prompt,
    model,
    notify,
    log,
  });
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
    rec.answerHtmlFileUrl = undefined;
    rec.answerHtmlWriteError = undefined;
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
  revertAgentChanges,
};
