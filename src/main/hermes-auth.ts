'use strict';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentUIPayload, MutableJsonObject } from '../shared/contracts.ts';

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import {
  defaultHermesHome,
  executableExists,
  hermesCwd,
  parseTranscriptionJson,
  resolveHermesCommand,
  safeRuntimePath,
} from './hermes-runtime';
import { realUserHomeDir } from './hermes-release';

const MAX_PROVIDER_CHARS = 96;
const MAX_LABEL_CHARS = 80;
const MAX_API_KEY_CHARS = 20000;
const MAX_MODEL_CHARS = 256;
const MAX_OUTPUT_CHARS = 120000;

const events = new EventEmitter();

type RunHermesOptions = {
  timeoutMs?: number;
};
type HermesCommandError = Error & {
  stdout?: string;
  stderr?: string;
};
type OAuthSession = {
  child: ChildProcessWithoutNullStreams;
  provider: string;
  stdout: string;
  stderr: string;
  startedAt: number;
};
type ReadinessSnapshot = {
  ok?: boolean;
  ready?: boolean;
  needs_auth?: boolean;
  needs_model?: boolean;
};

const sessions = new Map<string, OAuthSession>();

function boundedText(value: LooseBoundaryValue, max = 4096) {
  const out = value == null ? '' : String(value);
  return out.length > max ? out.slice(0, max) : out;
}

function normalizeProvider(value: LooseBoundaryValue) {
  const provider = boundedText(value, MAX_PROVIDER_CHARS).trim().toLowerCase();
  if (!provider) return '';
  if (!/^[a-z0-9_.:-]+$/.test(provider)) return '';
  return provider;
}

function normalizeLabel(value: LooseBoundaryValue) {
  return boundedText(value, MAX_LABEL_CHARS).trim();
}

function normalizeModel(value: LooseBoundaryValue) {
  return boundedText(value, MAX_MODEL_CHARS).trim();
}

function appendOutput(current: LooseBoundaryValue, chunk: LooseBoundaryValue) {
  return `${current}${String(chunk || '')}`.slice(-MAX_OUTPUT_CHARS);
}

function cleanHermesOutput(value: LooseBoundaryValue) {
  return stripVTControlCharacters(String(value || '')).replace(/\r/g, '');
}

function pythonRuntimeForHermes(command: LooseBoundaryValue) {
  const resolved = path.resolve(String(command || ''));
  const candidates = [];
  const parts = resolved.split(path.sep);
  const hermesAgentIdx = parts.lastIndexOf('hermes-agent');
  if (hermesAgentIdx >= 0) {
    const agentRoot = parts.slice(0, hermesAgentIdx + 1).join(path.sep) || path.sep;
    candidates.push({
      root: path.dirname(agentRoot),
      agentRoot,
      pythonCandidates: [
        path.join(agentRoot, 'venv', 'bin', 'python3'),
        path.join(agentRoot, '.venv', 'bin', 'python3'),
        path.join(path.dirname(resolved), 'python3'),
      ],
    });
  }

  for (const candidate of candidates) {
    const python = candidate.pythonCandidates.find(executableExists) || '';
    if (!python) continue;
    if (!fs.existsSync(path.join(candidate.agentRoot, 'hermes_cli', 'main.py'))) continue;
    return { python, agentRoot: candidate.agentRoot, root: candidate.root };
  }
  return null;
}

function hermesEnv(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    ...extra,
    HOME: realUserHomeDir(),
    HERMES_HOME: defaultHermesHome(),
    PATH: safeRuntimePath(),
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  };
}

function hermesCommandOrThrow() {
  const { command } = resolveHermesCommand();
  if (!command || !executableExists(command)) {
    throw new Error(
      'Hermes executable is missing. Set AGENT_UI_HERMES_BIN or install Hermes in ~/Documents/hermes/hermes-agent.',
    );
  }
  return command;
}

function pythonRuntimeOrThrow() {
  const command = hermesCommandOrThrow();
  const runtime = pythonRuntimeForHermes(command);
  if (!runtime) {
    throw new Error('Hermes Python runtime is missing. Rebuild the local Hermes virtualenv.');
  }
  return { command, ...runtime };
}

function redact(value: LooseBoundaryValue) {
  return cleanHermesOutput(value)
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1...')
    .replace(/([A-Za-z0-9_-]{12})[A-Za-z0-9_-]{28,}/g, '$1...');
}

function runHermesPythonJson(
  code: string,
  payload: AgentUIPayload = {},
  opts: RunHermesOptions = {},
): Promise<MutableJsonObject> {
  return new Promise((resolve, reject) => {
    let runtime;
    try {
      runtime = pythonRuntimeOrThrow();
    } catch (error) {
      reject(error);
      return;
    }

    const child = spawn(runtime.python, ['-c', code], {
      cwd: runtime.agentRoot,
      env: hermesEnv({ PYTHONPATH: runtime.agentRoot }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeoutMs = Number(opts.timeoutMs || 15000);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGTERM');
          }, timeoutMs)
        : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: LooseBoundaryValue) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk: LooseBoundaryValue) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on('error', (error: LooseBoundaryValue) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (codeNum: LooseBoundaryValue, signal: LooseBoundaryValue) => {
      if (timer) clearTimeout(timer);
      if (codeNum !== 0) {
        const err: HermesCommandError = new Error(
          redact(
            stderr.trim() || stdout.trim() || `Hermes exited with code ${codeNum}${signal ? ` (${signal})` : ''}.`,
          ),
        );
        err.stdout = redact(stdout);
        err.stderr = redact(stderr);
        reject(err);
        return;
      }
      const parsed = parseTranscriptionJson(stdout);
      if (!parsed || typeof parsed !== 'object') {
        reject(new Error('Hermes returned no JSON result.'));
        return;
      }
      resolve(parsed);
    });

    child.stdin.end(`${JSON.stringify(payload || {})}\n`);
  });
}

const STATUS_SCRIPT = String.raw`
import json
import os
import sys

payload = json.loads(sys.stdin.read() or "{}")

from hermes_cli.auth import AuthError, PROVIDER_REGISTRY, _load_auth_store
from hermes_cli.auth_commands import _OAUTH_CAPABLE_PROVIDERS
from hermes_cli.config import load_config, get_config_path, get_env_path, get_env_value
from hermes_cli.models import fetch_lmstudio_models
from hermes_cli.model_switch import list_authenticated_providers

cfg = load_config()
model_cfg = cfg.get("model", {})
if isinstance(model_cfg, dict):
    current_model = str(model_cfg.get("default", model_cfg.get("name", "")) or "")
    current_provider = str(model_cfg.get("provider", "") or "")
    current_base_url = str(model_cfg.get("base_url", "") or "")
else:
    current_model = str(model_cfg or "")
    current_provider = ""
    current_base_url = ""

user_providers = cfg.get("providers") if isinstance(cfg.get("providers"), dict) else {}
custom_providers = cfg.get("custom_providers") if isinstance(cfg.get("custom_providers"), list) else []
providers = list_authenticated_providers(
    current_provider=current_provider,
    current_base_url=current_base_url,
    current_model=current_model,
    user_providers=user_providers,
    custom_providers=custom_providers,
    max_models=50,
)

current_is_lmstudio = current_provider.strip().lower() == "lmstudio"
lmstudio_auth_required = False
if not any(
    str(provider.get("slug") or provider.get("id") or "").strip().lower() == "lmstudio"
    for provider in providers
    if isinstance(provider, dict)
):
    lmstudio_base_url = (
        current_base_url if current_is_lmstudio and current_base_url else
        get_env_value("LM_BASE_URL") or os.environ.get("LM_BASE_URL", "") or "http://127.0.0.1:1234/v1"
    ).rstrip("/")
    try:
        models = fetch_lmstudio_models(
            api_key=get_env_value("LM_API_KEY") or os.environ.get("LM_API_KEY", ""),
            base_url=lmstudio_base_url,
            timeout=1.5,
        )
    except AuthError:
        lmstudio_auth_required = True
        models = []

    if not lmstudio_auth_required and not models and current_is_lmstudio and current_model:
        models = [current_model]

    if not lmstudio_auth_required:
        providers.append({
            "slug": "lmstudio",
            "id": "lmstudio",
            "name": "LM Studio",
            "source": "hermes",
            "is_current": current_is_lmstudio,
            "auth_type": "none",
            "base_url": lmstudio_base_url,
            "models": models[:50],
            "total_models": len(models),
        })

catalog = []
for provider_id, pconfig in sorted(PROVIDER_REGISTRY.items()):
    env_vars = list(getattr(pconfig, "api_key_env_vars", ()) or ())
    auth_type = getattr(pconfig, "auth_type", "api_key") or "api_key"
    if provider_id == "lmstudio" and not lmstudio_auth_required:
        auth_type = "none"
    catalog.append({
        "id": provider_id,
        "name": getattr(pconfig, "name", provider_id) or provider_id,
        "auth_type": auth_type,
        "oauth_capable": provider_id in _OAUTH_CAPABLE_PROVIDERS,
        "api_key_env_vars": env_vars,
    })
if not any(p["id"] == "openrouter" for p in catalog):
    catalog.append({
        "id": "openrouter",
        "name": "OpenRouter",
        "auth_type": "api_key",
        "oauth_capable": False,
        "api_key_env_vars": ["OPENROUTER_API_KEY"],
    })

auth_store = _load_auth_store()
pool = auth_store.get("credential_pool") if isinstance(auth_store, dict) else {}
if not isinstance(pool, dict):
    pool = {}
pool_counts = {
    str(provider): len(entries) if isinstance(entries, list) else 0
    for provider, entries in pool.items()
}
authenticated_ids = {str(p.get("slug") or "").strip() for p in providers if isinstance(p, dict)}
ready = bool(current_provider and current_model and current_provider in authenticated_ids)

print(json.dumps({
    "ok": True,
    "ready": ready,
    "needs_auth": not bool(providers),
    "needs_model": bool(providers) and not ready,
    "current_provider": current_provider,
    "current_model": current_model,
    "providers": providers,
    "provider_catalog": catalog,
    "pool_counts": pool_counts,
    "config_path": str(get_config_path()),
    "env_path": str(get_env_path()),
}, separators=(",", ":"), sort_keys=True))
`;

const ADD_API_KEY_SCRIPT = String.raw`
import contextlib
import io
import json
import sys
from types import SimpleNamespace

payload = json.loads(sys.stdin.read() or "{}")
provider = str(payload.get("provider") or "").strip()
api_key = str(payload.get("api_key") or "").strip()
label = str(payload.get("label") or "").strip()
if not provider:
    raise SystemExit("provider is required")
if not api_key:
    raise SystemExit("api key is required")

from hermes_cli.auth_commands import auth_add_command

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    auth_add_command(SimpleNamespace(
        provider=provider,
        auth_type="api_key",
        label=label or None,
        api_key=api_key,
        portal_url=None,
        inference_url=None,
        client_id=None,
        scope=None,
        no_browser=True,
        timeout=None,
        insecure=False,
        ca_bundle=None,
    ))

print(json.dumps({
    "ok": True,
    "provider": provider,
    "output": buf.getvalue().strip(),
}, separators=(",", ":"), sort_keys=True))
`;

const SAVE_MODEL_SCRIPT = String.raw`
import json
import sys

payload = json.loads(sys.stdin.read() or "{}")
provider = str(payload.get("provider") or "").strip()
model = str(payload.get("model") or "").strip()
if not provider:
    raise SystemExit("provider is required")
if not model:
    raise SystemExit("model is required")

from hermes_cli.config import load_config, save_config, get_config_path, read_raw_config
from hermes_cli.model_normalize import normalize_model_for_provider
from hermes_cli.providers import custom_provider_slug, resolve_provider_full
from hermes_cli.runtime_provider import resolve_runtime_provider

cfg = load_config()
try:
    raw_cfg = read_raw_config()
except Exception:
    raw_cfg = cfg

def as_dict(value):
    return value if isinstance(value, dict) else {}

def as_list(value):
    return value if isinstance(value, list) else []

def text(value):
    return str(value or "").strip()

def clean_base_url(value):
    return text(value).rstrip("/")

model_cfg = as_dict(cfg.get("model")).copy()
raw_model_cfg = as_dict(raw_cfg.get("model"))
user_providers = as_dict(cfg.get("providers"))
custom_providers = as_list(cfg.get("custom_providers"))

pdef = resolve_provider_full(provider, user_providers, custom_providers)
if pdef is None:
    raise SystemExit(f"unknown provider: {provider}")

target_provider = text(getattr(pdef, "id", "")) or provider
normalized_model = normalize_model_for_provider(model, target_provider)
runtime = resolve_runtime_provider(requested=provider, target_model=normalized_model)
runtime_provider = text(runtime.get("provider")) or target_provider
runtime_base_url = clean_base_url(runtime.get("base_url") or getattr(pdef, "base_url", ""))

def find_raw_custom_provider(requested_provider, base_url):
    requested = text(requested_provider).lower()
    wanted_url = clean_base_url(base_url).lower()
    for entry in as_list(raw_cfg.get("custom_providers")):
        if not isinstance(entry, dict):
            continue
        name = text(entry.get("name"))
        provider_key = text(entry.get("provider_key"))
        entry_url = clean_base_url(entry.get("base_url") or entry.get("url") or entry.get("api"))
        identities = {name.lower(), custom_provider_slug(name).lower()} if name else set()
        if provider_key:
            identities.add(provider_key.lower())
            identities.add(custom_provider_slug(provider_key).lower())
        if requested in identities:
            return entry
        if wanted_url and entry_url.lower() == wanted_url:
            return entry
    return {}

def custom_api_key_config_value(entry, base_url):
    raw_api_key = text(entry.get("api_key")) if isinstance(entry, dict) else ""
    if raw_api_key:
        return raw_api_key
    key_env = text(entry.get("key_env")) if isinstance(entry, dict) else ""
    if key_env:
        return "$" + "{" + key_env + "}"
    previous_provider = text(raw_model_cfg.get("provider")).lower()
    previous_base_url = clean_base_url(raw_model_cfg.get("base_url")).lower()
    if previous_provider == "custom" and previous_base_url == clean_base_url(base_url).lower():
        return text(raw_model_cfg.get("api_key"))
    return ""

is_named_custom = target_provider.startswith("custom:")
is_user_provider = (
    text(getattr(pdef, "source", "")) == "user-config"
    and not is_named_custom
    and target_provider in user_providers
)
persist_provider = target_provider if is_user_provider else runtime_provider
if is_named_custom or (runtime_provider == "custom" and not is_user_provider):
    persist_provider = "custom"

model_cfg["provider"] = persist_provider
model_cfg["default"] = normalized_model
for key in ("base_url", "api_key", "api_mode", "context_length"):
    model_cfg.pop(key, None)

if runtime_base_url and not is_user_provider:
    model_cfg["base_url"] = runtime_base_url

api_mode = text(runtime.get("api_mode"))
if api_mode and (
    persist_provider == "custom"
    or target_provider in {"opencode-zen", "opencode-go", "azure-foundry"}
):
    model_cfg["api_mode"] = api_mode

if persist_provider == "custom":
    custom_entry = find_raw_custom_provider(provider, runtime_base_url)
    api_key_config = custom_api_key_config_value(custom_entry, runtime_base_url)
    if api_key_config:
        model_cfg["api_key"] = api_key_config

cfg["model"] = model_cfg
save_config(cfg)

print(json.dumps({
    "ok": True,
    "provider": persist_provider,
    "model": normalized_model,
    "base_url": model_cfg.get("base_url", ""),
    "api_mode": model_cfg.get("api_mode", ""),
    "config_path": str(get_config_path()),
}, separators=(",", ":"), sort_keys=True))
`;

function readinessFromSnapshot(snapshot: ReadinessSnapshot = {}) {
  if (!snapshot || snapshot.ok === false) return { ready: false, reason: 'status_error' };
  if (snapshot.ready) return { ready: true, reason: 'ready' };
  if (snapshot.needs_auth) return { ready: false, reason: 'needs_auth' };
  if (snapshot.needs_model) return { ready: false, reason: 'needs_model' };
  return { ready: false, reason: 'not_configured' };
}

function isAuthErrorText(value: LooseBoundaryValue) {
  const text = String(value || '').toLowerCase();
  return [
    'provider authentication failed',
    'no inference provider configured',
    'run `hermes model`',
    "run 'hermes model'",
    'hermes model',
    'primary provider auth failed',
    'no api key',
    'api key is missing',
    'authentication failed',
  ].some((marker) => text.includes(marker));
}

function extractUrls(value: LooseBoundaryValue) {
  const text = cleanHermesOutput(value);
  return Array.from(
    new Set((text.match(/https?:\/\/[^\s)>"']+/g) || []).map((url: string) => url.replace(/[.,;]+$/, ''))),
  );
}

function extractUserCode(value: LooseBoundaryValue) {
  const text = cleanHermesOutput(value);
  const explicit = text.match(/enter (?:this )?code:\s*\n\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  if (explicit) return explicit[1].trim();
  const inline = text.match(/\b(?:user[_ -]?code|code):\s*([A-Z0-9][A-Z0-9-]{3,})\b/i);
  return inline ? inline[1].trim() : '';
}

async function getAuthStatus() {
  const status = await runHermesPythonJson(STATUS_SCRIPT, {}, { timeoutMs: 20000 });
  return { ...status, readiness: readinessFromSnapshot(status) };
}

async function ensureReadyForRun() {
  try {
    const status = await getAuthStatus();
    return {
      ok: !!(status.readiness && status.readiness.ready),
      status,
      reason: status.readiness ? status.readiness.reason : 'unknown',
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'status_error',
      error: error instanceof Error && error.message ? error.message : String(error),
    };
  }
}

async function addApiKeyCredential(payload: AgentUIPayload = {}) {
  const provider = normalizeProvider(payload.provider);
  const apiKey = boundedText(payload.apiKey || payload.api_key, MAX_API_KEY_CHARS).trim();
  const label = normalizeLabel(payload.label);
  if (!provider) return { ok: false, error: 'Choose a provider.' };
  if (!apiKey) return { ok: false, error: 'Enter an API key.' };
  try {
    return await runHermesPythonJson(ADD_API_KEY_SCRIPT, { provider, api_key: apiKey, label }, { timeoutMs: 30000 });
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message ? error.message : String(error) };
  }
}

async function saveModelSelection(payload: AgentUIPayload = {}) {
  const provider = normalizeProvider(payload.provider);
  const model = normalizeModel(payload.model);
  if (!provider) return { ok: false, error: 'Choose a provider.' };
  if (!model) return { ok: false, error: 'Choose or enter a model.' };
  try {
    return await runHermesPythonJson(SAVE_MODEL_SCRIPT, { provider, model }, { timeoutMs: 15000 });
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message ? error.message : String(error) };
  }
}

function emitSessionEvent(event: LooseBoundaryValue) {
  events.emit('event', event);
}

function startOAuthSession(payload: AgentUIPayload = {}) {
  const provider = normalizeProvider(payload.provider);
  if (!provider) return { ok: false, error: 'Choose a provider.' };
  let command;
  try {
    command = hermesCommandOrThrow();
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message ? error.message : String(error) };
  }

  const sessionId = randomUUID();
  const args = ['auth', 'add', provider, '--type', 'oauth', '--no-browser'];
  const child = spawn(command, args, {
    cwd: hermesCwd(command),
    env: hermesEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rec: {
    child: LooseBoundaryValue;
    provider: string;
    stdout: string;
    stderr: string;
    startedAt: number;
  } = { child, provider, stdout: '', stderr: '', startedAt: Date.now() };
  sessions.set(sessionId, rec);

  const onOutput = (stream: 'stdout' | 'stderr') => (chunk: LooseBoundaryValue) => {
    const rawText = String(chunk || '');
    const text = cleanHermesOutput(rawText);
    rec[stream] = appendOutput(rec[stream], text);
    const output = `${rec.stdout}\n${rec.stderr}`;
    emitSessionEvent({
      sessionId,
      provider,
      type: 'output',
      stream,
      text,
      urls: extractUrls(output),
      userCode: extractUserCode(output),
    });
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', onOutput('stdout'));
  child.stderr.on('data', onOutput('stderr'));
  child.once('error', (error: LooseBoundaryValue) => {
    sessions.delete(sessionId);
    emitSessionEvent({
      sessionId,
      provider,
      type: 'error',
      error: error instanceof Error && error.message ? error.message : String(error),
    });
  });
  child.once('close', (code: LooseBoundaryValue, signal: LooseBoundaryValue) => {
    sessions.delete(sessionId);
    emitSessionEvent({
      sessionId,
      provider,
      type: 'exit',
      ok: code === 0,
      code,
      signal,
      stdout: redact(rec.stdout),
      stderr: redact(rec.stderr),
    });
  });

  emitSessionEvent({ sessionId, provider, type: 'started' });
  return { ok: true, sessionId, provider };
}

function sendOAuthInput(payload: AgentUIPayload = {}) {
  const sessionId = boundedText(payload.sessionId, 128).trim();
  const input = boundedText(payload.input, 10000);
  const rec = sessions.get(sessionId);
  if (!rec || !rec.child || rec.child.killed) return { ok: false, error: 'Auth session is not running.' };
  rec.child.stdin.write(`${input.replace(/\r?\n/g, '')}\n`);
  return { ok: true };
}

function cancelOAuthSession(payload: AgentUIPayload = {}) {
  const sessionId = boundedText(payload.sessionId, 128).trim();
  const rec = sessions.get(sessionId);
  if (!rec || !rec.child || rec.child.killed) return { ok: true };
  rec.child.kill('SIGTERM');
  return { ok: true };
}

function onSessionEvent(listener: LooseBoundaryValue) {
  events.on('event', listener);
  return () => events.off('event', listener);
}

export {
  addApiKeyCredential,
  cancelOAuthSession,
  ensureReadyForRun,
  extractUrls,
  extractUserCode,
  getAuthStatus,
  isAuthErrorText,
  onSessionEvent,
  readinessFromSnapshot,
  saveModelSelection,
  sendOAuthInput,
  startOAuthSession,
};
