import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const EVAL_CONFIG_ARG_PREFIX = '--agent-ui-eval-config=';
const EVAL_CONFIG_CWD_FILE = 'agent-ui-eval-config.json';
const EVAL_CONFIG_TMP_FILE = path.join(
  fs.existsSync('/private/tmp') ? '/private/tmp' : process.env.TMPDIR || '/tmp',
  `agent-ui-eval-config-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.json`,
);
const EVAL_CONFIG_ENV_KEYS = new Set([
  'AGENT_UI_EVAL',
  'AGENT_UI_EVAL_RUN_ID',
  'AGENT_UI_EVAL_DIR',
  'AGENT_UI_EVAL_PORT_FILE',
  'AGENT_UI_EVAL_TOKEN',
  'AGENT_UI_CONFIG_DIR',
  'AGENT_UI_HERMES_HOME',
  'LM_BASE_URL',
]);

function applyEvalConfigArgv() {
  const arg = process.argv.find((value) => String(value || '').startsWith(EVAL_CONFIG_ARG_PREFIX));
  const file = arg
    ? String(arg).slice(EVAL_CONFIG_ARG_PREFIX.length).trim()
    : String(app.commandLine.getSwitchValue('agent-ui-eval-config') || '').trim() ||
      (fs.existsSync(path.join(process.cwd(), EVAL_CONFIG_CWD_FILE))
        ? path.join(process.cwd(), EVAL_CONFIG_CWD_FILE)
        : fs.existsSync(EVAL_CONFIG_TMP_FILE)
          ? EVAL_CONFIG_TMP_FILE
          : '');
  if (!file) return;
  try {
    const config = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    if (!config || typeof config !== 'object') return;
    for (const [key, value] of Object.entries(config)) {
      if (!EVAL_CONFIG_ENV_KEYS.has(key)) continue;
      const text = String(value || '').trim();
      if (text) process.env[key] = text;
    }
  } catch (error) {
    console.warn('[agent-ui] eval config ignored', error);
  }
}

applyEvalConfigArgv();

export { applyEvalConfigArgv };
