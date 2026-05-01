'use strict';

/** @typedef {{ catId: string, workspaceRoots: string[], startedAt: number }} SessionRec */

/** @type {Map<string, SessionRec>} */
const bySession = new Map();

/**
 * @param {object} payload
 * @param {() => import('electron').BrowserWindow | null} getMainWindow
 */
function handleIdeSessionStart(payload, { getMainWindow, log = console } = {}) {
  const sessionId = payload && (payload.session_id != null ? String(payload.session_id) : null);
  const wr = Array.isArray(payload && payload.workspace_roots)
    ? payload.workspace_roots.map((x) => String(x))
    : [];
  log.log('[agent-ui] handleIdeSessionStart session=', sessionId, 'roots=', wr);
  if (!sessionId) {
    log.log('[agent-ui] ide-session-start dropped: no session_id');
    return;
  }
  if (bySession.has(sessionId)) {
    log.log('[agent-ui] ide-session-start dropped: duplicate sessionId=', sessionId);
    return;
  }
  const catId = `ide:${sessionId}`;
  bySession.set(sessionId, { catId, workspaceRoots: wr, startedAt: Date.now() });
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('spawn-cat', {
        catId,
        kind: 'ide',
        sessionId,
        folder: wr[0] || '',
        workspace: wr[0] || '',
        prompt: '',
      });
      log.log('[agent-ui] spawn-cat sent catId=', catId);
    } catch (e) {
      log.warn('[agent-ui] spawn-cat (ide) failed', e);
    }
  } else {
    log.log('[agent-ui] ide-session-start dropped: no main window');
  }
}

/**
 * @param {object} payload
 * @param {() => import('electron').BrowserWindow | null} getMainWindow
 */
function handleIdeSessionEnd(payload, { getMainWindow, log = console } = {}) {
  const sessionId = payload && (payload.session_id != null ? String(payload.session_id) : null);
  log.log('[agent-ui] handleIdeSessionEnd session=', sessionId);
  if (!sessionId) {
    log.log('[agent-ui] ide-session-end dropped: no session_id');
    return;
  }
  const rec = bySession.get(sessionId);
  if (!rec) {
    log.log('[agent-ui] ide-session-end dropped: unknown sessionId=', sessionId);
    return;
  }
  // Keep `bySession` until the renderer calls `dismissCat` (auto after finish delay or user).
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed()) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const status =
      p.final_status != null
        ? String(p.final_status)
        : p.reason != null
          ? String(p.reason)
          : 'done';
    let result = '';
    if (p.error_message != null && String(p.error_message).length > 0) {
      result = String(p.error_message);
    } else if (p.reason != null && String(p.reason).length > 0) {
      result = String(p.reason);
    }
    const durationMs =
      typeof p.duration_ms === 'number' && Number.isFinite(p.duration_ms) ? p.duration_ms : undefined;
    try {
      win.webContents.send('agent-finished', {
        catId: rec.catId,
        status,
        result,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      log.log('[agent-ui] agent-finished (ide session end) catId=', rec.catId);
    } catch (e) {
      log.warn('[agent-ui] agent-finished (ide) failed', e);
    }
  } else {
    log.log('[agent-ui] ide-session-end dropped: no main window');
  }
}

/**
 * @param {string} catId
 * @returns {string | null}
 */
function getWorkspaceForIdeCatId(catId) {
  if (!catId || !String(catId).startsWith('ide:')) {
    return null;
  }
  const sessionId = String(catId).slice(4);
  const rec = bySession.get(sessionId);
  if (!rec || !rec.workspaceRoots || !rec.workspaceRoots.length) {
    return null;
  }
  return rec.workspaceRoots[0];
}

/**
 * @param {string} catId
 * @returns {string | null}
 */
function getSessionIdForCatId(catId) {
  if (!catId || !String(catId).startsWith('ide:')) {
    return null;
  }
  return String(catId).slice(4);
}

/**
 * Remove an IDE cat from tracking and overlay (e.g. user dismissed from UI).
 * @param {string} catId
 * @param {() => import('electron').BrowserWindow | null} getMainWindow
 */
function removeIdeCatIfPresent(catId, { getMainWindow, log = console } = {}) {
  const sessionId = getSessionIdForCatId(catId);
  if (!sessionId) {
    return false;
  }
  if (!bySession.has(sessionId)) {
    return false;
  }
  bySession.delete(sessionId);
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('remove-cat', { catId: String(catId) });
    } catch (e) {
      log.warn('[agent-ui] remove-cat (ide manual) failed', e);
    }
  }
  return true;
}

module.exports = {
  handleIdeSessionStart,
  handleIdeSessionEnd,
  getWorkspaceForIdeCatId,
  getSessionIdForCatId,
  removeIdeCatIfPresent,
};
