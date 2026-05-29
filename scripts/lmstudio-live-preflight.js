'use strict';

const { spawnSync } = require('node:child_process');

let model = String(process.env.AGENT_UI_LMSTUDIO_MODEL || '').trim();
const baseUrl = String(process.env.AGENT_UI_LMSTUDIO_BASE_URL || process.env.LM_BASE_URL || 'http://127.0.0.1:1234/v1')
  .trim()
  .replace(/\/+$/, '');
const nativeBaseUrl = String(
  process.env.AGENT_UI_LMSTUDIO_NATIVE_BASE_URL ||
    (baseUrl.endsWith('/v1') ? `${baseUrl.slice(0, -3)}/api/v1` : 'http://127.0.0.1:1234/api/v1'),
)
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

async function requestJson(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.headers,
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeoutMs || 5000),
  });
  const text = await res.text();
  let json;
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
  const version = run('lms', ['--version']);
  if (version.status !== 0) {
    fail('`lms` CLI is not available. Install LM Studio CLI and make sure `lms` is on PATH.');
  }

  const status = run('lms', ['server', 'status']);
  if (status.status !== 0 || !/running/i.test(`${status.stdout}\n${status.stderr}`)) {
    fail('LM Studio server is not running.', 'Start it with: lms server start --port 1234');
  }

  const ps = run('lms', ['ps', '--json']);
  if (ps.status !== 0) {
    fail('Could not inspect loaded LM Studio models with `lms ps --json`.', ps.stderr || ps.stdout);
  }
  const loaded = parseLoadedModels(ps.stdout);

  let nativeModelsResponse;
  try {
    nativeModelsResponse = await requestJson(`${nativeBaseUrl}/models`);
  } catch (error) {
    fail(
      `LM Studio native REST API is unreachable at ${nativeBaseUrl}.`,
      error && error.message ? error.message : String(error),
    );
  }
  if (
    !nativeModelsResponse ||
    nativeModelsResponse.status < 200 ||
    nativeModelsResponse.status >= 300 ||
    !nativeModelsResponse.json ||
    !Array.isArray(nativeModelsResponse.json.models)
  ) {
    fail(
      `LM Studio /api/v1/models failed at ${nativeBaseUrl}.`,
      `${nativeModelsResponse.status} ${nativeModelsResponse.text}`,
    );
  }

  if (!model) {
    const loadedLlm = loaded.find((entry) => entry && entry.type === 'llm' && String(entry.identifier || '').trim());
    const apiLoadedLlm = nativeModelsResponse.json.models.find((entry) => {
      return (
        entry && entry.type === 'llm' && Array.isArray(entry.loaded_instances) && entry.loaded_instances.length > 0
      );
    });
    model = String(
      (loadedLlm && loadedLlm.identifier) ||
        (apiLoadedLlm && apiLoadedLlm.loaded_instances[0] && apiLoadedLlm.loaded_instances[0].id) ||
        '',
    ).trim();
  }
  if (!model) fail('LM Studio has no loaded chat model. Set AGENT_UI_LMSTUDIO_MODEL or load a model with `lms load`.');

  let modelsResponse;
  try {
    modelsResponse = await requestJson(`${baseUrl}/models`);
  } catch (error) {
    fail(
      `LM Studio OpenAI-compatible API is unreachable at ${baseUrl}.`,
      error && error.message ? error.message : String(error),
    );
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

  const apiModelIds = modelsResponse.json.data.map((entry) => String((entry && entry.id) || '').trim()).filter(Boolean);
  if (!apiModelIds.includes(model)) {
    fail(`LM Studio server does not expose ${model}.`, `Visible models: ${apiModelIds.join(', ') || '<none>'}`);
  }

  const loadedEntry = loaded.find((entry) => {
    return [
      entry && entry.identifier,
      entry && entry.path,
      entry && entry.modelKey,
      entry && entry.indexedModelIdentifier,
    ]
      .map((value) => String(value || '').trim())
      .includes(model);
  });
  if (!loadedEntry) {
    fail(`${model} is not loaded in LM Studio.`, `Load it with: lms load --identifier ${model}`);
  }
  const loadedContextLength = Number(loadedEntry.contextLength || 0);
  if (!Number.isFinite(loadedContextLength) || loadedContextLength < minContextLength) {
    fail(
      `${model} is loaded with context length ${loadedContextLength || '<unknown>'}, below the ${minContextLength} token live-test minimum.`,
      `Reload it with: lms unload ${model} && lms load ${model} --identifier ${model} --context-length ${minContextLength} --parallel ${minParallel} -y`,
    );
  }
  const parallel = Number(loadedEntry.parallel || 0);
  if (!Number.isFinite(parallel) || parallel < minParallel) {
    fail(
      `${model} is loaded with parallel=${parallel || '<unknown>'}, below the ${minParallel} request concurrency minimum.`,
      `Reload it with: lms unload ${model} && lms load ${model} --identifier ${model} --context-length ${minContextLength} --parallel ${minParallel} -y`,
    );
  }

  let nativeChatResponse;
  try {
    nativeChatResponse = await requestJson(`${nativeBaseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        input: 'Reply with AGENT_UI_LMSTUDIO_PREFLIGHT_OK only.',
        temperature: 0,
        max_output_tokens: 16,
        reasoning: 'off',
        store: false,
      }),
      timeoutMs: 120000,
    });
  } catch (error) {
    fail(`LM Studio /api/v1/chat failed at ${nativeBaseUrl}.`, error && error.message ? error.message : String(error));
  }
  if (
    !nativeChatResponse ||
    nativeChatResponse.status < 200 ||
    nativeChatResponse.status >= 300 ||
    !nativeChatResponse.json ||
    !Array.isArray(nativeChatResponse.json.output)
  ) {
    fail(
      `LM Studio /api/v1/chat failed at ${nativeBaseUrl}.`,
      `${nativeChatResponse.status} ${nativeChatResponse.text}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider: 'lmstudio',
        baseUrl,
        nativeBaseUrl,
        model,
        lms: String(version.stdout || version.stderr || '').trim(),
        loadedStatus: loadedEntry.status || null,
        loadedContextLength,
        parallel,
        hermesContextLength: minContextLength,
      },
      null,
      2,
    ),
  );
})().catch((error) => {
  fail(error && error.message ? error.message : String(error));
});
