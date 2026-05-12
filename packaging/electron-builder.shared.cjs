'use strict';

const pkg = require('../package.json');

const APP_MODES = {
  connector: {
    appId: 'ai.agent-ui.hermes',
    artifactPrefix: 'agent-UI-for-Hermes',
    productName: 'agent-UI for Hermes',
    hermesRuntimeIncluded: false,
  },
};

function normalizeAppMode(value) {
  const mode = String(value || '')
    .trim()
    .toLowerCase();
  if (!APP_MODES[mode]) throw new Error(`unknown agent-UI app mode: ${value}`);
  return mode;
}

function normalizeSigningMode(value) {
  const mode = String(value || '')
    .trim()
    .toLowerCase();
  if (!['bootstrap', 'developer-id'].includes(mode)) {
    throw new Error(`unknown agent-UI signing mode: ${value}`);
  }
  return mode;
}

function makeConfig({ appMode, signingMode }) {
  const normalizedAppMode = normalizeAppMode(appMode);
  const normalizedSigningMode = normalizeSigningMode(signingMode);
  const mode = APP_MODES[normalizedAppMode];
  const bootstrap = normalizedSigningMode === 'bootstrap';

  const config = {
    ...pkg.build,
    appId: mode.appId,
    productName: mode.productName,
    artifactName: `${mode.artifactPrefix}-\${version}-\${os}-\${arch}${bootstrap ? '-bootstrap' : ''}.\${ext}`,
    extraMetadata: {
      agentUI: {
        releaseMode: normalizedAppMode,
        signingMode: normalizedSigningMode,
        hermesRuntimeIncluded: mode.hermesRuntimeIncluded,
        hermesBaselineRequirement: 'v2026.4.30+',
      },
    },
    extraResources: [
      {
        from: 'vendor/hermes-platforms',
        to: 'hermes-platforms',
      },
    ],
    mac: {
      ...pkg.build.mac,
    },
    dmg: {
      ...pkg.build.dmg,
    },
  };

  delete config.afterPack;

  if (bootstrap) {
    config.mac = {
      ...config.mac,
      identity: '-',
      gatekeeperAssess: false,
      notarize: false,
    };
    config.dmg = {
      ...config.dmg,
      sign: false,
    };
  }

  return config;
}

module.exports = {
  APP_MODES,
  makeConfig,
};
