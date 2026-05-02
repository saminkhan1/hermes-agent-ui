'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PET_DEFAULT_MASCOT_SIZE,
  PET_DEFAULT_TRAY_SIZE,
  computePetLayout,
  defaultPetAnchor,
} = require('../src/main/pet-layout');

const displayBounds = { x: 0, y: 0, width: 1440, height: 900 };

test('defaultPetAnchor places mascot near display bottom right', () => {
  assert.deepEqual(defaultPetAnchor(displayBounds), {
    x: 1304,
    y: 755,
    width: 112,
    height: 121,
  });
});

test('computePetLayout clamps an offscreen anchor into the display', () => {
  const layout = computePetLayout({
    anchor: { x: 2000, y: 2000, ...PET_DEFAULT_MASCOT_SIZE },
    displayBounds,
    mascotSize: PET_DEFAULT_MASCOT_SIZE,
    previousPlacement: 'top-end',
    traySize: PET_DEFAULT_TRAY_SIZE,
  });

  assert.equal(layout.anchor.x, 1328);
  assert.equal(layout.anchor.y, 771);
  assert.equal(layout.windowBounds.width, 356);
  assert.equal(layout.windowBounds.height, 320);
  assert.ok(layout.mascot.left >= 0);
  assert.ok(layout.mascot.top >= 0);
});

test('computePetLayout keeps tray hidden when tray size is null', () => {
  const layout = computePetLayout({
    anchor: defaultPetAnchor(displayBounds),
    displayBounds,
    mascotSize: PET_DEFAULT_MASCOT_SIZE,
    previousPlacement: 'top-end',
    traySize: null,
  });

  assert.equal(layout.tray, null);
  assert.equal(layout.placement, 'top-end');
});

test('computePetLayout supports displays smaller than the default viewport', () => {
  const smallDisplay = { x: 0, y: 0, width: 240, height: 180 };
  const layout = computePetLayout({
    anchor: defaultPetAnchor(smallDisplay),
    displayBounds: smallDisplay,
    mascotSize: PET_DEFAULT_MASCOT_SIZE,
    previousPlacement: 'top-end',
    traySize: PET_DEFAULT_TRAY_SIZE,
  });

  assert.equal(layout.viewport.width, 240);
  assert.equal(layout.viewport.height, 180);
  assert.ok(layout.anchor.x >= smallDisplay.x);
  assert.ok(layout.anchor.y >= smallDisplay.y);
  assert.ok(layout.anchor.x + layout.anchor.width <= smallDisplay.x + smallDisplay.width);
  assert.ok(layout.anchor.y + layout.anchor.height <= smallDisplay.y + smallDisplay.height);
});
