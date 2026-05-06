'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

test('README points contributors to onboarding, contribution, and verification docs', () => {
  const readme = read('README.md');

  assert.match(readme, /docs\/DEVELOPER_ONBOARDING\.md/);
  assert.match(readme, /CONTRIBUTING\.md/);
  assert.match(readme, /docs\/TESTING_AND_VERIFICATION\.md/);
  assert.match(readme, /docs\/release\/MANUAL_CUSTOMER_PASS\.md/);
  assert.match(readme, /docs\/release\/evidence-template\.md/);
});

test('contribution docs preserve branch and release gate expectations', () => {
  const contributing = read('CONTRIBUTING.md');

  assert.match(contributing, /gateway[\s\S]*active integration branch/);
  assert.match(contributing, /deployment[\s\S]*GitHub Actions release branch/);
  assert.match(contributing, /npm run verify/);
  assert.match(contributing, /npm run smoke:installed-release -- "\/Applications\/agent-UI Standalone\.app"/);
  assert.match(contributing, /Bootstrap releases are ad-hoc signed and are not notarized/);
});

test('onboarding docs separate gateway transport from provider auth', () => {
  const onboarding = read('docs/DEVELOPER_ONBOARDING.md');

  assert.match(onboarding, /~\/\.agent-ui\/hermes-home\/\.env/);
  assert.match(onboarding, /~\/\.agent-ui\/connector-runtime\.json/);
  assert.match(onboarding, /No inference provider configured/);
  assert.match(onboarding, /A healthy gateway does not prove provider auth is configured/);
  assert.match(onboarding, /agent-UI Standalone\.app\/Contents\/Resources\/hermes-runtime\/bin\/hermes/);
});

test('testing docs include the full release verification path', () => {
  const testing = read('docs/TESTING_AND_VERIFICATION.md');

  assert.match(testing, /Ring 0 - Local Fast Checks/);
  assert.match(testing, /Ring 1 - GitHub Actions Build Gate/);
  assert.match(testing, /Ring 2 - Tart Clean-Room VM Gate/);
  assert.match(testing, /Ring 3 - Manual Customer Pass/);
  assert.match(testing, /ghcr\.io\/cirruslabs\/macos-sequoia-vanilla:latest/);
  assert.match(testing, /scripts\/tart-clean-room-smoke\.sh "\$DMG"/);
  assert.match(testing, /scripts\/tart-clean-room-smoke\.sh "\$ZIP"/);
  assert.match(testing, /npm run smoke:installed-release -- "\/Applications\/agent-UI Standalone\.app"/);
});
