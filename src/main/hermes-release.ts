'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RELEASE_MODE_CONNECTOR = 'connector';
const RELEASE_MODES = new Set([RELEASE_MODE_CONNECTOR]);

function realUserHomeDir() {
  try {
    const userHome = os.userInfo().homedir;
    if (userHome) return userHome;
  } catch {
    // Fall through to Node's HOME-aware default.
  }
  return os.homedir();
}

function packageRootFromMainDir(mainDir = __dirname) {
  return path.resolve(mainDir, '..', '..');
}

function readPackageJson() {
  try {
    const file = path.join(packageRootFromMainDir(), 'package.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function normalizeReleaseMode(value: LooseBoundaryValue, fallback = RELEASE_MODE_CONNECTOR) {
  const mode = String(value || '')
    .trim()
    .toLowerCase();
  return RELEASE_MODES.has(mode) ? mode : fallback;
}

function releaseMode() {
  const pkg = readPackageJson();
  return normalizeReleaseMode(
    process.env.AGENT_UI_RELEASE_MODE ||
      process.env.AGENT_UI_RELEASE_FLAVOR ||
      (pkg.agentUI && pkg.agentUI.releaseMode),
    RELEASE_MODE_CONNECTOR,
  );
}

function getAgentUIConfigDir() {
  const configured = String(process.env.AGENT_UI_CONFIG_DIR || '').trim();
  const dir = configured ? path.resolve(configured) : path.join(realUserHomeDir(), '.agent-ui');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function connectorHermesHome() {
  return path.join(realUserHomeDir(), '.hermes');
}

function defaultHermesHomeForMode() {
  const configured = String(process.env.HERMES_HOME || '').trim();
  if (configured) return path.resolve(configured);
  return connectorHermesHome();
}

function defaultGatewayEnvPathForMode() {
  return path.join(defaultHermesHomeForMode(), '.env');
}

function defaultConnectorHermesCandidates() {
  const home = realUserHomeDir();
  return [path.join(home, '.local', 'bin', 'hermes'), path.join('/usr', 'local', 'bin', 'hermes')];
}

export {
  RELEASE_MODE_CONNECTOR,
  connectorHermesHome,
  defaultConnectorHermesCandidates,
  defaultGatewayEnvPathForMode,
  defaultHermesHomeForMode,
  getAgentUIConfigDir,
  normalizeReleaseMode,
  realUserHomeDir,
  releaseMode,
};
