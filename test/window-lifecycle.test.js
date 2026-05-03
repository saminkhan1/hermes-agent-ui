'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clearCurrentWindow,
  focusWindow,
  isCurrentWindow,
  runForCurrentWindow,
} = require('../src/main/window-lifecycle');

function fakeWindow() {
  return {
    destroyed: false,
    calls: [],
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible === true;
    },
    show() {
      this.visible = true;
      this.calls.push('show');
    },
    moveTop() {
      this.calls.push('moveTop');
    },
    focus() {
      this.calls.push('focus');
    },
    webContents: {
      calls: [],
      focus() {
        this.calls.push('focus');
      },
      send(channel, payload) {
        this.calls.push(['send', channel, payload]);
      },
    },
  };
}

test('ready callback is ignored after current window is closed', () => {
  const win = fakeWindow();
  let current = win;

  assert.equal(isCurrentWindow(win, () => current), true);
  current = null;
  win.destroyed = true;

  const ran = runForCurrentWindow(win, () => current, (target) => {
    target.show();
  });

  assert.equal(ran, false);
  assert.deepEqual(win.calls, []);
});

test('stale closed event does not clear replacement window', () => {
  const oldWin = fakeWindow();
  const newWin = fakeWindow();
  let current = newWin;

  const cleared = clearCurrentWindow(oldWin, () => current, (next) => {
    current = next;
  });

  assert.equal(cleared, false);
  assert.equal(current, newWin);
});

test('stale ready callback does not act on replacement window', () => {
  const oldWin = fakeWindow();
  const newWin = fakeWindow();
  let current = newWin;

  const ran = runForCurrentWindow(oldWin, () => current, (target) => {
    target.show();
  });

  assert.equal(ran, false);
  assert.deepEqual(oldWin.calls, []);
  assert.deepEqual(newWin.calls, []);
});

test('voice-style status sends only to the current modal instance', () => {
  const oldWin = fakeWindow();
  const newWin = fakeWindow();
  let current = newWin;

  const sendStatus = (win, modalContextId, payload) => {
    runForCurrentWindow(win, () => current, (target) => {
      target.webContents.send('voice-input-status', { modalContextId, ...payload });
    });
  };

  sendStatus(oldWin, 'old-context', { state: 'transcript_ready' });
  sendStatus(newWin, 'new-context', { state: 'recording' });

  assert.deepEqual(oldWin.webContents.calls, []);
  assert.deepEqual(newWin.webContents.calls, [
    ['send', 'voice-input-status', { modalContextId: 'new-context', state: 'recording' }],
  ]);
});

test('focusWindow brings a live hidden window forward', () => {
  const win = fakeWindow();

  assert.equal(focusWindow(win), true);
  assert.deepEqual(win.calls, ['show', 'moveTop', 'focus']);
  assert.deepEqual(win.webContents.calls, ['focus']);
});
