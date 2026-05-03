'use strict';

function isLiveWindow(win) {
  return !!(win && typeof win.isDestroyed === 'function' && !win.isDestroyed());
}

function isCurrentWindow(win, getCurrent) {
  return isLiveWindow(win) && typeof getCurrent === 'function' && getCurrent() === win;
}

function focusWindow(win) {
  if (!isLiveWindow(win)) return false;
  if (typeof win.show === 'function' && typeof win.isVisible === 'function' && !win.isVisible()) {
    win.show();
  }
  if (typeof win.moveTop === 'function') win.moveTop();
  if (typeof win.focus === 'function') win.focus();
  if (win.webContents && typeof win.webContents.focus === 'function') {
    win.webContents.focus();
  }
  return true;
}

function runForCurrentWindow(win, getCurrent, fn) {
  if (!isCurrentWindow(win, getCurrent)) return false;
  fn(win);
  return true;
}

function clearCurrentWindow(win, getCurrent, setCurrent) {
  if (typeof getCurrent !== 'function' || typeof setCurrent !== 'function') return false;
  if (getCurrent() !== win) return false;
  setCurrent(null);
  return true;
}

module.exports = {
  clearCurrentWindow,
  focusWindow,
  isCurrentWindow,
  isLiveWindow,
  runForCurrentWindow,
};
