'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PET_ASSET_SCHEME,
  loadPetCharacterOptions,
  petCharactersPayload,
} = require('../src/main/pet-assets');

const packageRoot = path.join(__dirname, '..');

test('pet character payload sends lightweight options and active sprite reference', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-pets-'));
  const options = loadPetCharacterOptions({ codexHome, packageRoot });
  assert.ok(options.length >= 1);

  const selected = options.find((pet) => pet.id === 'custom:goblin') || options[0];
  const payload = petCharactersPayload({ options, selectedId: selected.id });

  assert.equal(payload.id, selected.id);
  assert.ok(payload.selectedSpriteUrl.startsWith(`${PET_ASSET_SCHEME}://sprite/`));
  assert.equal(payload.selected.spriteUrl, payload.selectedSpriteUrl);
  assert.equal(payload.options.some((pet) => Object.hasOwn(pet, 'spriteUrl')), false);
  assert.equal(payload.options.some((pet) => Object.hasOwn(pet, 'spritesheetPath')), false);
});

test('pet character payload falls back to first available option', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-pets-'));
  const options = loadPetCharacterOptions({ codexHome, packageRoot });
  const payload = petCharactersPayload({ options, selectedId: 'missing-pet' });

  assert.equal(payload.id, options[0].id);
  assert.ok(payload.selectedSpriteUrl.includes(encodeURIComponent(options[0].id)));
});
