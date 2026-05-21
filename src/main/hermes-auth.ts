'use strict';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentUIPayload, MutableJsonObject } from '../shared/contracts.ts';

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import {
  connectorHermesRuntimeForCommand,
  defaultHermesHome,
  executableExists,
  resolveHermesCommand,
  safeRuntimePath,
} from './hermes-runtime';
import { realUserHomeDir } from './hermes-release';

const MAX_PROVIDER_CHARS = 96;
const MAX_LABEL_CHARS = 80;
const MAX_API_KEY_CHARS = 20000;
const MAX_MODEL_CHARS = 256;
const MAX_OUTPUT_CHARS = 120000;
const MAX_BRIDGE_OUTPUT_CHARS = 4_000_000;
const AUTH_ERROR_MARKERS = [
  'provider authentication failed',
  'no inference provider configured',
  'run `hermes model`',
  "run 'hermes model'",
  'hermes model',
  'primary provider auth failed',
  'no api key',
  'api key is missing',
  'authentication failed',
];

const events = new EventEmitter();
const sessions = new Map<string, OAuthSession>();

type RunHermesOptions = {
  timeoutMs?: number;
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

function hermesEnv(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    ...extra,
    HOME: realUserHomeDir(),
    HERMES_HOME: defaultHermesHome(),
    PATH: safeRuntimePath(),
    PYTHONUNBUFFERED: '1',
  };
}

function hermesCommandOrThrow() {
  const { command } = resolveHermesCommand();
  if (!command || !executableExists(command)) {
    throw new Error('Hermes executable is missing. Install Hermes with the official installer.');
  }
  return command;
}

function redact(value: LooseBoundaryValue) {
  return cleanHermesOutput(value)
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1...')
    .replace(/([A-Za-z0-9_-]{12})[A-Za-z0-9_-]{28,}/g, '$1...');
}

function pythonRuntimeOrThrow() {
  const command = hermesCommandOrThrow();
  const connector = connectorHermesRuntimeForCommand(command);
  if (!connector) {
    throw new Error('Hermes Python runtime is unavailable from the resolved Hermes launcher.');
  }
  return { command, ...connector };
}

function parseJsonOutput(stdout: LooseBoundaryValue): MutableJsonObject {
  const text = cleanHermesOutput(stdout).trim();
  if (!text) throw new Error('Hermes returned no JSON result.');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Hermes returned invalid JSON.');
  return parsed as MutableJsonObject;
}

async function runHermesPythonJson(
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
    const timeoutMs = Number(opts.timeoutMs || 20000);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGTERM');
          }, timeoutMs)
        : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: LooseBoundaryValue) => {
      stdout = `${stdout}${String(chunk || '')}`.slice(-MAX_BRIDGE_OUTPUT_CHARS);
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
        reject(
          new Error(
            redact(
              stderr.trim() || stdout.trim() || `Hermes exited with code ${codeNum}${signal ? ` (${signal})` : ''}.`,
            ),
          ),
        );
        return;
      }
      try {
        resolve(parseJsonOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(`${JSON.stringify(payload || {})}\n`);
  });
}

const STATUS_SCRIPT = String.raw`
import json
import sys

from hermes_cli.auth import PROVIDER_REGISTRY
from hermes_cli.config import get_config_path, get_env_path
from hermes_cli.inventory import build_models_payload, load_picker_context
from hermes_cli.runtime_provider import resolve_runtime_provider

try:
    from hermes_cli.auth_commands import _OAUTH_CAPABLE_PROVIDERS
except Exception:
    _OAUTH_CAPABLE_PROVIDERS = set()


def enrich(row):
    row = dict(row or {})
    slug = str(row.get("slug") or row.get("id") or "").strip()
    if slug:
        row.setdefault("id", slug)
        row.setdefault("slug", slug)
    pconfig = PROVIDER_REGISTRY.get(slug)
    if pconfig is not None:
        row.setdefault("name", getattr(pconfig, "name", slug) or slug)
        row["auth_type"] = getattr(pconfig, "auth_type", "") or row.get("auth_type") or "api_key"
        env_vars = list(getattr(pconfig, "api_key_env_vars", ()) or ())
        if env_vars:
            row.setdefault("api_key_env_vars", env_vars)
            row.setdefault("key_env", env_vars[0])
    row["oauth_capable"] = bool(slug in _OAUTH_CAPABLE_PROVIDERS or str(row.get("auth_type") or "").startswith("oauth"))
    return row


def row_provider_id(row):
    return str(row.get("slug") or row.get("id") or "").strip()


def catalog_row_for(*ids):
    wanted = {str(value or "").strip() for value in ids if str(value or "").strip()}
    for row in catalog:
        if row_provider_id(row) in wanted:
            return row
    return {}


ctx = load_picker_context()
payload = build_models_payload(
    ctx,
    include_unconfigured=True,
    picker_hints=True,
    canonical_order=True,
    max_models=50,
)
catalog = [enrich(row) for row in payload.get("providers", []) if isinstance(row, dict)]
providers = [row for row in catalog if row.get("authenticated")]
current_provider = str(payload.get("provider") or "").strip()
current_model = str(payload.get("model") or "").strip()
authenticated_ids = {str(row.get("slug") or row.get("id") or "").strip() for row in providers}
if current_provider and current_model and current_provider not in authenticated_ids:
    try:
        runtime = resolve_runtime_provider(requested=current_provider, target_model=current_model)
    except Exception:
        runtime = None
    if runtime:
        runtime_provider = str(runtime.get("provider") or "").strip()
        requested_provider = str(runtime.get("requested_provider") or "").strip()
        runtime_row = enrich(catalog_row_for(current_provider, requested_provider, runtime_provider))
        runtime_row["id"] = current_provider
        runtime_row["slug"] = current_provider
        runtime_row.setdefault("name", current_provider)
        runtime_row["authenticated"] = True
        runtime_row["is_current"] = True
        runtime_row["source"] = runtime_row.get("source") or str(runtime.get("source") or "runtime")
        runtime_row.pop("warning", None)
        models = runtime_row.get("models") if isinstance(runtime_row.get("models"), list) else []
        if current_model and current_model not in models:
            models = [current_model, *models]
        runtime_row["models"] = models[:50]
        runtime_row["total_models"] = max(len(models), int(runtime_row.get("total_models") or 0))
        providers.append(runtime_row)
        authenticated_ids = {str(row.get("slug") or row.get("id") or "").strip() for row in providers}
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

from hermes_cli.config import load_config, read_raw_config, save_config, get_config_path
from hermes_cli.inventory import load_picker_context
from hermes_cli.model_switch import switch_model

ctx = load_picker_context()
result = switch_model(
    raw_input=model,
    current_provider=ctx.current_provider,
    current_model=ctx.current_model,
    current_base_url=ctx.current_base_url,
    current_api_key="",
    is_global=True,
    explicit_provider=provider,
    user_providers=ctx.user_providers,
    custom_providers=ctx.custom_providers,
)
if not result.success:
    raise SystemExit(result.error_message or "Hermes could not switch model.")

try:
    cfg = read_raw_config()
except Exception:
    cfg = load_config()
if not isinstance(cfg, dict):
    cfg = {}
model_cfg = cfg.get("model")
if not isinstance(model_cfg, dict):
    model_cfg = {}
    cfg["model"] = model_cfg
model_cfg["provider"] = result.target_provider
model_cfg["default"] = result.new_model
for key in ("base_url", "api_mode", "api_key"):
    model_cfg.pop(key, None)
if result.base_url:
    model_cfg["base_url"] = result.base_url
save_config(cfg)

print(json.dumps({
    "ok": True,
    "provider": result.target_provider,
    "model": result.new_model,
    "base_url": result.base_url,
    "api_mode": result.api_mode,
    "warning": result.warning_message,
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
  return AUTH_ERROR_MARKERS.some((marker) => text.includes(marker));
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
  const status = await runHermesPythonJson(STATUS_SCRIPT, {}, { timeoutMs: 30000 });
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
    return await runHermesPythonJson(SAVE_MODEL_SCRIPT, { provider, model }, { timeoutMs: 30000 });
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
    env: hermesEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rec: OAuthSession = { child, provider, stdout: '', stderr: '', startedAt: Date.now() };
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
