'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

test('README points contributors to the lean docs set', () => {
  const readme = read('README.md');

  assert.match(readme, /CONTRIBUTING\.md/);
  assert.match(readme, /docs\/RELEASE\.md/);
  assert.doesNotMatch(readme, /docs\/DEVELOPER_ONBOARDING\.md/);
  assert.doesNotMatch(readme, /docs\/release\//);
});

test('contribution docs preserve branch and release gate expectations', () => {
  const contributing = read('CONTRIBUTING.md');

  assert.match(contributing, /gateway[\s\S]*active integration branch/);
  assert.match(contributing, /deployment[\s\S]*GitHub Actions release branch/);
  assert.match(contributing, /npm run verify/);
  assert.match(contributing, /npm run smoke:installed-release -- "\/Applications\/agent-UI Standalone\.app"/);
  assert.match(contributing, /Bootstrap releases are ad-hoc signed and are not notarized/);
});

test('contribution docs separate gateway transport from provider auth', () => {
  const contributing = read('CONTRIBUTING.md');

  assert.match(contributing, /gateway secret is not the same as Hermes provider auth/);
  assert.match(contributing, /agent-UI gateway config lives under `~\/\.agent-ui\/`/);
  assert.match(contributing, /Hermes provider credentials live in Hermes' own auth\/config state/);
  assert.match(contributing, /reachable gateway can still return provider setup errors/);
});

test('release guide includes the full release verification path', () => {
  const testing = read('docs/RELEASE.md');

  assert.match(testing, /Ring 0 - Local Fast Checks/);
  assert.match(testing, /Ring 1 - GitHub Actions Build Gate/);
  assert.match(testing, /Ring 2 - Tart Clean-Room VM Gate/);
  assert.match(testing, /Ring 3 - Manual Customer Pass/);
  assert.match(testing, /ghcr\.io\/cirruslabs\/macos-sequoia-vanilla:latest/);
  assert.match(testing, /scripts\/tart-clean-room-smoke\.sh "\$DMG"/);
  assert.match(testing, /scripts\/tart-clean-room-smoke\.sh "\$ZIP"/);
  assert.match(testing, /npm run smoke:installed-release -- "\/Applications\/agent-UI Standalone\.app"/);
});
