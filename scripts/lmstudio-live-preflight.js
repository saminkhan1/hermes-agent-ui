'use strict';

const { spawnSync } = require('node:child_process');

const model = String(process.env.AGENT_UI_LMSTUDIO_MODEL || 'google/gemma-4-26b-a4b').trim();
const baseUrl = String(process.env.AGENT_UI_LMSTUDIO_BASE_URL || process.env.LM_BASE_URL || 'http://127.0.0.1:1234/v1')
  .trim()
  .replace(/\/+$/, '');
const minContextLength = 64000;
const minParallel = Math.max(1, Math.trunc(Number(process.env.AGENT_UI_LMSTUDIO_MIN_PARALLEL || 3)));

function fail(message, details = '') {
  console.error(`[agent-ui] LM Studio preflight failed: ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
}

async function requestJson(url) {
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

function parseLoadedModels(stdout) {
  try {
    const parsed = JSON.parse(stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

(async () => {
  if (!model) fail('AGENT_UI_LMSTUDIO_MODEL is empty.');

  const version = run('lms', ['--version']);
  if (version.status !== 0) {
    fail('`lms` CLI is not available. Install LM Studio CLI and make sure `lms` is on PATH.');
  }

  const status = run('lms', ['server', 'status']);
  if (status.status !== 0 || !/running/i.test(`${status.stdout}\n${status.stderr}`)) {
    fail('LM Studio server is not running.', 'Start it with: lms server start --port 1234');
  }

  let modelsResponse;
  try {
    modelsResponse = await requestJson(`${baseUrl}/models`);
  } catch (error) {
    fail(`LM Studio OpenAI-compatible API is unreachable at ${baseUrl}.`, error && error.message ? error.message : String(error));
  }
  if (
    !modelsResponse ||
    modelsResponse.status < 200 ||
    modelsResponse.status >= 300 ||
    !modelsResponse.json ||
    !Array.isArray(modelsResponse.json.data)
  ) {
    fail(`LM Studio /models failed at ${baseUrl}.`, `${modelsResponse.status} ${modelsResponse.text}`);
  }

  const apiModelIds = modelsResponse.json.data
    .map((entry) => String(entry && entry.id || '').trim())
    .filter(Boolean);
  if (!apiModelIds.includes(model)) {
    fail(`LM Studio server does not expose ${model}.`, `Visible models: ${apiModelIds.join(', ') || '<none>'}`);
  }

  const ps = run('lms', ['ps', '--json']);
  if (ps.status !== 0) {
    fail('Could not inspect loaded LM Studio models with `lms ps --json`.', ps.stderr || ps.stdout);
  }
  const loaded = parseLoadedModels(ps.stdout);
  const loadedEntry = loaded.find((entry) => {
    return [
      entry && entry.identifier,
      entry && entry.path,
      entry && entry.modelKey,
      entry && entry.indexedModelIdentifier,
    ].map((value) => String(value || '').trim()).includes(model);
  });
  if (!loadedEntry) {
    fail(`${model} is not loaded in LM Studio.`, `Load it with: lms load --identifier ${model}`);
  }
  const loadedContextLength = Number(loadedEntry.contextLength || 0);
  if (!Number.isFinite(loadedContextLength) || loadedContextLength < minContextLength) {
    fail(
      `${model} is loaded with context length ${loadedContextLength || '<unknown>'}, below the ${minContextLength} token live-test minimum.`,
      `Reload it with: lms unload ${model} && lms load ${model} --identifier ${model} --context-length ${minContextLength} --parallel ${minParallel} -y`
    );
  }
  const parallel = Number(loadedEntry.parallel || 0);
  if (!Number.isFinite(parallel) || parallel < minParallel) {
    fail(
      `${model} is loaded with parallel=${parallel || '<unknown>'}, below the ${minParallel} request concurrency minimum.`,
      `Reload it with: lms unload ${model} && lms load ${model} --identifier ${model} --context-length ${minContextLength} --parallel ${minParallel} -y`
    );
  }

  console.log(JSON.stringify({
    ok: true,
    provider: 'lmstudio',
    baseUrl,
    model,
    lms: String(version.stdout || version.stderr || '').trim(),
    loadedStatus: loadedEntry.status || null,
    loadedContextLength,
    parallel,
    hermesContextLength: minContextLength,
  }, null, 2));
})().catch((error) => {
  fail(error && error.message ? error.message : String(error));
});
