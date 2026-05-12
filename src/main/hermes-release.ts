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
  return path.join(realUserHomeDir(), 'Documents', 'hermes', 'hermes-home');
}

function defaultHermesHomeForMode() {
  const configured = String(process.env.AGENT_UI_HERMES_HOME || '').trim();
  if (configured) return path.resolve(configured);
  return connectorHermesHome();
}

function defaultGatewayEnvPathForMode() {
  const configured = String(process.env.AGENT_UI_HERMES_ENV_PATH || '').trim();
  if (configured) return path.resolve(configured);
  return path.join(defaultHermesHomeForMode(), '.env');
}

function connectorRuntimeStatePath() {
  return path.join(getAgentUIConfigDir(), 'connector-runtime.json');
}

function readJsonFile(file: LooseBoundaryValue, fallback = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: LooseBoundaryValue, value: LooseBoundaryValue) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readConnectorRuntimeState() {
  return readJsonFile(connectorRuntimeStatePath(), {});
}

function rememberConnectorHermesCommand(command: LooseBoundaryValue) {
  const value = String(command || '').trim();
  if (!value) return;
  writeJsonFile(connectorRuntimeStatePath(), {
    hermesBin: value,
    rememberedAt: new Date().toISOString(),
  });
}

function defaultConnectorHermesCandidates() {
  const home = realUserHomeDir();
  const root = path.join(home, 'Documents', 'hermes');
  return [
    path.join(root, 'hermes-agent', 'venv', 'bin', 'hermes'),
    path.join(root, 'hermes-agent', '.venv', 'bin', 'hermes'),
    path.join(root, 'hermes-agent', 'hermes'),
  ];
}

export {
  RELEASE_MODE_CONNECTOR,
  connectorHermesHome,
  defaultConnectorHermesCandidates,
  defaultGatewayEnvPathForMode,
  defaultHermesHomeForMode,
  getAgentUIConfigDir,
  normalizeReleaseMode,
  readConnectorRuntimeState,
  realUserHomeDir,
  releaseMode,
  rememberConnectorHermesCommand,
};
