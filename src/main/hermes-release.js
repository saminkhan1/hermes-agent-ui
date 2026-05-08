'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const RELEASE_MODE_CONNECTOR = 'connector';
const RELEASE_MODE_STANDALONE = 'standalone';
const RELEASE_MODES = new Set([RELEASE_MODE_CONNECTOR, RELEASE_MODE_STANDALONE]);

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

function normalizeReleaseMode(value, fallback = RELEASE_MODE_STANDALONE) {
  const mode = String(value || '').trim().toLowerCase();
  return RELEASE_MODES.has(mode) ? mode : fallback;
}

function releaseMode() {
  const pkg = readPackageJson();
  return normalizeReleaseMode(
    process.env.AGENT_UI_RELEASE_MODE ||
    process.env.AGENT_UI_RELEASE_FLAVOR ||
    (pkg.agentUI && pkg.agentUI.releaseMode),
    RELEASE_MODE_STANDALONE
  );
}

function isConnectorMode(mode = releaseMode()) {
  return normalizeReleaseMode(mode) === RELEASE_MODE_CONNECTOR;
}

function getAgentUIConfigDir() {
  const configured = String(process.env.AGENT_UI_CONFIG_DIR || '').trim();
  const dir = configured ? path.resolve(configured) : path.join(realUserHomeDir(), '.agent-ui');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function standaloneHermesHome() {
  return path.join(realUserHomeDir(), '.agent-ui', 'hermes-home');
}

function connectorHermesHome() {
  return path.join(realUserHomeDir(), 'Documents', 'hermes', 'hermes-home');
}

function defaultHermesHomeForMode(mode = releaseMode()) {
  const configured = String(process.env.AGENT_UI_HERMES_HOME || '').trim();
  if (configured) return path.resolve(configured);
  return isConnectorMode(mode) ? connectorHermesHome() : standaloneHermesHome();
}

function defaultGatewayEnvPathForMode(mode = releaseMode()) {
  const configured = String(process.env.AGENT_UI_HERMES_ENV_PATH || '').trim();
  if (configured) return path.resolve(configured);
  return path.join(defaultHermesHomeForMode(mode), '.env');
}

function connectorRuntimeStatePath() {
  return path.join(getAgentUIConfigDir(), 'connector-runtime.json');
}

function readJsonFile(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readConnectorRuntimeState() {
  return readJsonFile(connectorRuntimeStatePath(), {});
}

function rememberConnectorHermesCommand(command) {
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
    path.join(root, 'script', 'aura-hermes'),
  ];
}

module.exports = {
  RELEASE_MODE_CONNECTOR,
  RELEASE_MODE_STANDALONE,
  connectorHermesHome,
  defaultConnectorHermesCandidates,
  defaultGatewayEnvPathForMode,
  defaultHermesHomeForMode,
  getAgentUIConfigDir,
  isConnectorMode,
  normalizeReleaseMode,
  readConnectorRuntimeState,
  realUserHomeDir,
  releaseMode,
  rememberConnectorHermesCommand,
  standaloneHermesHome,
};
