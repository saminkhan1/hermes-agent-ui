'use strict';

const pkg = require('../package.json');

const LOCAL_DESKTOP_PLUGIN_REPO = process.env.AGENT_UI_LOCAL_DESKTOP_PLUGIN_REPO ||
  'saminkhan1/agent-ui-local-desktop-plugin';

const APP_MODES = {
  connector: {
    appId: 'ai.agent-ui.hermes',
    artifactPrefix: 'agent-UI-for-Hermes',
    productName: 'agent-UI for Hermes',
    hermesRuntimeIncluded: false,
  },
  standalone: {
    appId: 'ai.agent-ui.standalone',
    artifactPrefix: 'agent-UI-Standalone',
    productName: 'agent-UI Standalone',
    hermesRuntimeIncluded: true,
  },
};

function normalizeAppMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!APP_MODES[mode]) throw new Error(`unknown agent-UI app mode: ${value}`);
  return mode;
}

function normalizeSigningMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!['bootstrap', 'developer-id'].includes(mode)) {
    throw new Error(`unknown agent-UI signing mode: ${value}`);
  }
  return mode;
}

function hermesRuntimeExtraResources(appMode) {
  if (appMode !== 'standalone') return [];
  return [
    {
      from: 'build/hermes-runtime',
      to: 'hermes-runtime',
      filter: ['**/*'],
    },
  ];
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
        hermesBaselineRequirement: normalizedAppMode === 'connector' ? 'v2026.4.30+' : undefined,
        localDesktopPluginRepo: normalizedAppMode === 'connector' ? LOCAL_DESKTOP_PLUGIN_REPO : undefined,
      },
    },
    extraResources: hermesRuntimeExtraResources(normalizedAppMode),
    mac: {
      ...pkg.build.mac,
    },
    dmg: {
      ...pkg.build.dmg,
    },
  };

  if (!mode.hermesRuntimeIncluded) {
    delete config.afterPack;
  }

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
  LOCAL_DESKTOP_PLUGIN_REPO,
  makeConfig,
};
