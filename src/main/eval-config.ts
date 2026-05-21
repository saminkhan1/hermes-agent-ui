import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const EVAL_CONFIG_ARG_PREFIX = '--agent-ui-eval-config=';
const EVAL_CONFIG_ENV_KEYS = new Set([
  'AGENT_UI_EVAL',
  'AGENT_UI_EVAL_RUN_ID',
  'AGENT_UI_EVAL_DIR',
  'AGENT_UI_EVAL_PORT_FILE',
  'AGENT_UI_EVAL_TOKEN',
  'AGENT_UI_EVAL_BOOT_FILE',
  'AGENT_UI_CONFIG_DIR',
  'HERMES_HOME',
  'LM_BASE_URL',
]);

function recordEvalBoot(stage: string, payload: Record<string, unknown> = {}) {
  const file = String(process.env.AGENT_UI_EVAL_BOOT_FILE || '').trim();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        stage,
        at: new Date().toISOString(),
        eval: process.env.AGENT_UI_EVAL || '',
        portFile: process.env.AGENT_UI_EVAL_PORT_FILE || '',
        cwd: process.cwd(),
        ...payload,
      })}\n`,
      'utf8',
    );
  } catch {
    // The boot report is diagnostic evidence only; never block app startup on it.
  }
}

function applyEvalConfigArgv() {
  const arg = process.argv.find((value) => String(value || '').startsWith(EVAL_CONFIG_ARG_PREFIX));
  let file = arg ? String(arg).slice(EVAL_CONFIG_ARG_PREFIX.length).trim() : '';
  if (!file) file = String(app.commandLine.getSwitchValue('agent-ui-eval-config') || '').trim();
  if (!file) return;
  try {
    const config = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    if (!config || typeof config !== 'object') return;
    for (const [key, value] of Object.entries(config)) {
      if (!EVAL_CONFIG_ENV_KEYS.has(key)) continue;
      const text = String(value || '').trim();
      if (text) process.env[key] = text;
    }
    recordEvalBoot('eval-config-applied', {
      file: path.resolve(file),
      argv: process.argv,
      keys: Object.keys(config).sort(),
    });
  } catch (error) {
    recordEvalBoot('eval-config-error', { file: path.resolve(file), error: String(error) });
    console.warn('[agent-ui] eval config ignored', error);
  }
}

applyEvalConfigArgv();

export { applyEvalConfigArgv, recordEvalBoot };
