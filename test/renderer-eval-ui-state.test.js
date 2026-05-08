'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(root, 'src/renderer/src/eval-ui-state.ts');

async function loadHelper() {
  const source = fs.readFileSync(helperPath, 'utf8');
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}${Math.random()}`);
}

class MockHTMLElement {}

function withDomGlobals(callback) {
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    window: globalThis.window,
  };
  globalThis.HTMLElement = MockHTMLElement;
  globalThis.window = {
    screenX: 10.4,
    screenLeft: 99,
    screenY: 20.6,
    screenTop: 88,
    getComputedStyle: (el) => ({ display: el.display || 'block' }),
  };
  globalThis.document = {
    activeElement: { id: 'prompt', tagName: 'TEXTAREA' },
    body: { innerText: ' Hello\n\tworld  from   eval ' },
  };
  try {
    return callback();
  } finally {
    globalThis.document = previous.document;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.window = previous.window;
  }
}

function mockElement(rect, properties = {}) {
  const el = new MockHTMLElement();
  Object.assign(el, properties);
  el.getBoundingClientRect = () => rect;
  return el;
}

test('eval rect helper preserves screen-offset rounded payloads and zero-size filtering', async () => {
  const { rectForEvalElement } = await loadHelper();

  withDomGlobals(() => {
    assert.deepEqual(rectForEvalElement(mockElement({ left: 1.2, top: 2.2, right: 11.8, bottom: 22.8, width: 10.6, height: 20.6 })), {
      left: 12,
      top: 23,
      right: 22,
      bottom: 43,
      width: 11,
      height: 21,
    });
    assert.equal(rectForEvalElement(mockElement({ left: 0, top: 0, right: 0, bottom: 10, width: 0, height: 10 })), null);
    assert.equal(rectForEvalElement({ getBoundingClientRect: () => ({ width: 1, height: 1 }) }), null);
  });
});

test('eval rect helper lets overlay opt into hidden/display none filtering without changing other windows', async () => {
  const { rectForEvalElement } = await loadHelper();

  withDomGlobals(() => {
    const hidden = mockElement({ left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2 }, { hidden: true });
    const displayNone = mockElement({ left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2 }, { display: 'none' });

    assert.equal(rectForEvalElement(hidden), null);
    assert.equal(rectForEvalElement(displayNone), null);
    assert.deepEqual(rectForEvalElement(hidden, { includeHidden: true }), {
      left: 11,
      top: 23,
      right: 13,
      bottom: 25,
      width: 2,
      height: 2,
    });
  });
});

test('eval text helpers preserve active-element and whitespace-collapsed preview shapes', async () => {
  const { activeElementForEval, visibleTextForEval } = await loadHelper();

  withDomGlobals(() => {
    assert.deepEqual(activeElementForEval(), { id: 'prompt', tag: 'TEXTAREA' });
    assert.deepEqual(visibleTextForEval(), {
      visibleTextLength: 21,
      visibleTextPreview: 'Hello world from eval',
    });
    assert.deepEqual(visibleTextForEval({ maxPreviewLength: 5 }), {
      visibleTextLength: 21,
      visibleTextPreview: 'Hello',
    });
  });
});
