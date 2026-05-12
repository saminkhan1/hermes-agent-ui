'use strict';

import type { ChildProcess, ExecFileOptionsWithStringEncoding } from 'node:child_process';
import type { MutableJsonObject } from '../shared/contracts.ts';

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { parseGatewayEnvText } from './hermes-gateway-client';
import {
  defaultConnectorHermesCandidates,
  defaultGatewayEnvPathForMode,
  defaultHermesHomeForMode,
  readConnectorRuntimeState,
  realUserHomeDir,
  rememberConnectorHermesCommand,
} from './hermes-release';

const CLI_BIN_ENV = 'AGENT_UI_HERMES_BIN';
const GATEWAY_AUTOSTART_ENV = 'AGENT_UI_HERMES_GATEWAY_AUTOSTART';
const LOCAL_DESKTOP_USER = 'local';
const LOCAL_DESKTOP_PLATFORM = 'local_desktop';
const LOCAL_DESKTOP_HOME_CHANNEL = 'agent-ui';
const LOCAL_DESKTOP_HOME_CHANNEL_NAME = 'Agent UI';
const BASE_RUNTIME_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';

function safeRuntimePath() {
  return `${BASE_RUNTIME_PATH}:${path.join(realUserHomeDir(), '.local', 'bin')}`;
}

function localDesktopPluginRoot() {
  const resourcesPath = String((process as LooseBoundaryValue).resourcesPath || '');
  const resourceRoot = resourcesPath ? path.join(resourcesPath, 'hermes-platforms') : '';
  if (resourceRoot && fs.existsSync(path.join(resourceRoot, 'local_desktop', 'plugin.yaml'))) {
    return resourceRoot;
  }
  const devRoot = path.resolve(__dirname, '..', '..', 'vendor', 'hermes-platforms');
  if (fs.existsSync(path.join(devRoot, 'local_desktop', 'plugin.yaml'))) return devRoot;
  return '';
}

type CommandError = Error & {
  stdout?: string;
  stderr?: string;
};
type ExecTextOptions = ExecFileOptionsWithStringEncoding & {
  timeout?: number;
};
type JsonEventOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
};
type CaptureVoiceOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  onStatus?: (status: string) => void;
};
type GatewayEnv = Record<string, string>;
type GatewayEnvOverrides = {
  LOCAL_DESKTOP_HOST?: string;
  LOCAL_DESKTOP_PORT?: string;
  host?: string | number;
  port?: string | number;
};
type GatewayReadyOptions = {
  readyAttempts?: number;
  readyIntervalMs?: number;
  readyRequestTimeoutMs?: number;
};
type StreamProbeResult = {
  error?: boolean;
  done?: boolean;
  pending?: boolean;
};
const GATEWAY_READY_ATTEMPTS = 80;
const GATEWAY_READY_INTERVAL_MS = 250;
const GATEWAY_READY_REQUEST_TIMEOUT_MS = 500;
const GATEWAY_OCCUPIED_PORT_PREFLIGHT_TIMEOUT_MS = 150;
const GATEWAY_OUTPUT_TAIL_CHARS = 4000;
const LOCAL_DESKTOP_ENV_KEYS = [
  'LOCAL_DESKTOP_GATEWAY_KEY',
  'LOCAL_DESKTOP_ALLOWED_USERS',
  'LOCAL_DESKTOP_ALLOW_ALL_USERS',
  'LOCAL_DESKTOP_HOST',
  'LOCAL_DESKTOP_PORT',
  'LOCAL_DESKTOP_HOME_CHANNEL',
  'LOCAL_DESKTOP_HOME_CHANNEL_NAME',
];

let gatewayProcess: LooseBoundaryValue = null;
let gatewayStartPromise: LooseBoundaryValue = null;

function pythonNoBytecodeEnv(extra = {}) {
  return {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    ...extra,
  };
}

function envFlag(name: LooseBoundaryValue, defaultValue = false, falseValues = ['0', 'false', 'off']) {
  const raw = String(process.env[name] || '')
    .trim()
    .toLowerCase();
  if (!raw) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (falseValues.includes(raw)) return false;
  return defaultValue;
}

function executableExists(filePath: LooseBoundaryValue) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function execFileText(
  command: LooseBoundaryValue,
  args: LooseBoundaryValue,
  opts: ExecTextOptions = { encoding: 'utf8' },
) {
  const { stdout } = await execFileAsync(command, args, { encoding: 'utf8', timeout: 5000, ...opts });
  return String(stdout || '');
}

function execFileTextWithJsonEvents(
  command: LooseBoundaryValue,
  args: LooseBoundaryValue,
  opts: JsonEventOptions = {},
  onJsonLine: LooseBoundaryValue,
) {
  return new Promise((resolve, reject) => {
    if (opts.signal && opts.signal.aborted) {
      const err: CommandError = new Error('Process aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let settled = false;
    let closed = false;
    const timeoutMs = Number(opts.timeout || 0);
    const stopChild = () => {
      if (closed) return;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, 1500).unref();
    };
    const timer = timeoutMs > 0 ? setTimeout(stopChild, timeoutMs) : null;
    const onAbort = () => stopChild();
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: LooseBoundaryValue) => {
      stdout += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object' && typeof onJsonLine === 'function') {
            onJsonLine(parsed);
          }
        } catch {
          // Hermes may print non-JSON setup chatter.
        }
      }
    });
    child.stderr.on('data', (chunk: LooseBoundaryValue) => {
      stderr += chunk;
    });
    child.on('error', (err: LooseBoundaryValue) => {
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      const commandError = err as CommandError;
      commandError.stdout = stdout;
      commandError.stderr = stderr;
      reject(commandError);
    });
    child.on('close', (code: LooseBoundaryValue, signal: LooseBoundaryValue) => {
      closed = true;
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (stdoutBuffer.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuffer.trim());
          if (parsed && typeof parsed === 'object' && typeof onJsonLine === 'function') {
            onJsonLine(parsed);
          }
        } catch {
          // Keep final parsing centralized in parseTranscriptionJson.
        }
      }
      if (opts.signal && opts.signal.aborted) {
        const err: CommandError = new Error('Process aborted');
        err.name = 'AbortError';
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      if (code !== 0) {
        const err: CommandError = new Error(`Process exited with code ${code}${signal ? ` (${signal})` : ''}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function absoluteCommandPath(value: LooseBoundaryValue) {
  const command = String(value || '').trim();
  if (!command) return '';
  return path.isAbsolute(command) ? command : path.resolve(process.cwd(), command);
}

function resolveConnectorHermesCommand(configured = '') {
  const configuredPath = absoluteCommandPath(configured);
  if (configuredPath) {
    if (executableExists(configuredPath)) rememberConnectorHermesCommand(configuredPath);
    return {
      command: configuredPath,
      configured: true,
      bundled: false,
      releaseMode: 'connector',
      remembered: false,
      needsOnboarding: !executableExists(configuredPath),
    };
  }

  const state = readConnectorRuntimeState();
  const remembered = absoluteCommandPath(state.hermesBin);
  if (remembered && !executableExists(remembered)) {
    return {
      command: '',
      configured: false,
      bundled: false,
      releaseMode: 'connector',
      remembered: true,
      needsOnboarding: true,
      invalidRememberedPath: remembered,
    };
  }
  if (remembered) {
    return {
      command: remembered,
      configured: false,
      bundled: false,
      releaseMode: 'connector',
      remembered: true,
      needsOnboarding: false,
    };
  }

  for (const candidate of defaultConnectorHermesCandidates()) {
    const resolved = absoluteCommandPath(candidate);
    if (executableExists(resolved)) {
      rememberConnectorHermesCommand(resolved);
      return {
        command: resolved,
        configured: false,
        bundled: false,
        releaseMode: 'connector',
        remembered: false,
        needsOnboarding: false,
      };
    }
  }

  return {
    command: '',
    configured: false,
    bundled: false,
    releaseMode: 'connector',
    remembered: false,
    needsOnboarding: true,
  };
}

function resolveHermesCommand() {
  const configured = String(process.env[CLI_BIN_ENV] || '').trim();
  return resolveConnectorHermesCommand(configured);
}

function hermesCwd(command: LooseBoundaryValue) {
  const connector = connectorHermesRuntimeForCommand(command);
  if (connector && connector.agentRoot) return connector.agentRoot;
  return process.cwd();
}

function connectorHermesRuntimeForCommand(command: LooseBoundaryValue) {
  const resolved = path.resolve(String(command || ''));
  const candidates = [];

  const parts = resolved.split(path.sep);
  const hermesAgentIdx = parts.lastIndexOf('hermes-agent');
  if (hermesAgentIdx >= 0) {
    const agentRoot = parts.slice(0, hermesAgentIdx + 1).join(path.sep) || path.sep;
    candidates.push({
      agentRoot,
      hermesHome: defaultHermesHome(),
      projectRoot: agentRoot,
    });
  }

  for (const candidate of candidates) {
    const pyCandidates = [
      path.join(candidate.agentRoot, 'venv', 'bin', 'python3'),
      path.join(candidate.agentRoot, '.venv', 'bin', 'python3'),
      path.join(path.dirname(resolved), 'python3'),
    ];
    const python = pyCandidates.find(executableExists) || '';
    if (!python) continue;
    if (!fs.existsSync(path.join(candidate.agentRoot, 'hermes_cli', 'main.py'))) continue;
    return { ...candidate, python };
  }

  return null;
}

async function hermesPythonRuntimeForCommand(command: LooseBoundaryValue) {
  const connector = connectorHermesRuntimeForCommand(command);
  if (!connector || !(await voiceDependenciesAvailable(connector.python))) return null;
  return connector;
}

function parseTranscriptionJson(stdout: LooseBoundaryValue) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Keep scanning for the final JSON line; Hermes may emit setup chatter first.
    }
  }
  return null;
}

async function voiceDependenciesAvailable(python: LooseBoundaryValue) {
  if (!executableExists(python)) return false;
  try {
    const stdout = await execFileText(
      python,
      [
        '-c',
        [
          'import importlib.util, json',
          'missing = [name for name in ("sounddevice", "numpy", "faster_whisper") if importlib.util.find_spec(name) is None]',
          'print(json.dumps({"ok": not missing, "missing": missing}))',
        ].join('\n'),
      ],
      { timeout: 10000, env: pythonNoBytecodeEnv() },
    );
    const result = parseTranscriptionJson(stdout);
    return !!(result && result.ok);
  } catch {
    return false;
  }
}

function formatVoiceCaptureErrorForUser(value: LooseBoundaryValue) {
  const raw = String(value && value.message ? value.message : value || 'Could not capture voice input.').trim();
  const lower = raw.toLowerCase();
  if (/permission|denied|microphone|inputstream|portaudio|input device|no default input/.test(lower)) {
    if (/privacy & security|system settings|microphone/.test(lower) && /agent-ui/.test(lower)) return raw;
    return `${raw} Check macOS System Settings > Privacy & Security > Microphone for agent-UI, confirm an input device is selected, then retry voice input.`;
  }
  if (/no speech|silence|no transcript/.test(lower)) {
    return `${raw} Check that the microphone is selected and not muted, then try again.`;
  }
  return raw;
}

async function captureAndTranscribeVoice(opts: CaptureVoiceOptions = {}) {
  const { command } = resolveHermesCommand();
  if (!command || !executableExists(command)) {
    return {
      ok: false,
      error:
        'Hermes executable is missing. Set AGENT_UI_HERMES_BIN or install Hermes in ~/Documents/hermes/hermes-agent.',
    };
  }
  try {
    const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
    const runtime = await hermesPythonRuntimeForCommand(command);
    if (!runtime) throw new Error('Hermes Python runtime is not available.');
    const code = [
      'import json, os, sys, threading, time',
      'from pathlib import Path',
      'audio_path = None',
      'try:',
      '    from hermes_cli.env_loader import load_hermes_dotenv',
      '    project_root = Path(os.environ.get("AGENT_UI_HERMES_PROJECT_ROOT", "."))',
      '    load_hermes_dotenv(project_env=project_root / ".env")',
      '    from hermes_cli.config import load_config',
      '    from tools.voice_mode import check_voice_requirements, create_audio_recorder, play_beep, transcribe_recording',
      '    cfg = load_config().get("voice", {})',
      '    def clamp_float(value, fallback, min_value, max_value):',
      '        try:',
      '            parsed = float(value)',
      '        except (TypeError, ValueError):',
      '            parsed = float(fallback)',
      '        return max(float(min_value), min(float(parsed), float(max_value)))',
      '    requirements = check_voice_requirements()',
      '    if not requirements.get("available"):',
      '        raise RuntimeError(requirements.get("details") or "Hermes voice mode requirements are not available.")',
      '    silence_threshold = int(cfg.get("silence_threshold", 200))',
      '    silence_duration = clamp_float(os.environ.get("AGENT_UI_VOICE_SILENCE_DURATION", cfg.get("agent_ui_silence_duration", 1.2)), 1.2, 0.6, 2.0)',
      '    max_recording_seconds = clamp_float(os.environ.get("AGENT_UI_VOICE_MAX_RECORDING_SECONDS", cfg.get("agent_ui_max_recording_seconds", 45)), 45, 5, 60)',
      '    no_speech_seconds = clamp_float(os.environ.get("AGENT_UI_VOICE_NO_SPEECH_SECONDS", cfg.get("agent_ui_no_speech_seconds", 8)), 8, 3, 15)',
      '    beep_enabled = bool(cfg.get("beep_enabled", True))',
      '    started_at = time.monotonic()',
      '    stopped = threading.Event()',
      '    recorder = create_audio_recorder()',
      '    if hasattr(recorder, "_silence_threshold"):',
      '        recorder._silence_threshold = silence_threshold',
      '    if hasattr(recorder, "_silence_duration"):',
      '        recorder._silence_duration = silence_duration',
      '    if hasattr(recorder, "_max_wait"):',
      '        recorder._max_wait = no_speech_seconds',
      '    def on_silence_stop():',
      '        stopped.set()',
      '    if beep_enabled:',
      '        try:',
      '            play_beep(frequency=880, count=1)',
      '        except Exception:',
      '            pass',
      '    recorder.start(on_silence_stop=on_silence_stop)',
      '    deadline = time.monotonic() + max_recording_seconds',
      '    while not stopped.is_set() and time.monotonic() < deadline:',
      '        time.sleep(0.1)',
      '    audio_path = recorder.stop()',
      '    recording_ms = int((time.monotonic() - started_at) * 1000)',
      '    try:',
      '        recorder.shutdown()',
      '    except Exception:',
      '        pass',
      '    if beep_enabled:',
      '        try:',
      '            play_beep(frequency=660, count=2)',
      '        except Exception:',
      '            pass',
      '    if not audio_path:',
      '        result = {"success": False, "error": "No speech was detected."}',
      '    else:',
      '        print(json.dumps({"status": "transcribing", "recording_ms": recording_ms}), flush=True)',
      '        transcribe_started = time.monotonic()',
      '        result = transcribe_recording(audio_path)',
      '        if isinstance(result, dict):',
      '            result["_timing"] = {"recording_ms": recording_ms, "transcribing_ms": int((time.monotonic() - transcribe_started) * 1000), "total_ms": int((time.monotonic() - started_at) * 1000)}',
      'except Exception as exc:',
      '    result = {"success": False, "error": f"{type(exc).__name__}: {exc}"}',
      'finally:',
      '    if audio_path:',
      '        try:',
      '            os.unlink(audio_path)',
      '        except OSError:',
      '            pass',
      'print(json.dumps(result, separators=(",", ":"), sort_keys=True))',
    ].join('\n');
    const stdout = await execFileTextWithJsonEvents(
      runtime.python,
      ['-c', code],
      {
        cwd: runtime.agentRoot,
        env: pythonNoBytecodeEnv({
          HOME: realUserHomeDir(),
          HERMES_HOME: runtime.hermesHome,
          PATH: safeRuntimePath(),
          PYTHONPATH: runtime.agentRoot,
          AGENT_UI_HERMES_PROJECT_ROOT: runtime.projectRoot,
        }),
        signal: opts.signal,
        timeout: opts.timeoutMs || 180000,
      },
      (event: MutableJsonObject) => {
        if (onStatus && event.status === 'transcribing') onStatus(String(event.status));
      },
    );
    const result = parseTranscriptionJson(stdout);
    if (!result) return { ok: false, error: 'Hermes returned no voice result.' };
    const transcript = String(result.transcript || '').trim();
    if (!result.success || !transcript) {
      return {
        ok: false,
        error: formatVoiceCaptureErrorForUser(result.error || 'No speech was detected.'),
        raw: result,
      };
    }
    return {
      ok: true,
      transcript,
      provider: result.provider || result.model || null,
      raw: result,
    };
  } catch (e) {
    const error = e as CommandError;
    if (error && error.name === 'AbortError')
      return { ok: false, cancelled: true, error: 'Voice input was cancelled.' };
    return {
      ok: false,
      error: formatVoiceCaptureErrorForUser((error && (error.stderr || error.message)) || String(e)),
    };
  }
}

function defaultHermesHome() {
  return defaultHermesHomeForMode();
}

function effectiveGatewayHermesHome() {
  return defaultHermesHome();
}

function defaultGatewayConfigYaml() {
  return [
    '# Generated by agent-UI. Hermes owns conversation state and gateway behavior.',
    'platforms:',
    `  ${LOCAL_DESKTOP_PLATFORM}:`,
    '    enabled: true',
    '',
  ].join('\n');
}

function lineIndent(line: LooseBoundaryValue) {
  const match = String(line || '').match(/^ */);
  return match ? match[0].length : 0;
}

function isStructuralLine(line: LooseBoundaryValue) {
  const trimmed = String(line || '').trim();
  return !!trimmed && !trimmed.startsWith('#');
}

function topLevelKeyIndex(lines: LooseBoundaryValue, key: LooseBoundaryValue) {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  return lines.findIndex((line: LooseBoundaryValue) => re.test(line));
}

function blockEndIndex(lines: LooseBoundaryValue, start: LooseBoundaryValue, parentIndent: LooseBoundaryValue) {
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isStructuralLine(lines[i]) && lineIndent(lines[i]) <= parentIndent) return i;
  }
  return lines.length;
}

function childKeyIndex(
  lines: LooseBoundaryValue,
  start: LooseBoundaryValue,
  end: LooseBoundaryValue,
  key: LooseBoundaryValue,
  minIndent: LooseBoundaryValue,
) {
  const re = new RegExp(`^\\s{${minIndent},}${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  for (let i = start; i < end; i += 1) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

function enabledLineIndex(
  lines: LooseBoundaryValue,
  start: LooseBoundaryValue,
  end: LooseBoundaryValue,
  minIndent: LooseBoundaryValue,
) {
  const re = new RegExp(`^\\s{${minIndent},}enabled\\s*:`);
  for (let i = start; i < end; i += 1) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

function localDesktopEnabledInYaml(text: LooseBoundaryValue) {
  const lines = String(text || '').split(/\r?\n/);
  const platformsIdx = topLevelKeyIndex(lines, 'platforms');
  if (platformsIdx < 0) return false;
  const platformsEnd = blockEndIndex(lines, platformsIdx, 0);
  const platformIdx = childKeyIndex(lines, platformsIdx + 1, platformsEnd, LOCAL_DESKTOP_PLATFORM, 1);
  if (platformIdx < 0) return false;
  const platformIndent = lineIndent(lines[platformIdx]);
  const platformEnd = blockEndIndex(lines, platformIdx, platformIndent);
  const enabledIdx = enabledLineIndex(lines, platformIdx + 1, platformEnd, platformIndent + 1);
  if (enabledIdx < 0) return false;
  return /^\s*enabled\s*:\s*(true|1|yes|on)\s*(?:#.*)?$/i.test(lines[enabledIdx]);
}

function ensureLocalDesktopInYaml(text: LooseBoundaryValue) {
  const original = String(text || '');
  if (localDesktopEnabledInYaml(original)) return original;
  const lines = original.split(/\r?\n/);
  if (lines.length === 1 && !lines[0].trim()) return defaultGatewayConfigYaml();

  const platformsIdx = topLevelKeyIndex(lines, 'platforms');
  if (platformsIdx < 0) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('', 'platforms:', `  ${LOCAL_DESKTOP_PLATFORM}:`, '    enabled: true');
    return `${lines.join('\n')}\n`;
  }

  if (/^platforms\s*:\s*\{\s*\}\s*(?:#.*)?$/.test(lines[platformsIdx])) {
    lines[platformsIdx] = 'platforms:';
  }

  const platformsEnd = blockEndIndex(lines, platformsIdx, 0);
  const platformIdx = childKeyIndex(lines, platformsIdx + 1, platformsEnd, LOCAL_DESKTOP_PLATFORM, 1);
  if (platformIdx < 0) {
    lines.splice(platformsEnd, 0, `  ${LOCAL_DESKTOP_PLATFORM}:`, '    enabled: true');
    return `${lines.join('\n').replace(/\n*$/, '')}\n`;
  }

  const platformIndent = lineIndent(lines[platformIdx]);
  const platformEnd = blockEndIndex(lines, platformIdx, platformIndent);
  const enabledIdx = enabledLineIndex(lines, platformIdx + 1, platformEnd, platformIndent + 1);
  const enabledLine = `${' '.repeat(platformIndent + 2)}enabled: true`;
  if (enabledIdx >= 0) {
    lines[enabledIdx] = enabledLine;
  } else {
    lines.splice(platformIdx + 1, 0, enabledLine);
  }
  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

function ensureGatewayConfigFile(hermesHome = effectiveGatewayHermesHome()) {
  const home = path.resolve(hermesHome);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'config.yaml');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let next = current;
  const trimmed = current.trim();
  if (!trimmed) {
    next = defaultGatewayConfigYaml();
  } else if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      const platforms =
        root.platforms && typeof root.platforms === 'object' && !Array.isArray(root.platforms) ? root.platforms : {};
      const localDesktop =
        platforms[LOCAL_DESKTOP_PLATFORM] && typeof platforms[LOCAL_DESKTOP_PLATFORM] === 'object'
          ? platforms[LOCAL_DESKTOP_PLATFORM]
          : {};
      localDesktop.enabled = true;
      platforms[LOCAL_DESKTOP_PLATFORM] = localDesktop;
      root.platforms = platforms;
      next = `${JSON.stringify(root, null, 2)}\n`;
    } catch {
      next = ensureLocalDesktopInYaml(current);
    }
  } else {
    next = ensureLocalDesktopInYaml(current);
  }
  if (next !== current) {
    fs.writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 });
  }
  return {
    file,
    changed: next !== current,
    localDesktopEnabled: true,
  };
}

function gatewayEnvLineKey(line: LooseBoundaryValue) {
  const match = String(line || '')
    .trim()
    .match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
  return match ? match[1] : '';
}

function upsertGatewayEnvText(current: LooseBoundaryValue, gatewayEnv: LooseBoundaryValue) {
  const values = new Map(LOCAL_DESKTOP_ENV_KEYS.map((key) => [key, String(gatewayEnv[key] || '')]));
  const seen = new Set();
  const input = String(current || '');
  const output = [];

  for (const line of input.split(/\r?\n/)) {
    const key = gatewayEnvLineKey(line);
    if (!values.has(key)) {
      output.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(`${key}=${values.get(key)}`);
  }

  while (output.length && !output[output.length - 1].trim()) output.pop();
  if (!output.length) {
    output.push('# Generated by agent-UI. Shared by the Electron app and Hermes local_desktop gateway.');
  }
  for (const key of LOCAL_DESKTOP_ENV_KEYS) {
    if (!seen.has(key)) output.push(`${key}=${values.get(key)}`);
  }
  return `${output.join('\n')}\n`;
}

function ensureGatewayEnvFile(overrides: GatewayEnvOverrides = {}) {
  const file = defaultGatewayEnvPathForMode();
  const currentText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const current = parseGatewayEnvText(currentText);
  const nextPort = overrides.LOCAL_DESKTOP_PORT || overrides.port || current.LOCAL_DESKTOP_PORT || '8766';
  const nextHost = overrides.LOCAL_DESKTOP_HOST || overrides.host || current.LOCAL_DESKTOP_HOST || '127.0.0.1';
  const merged = {
    LOCAL_DESKTOP_GATEWAY_KEY:
      current.LOCAL_DESKTOP_GATEWAY_KEY || current.AGENT_UI_HERMES_GATEWAY_KEY || randomBytes(32).toString('hex'),
    LOCAL_DESKTOP_ALLOWED_USERS: current.LOCAL_DESKTOP_ALLOWED_USERS || LOCAL_DESKTOP_USER,
    LOCAL_DESKTOP_ALLOW_ALL_USERS: current.LOCAL_DESKTOP_ALLOW_ALL_USERS || 'false',
    LOCAL_DESKTOP_HOST: String(nextHost),
    LOCAL_DESKTOP_PORT: String(nextPort),
    LOCAL_DESKTOP_HOME_CHANNEL: current.LOCAL_DESKTOP_HOME_CHANNEL || LOCAL_DESKTOP_HOME_CHANNEL,
    LOCAL_DESKTOP_HOME_CHANNEL_NAME: current.LOCAL_DESKTOP_HOME_CHANNEL_NAME || LOCAL_DESKTOP_HOME_CHANNEL_NAME,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = upsertGatewayEnvText(currentText, merged);
  if (body !== currentText) {
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  }
  fs.chmodSync(file, 0o600);
  return { file, env: merged };
}

function gatewayBaseUrlForEnv(env: GatewayEnv = {}) {
  const host = String(env.LOCAL_DESKTOP_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const port = String(env.LOCAL_DESKTOP_PORT || '8766').trim() || '8766';
  return `http://${host}:${port}`;
}

function gatewayEnvOverridesFromProcess() {
  const overrides: GatewayEnvOverrides = {};
  const directUrl = String(process.env.AGENT_UI_HERMES_GATEWAY_URL || '').trim();
  if (directUrl) {
    const parsed = parseGatewayBaseUrl(directUrl);
    if (parsed.host) overrides.LOCAL_DESKTOP_HOST = parsed.host;
    if (parsed.port) overrides.LOCAL_DESKTOP_PORT = String(parsed.port);
  }
  if (process.env.LOCAL_DESKTOP_HOST) overrides.LOCAL_DESKTOP_HOST = process.env.LOCAL_DESKTOP_HOST;
  if (process.env.LOCAL_DESKTOP_PORT) overrides.LOCAL_DESKTOP_PORT = process.env.LOCAL_DESKTOP_PORT;
  return overrides;
}

function syncGatewayEnvToProcess(gatewayEnv: GatewayEnv) {
  const baseUrl = gatewayBaseUrlForEnv(gatewayEnv);
  process.env.LOCAL_DESKTOP_GATEWAY_KEY = gatewayEnv.LOCAL_DESKTOP_GATEWAY_KEY;
  process.env.LOCAL_DESKTOP_HOST = gatewayEnv.LOCAL_DESKTOP_HOST;
  process.env.LOCAL_DESKTOP_PORT = gatewayEnv.LOCAL_DESKTOP_PORT;
  process.env.LOCAL_DESKTOP_HOME_CHANNEL = gatewayEnv.LOCAL_DESKTOP_HOME_CHANNEL;
  process.env.LOCAL_DESKTOP_HOME_CHANNEL_NAME = gatewayEnv.LOCAL_DESKTOP_HOME_CHANNEL_NAME;
  process.env.AGENT_UI_HERMES_GATEWAY_URL = baseUrl;
  return baseUrl;
}

async function healthOk(baseUrl: LooseBoundaryValue, timeoutMs = 900) {
  if (!global.fetch) return false;
  try {
    const res = await global.fetch(`${String(baseUrl).replace(/\/+$/, '')}/health`, {
      signal: Number(timeoutMs) > 0 ? AbortSignal.timeout(Number(timeoutMs)) : undefined,
    });
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

async function gatewayAuthOk(baseUrl: LooseBoundaryValue, key: LooseBoundaryValue, timeoutMs = 900) {
  const secret = String(key || '').trim();
  if (!global.fetch || !secret) return false;
  try {
    const url = `${String(baseUrl).replace(/\/+$/, '')}/messages`;
    const res = await global.fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: Number(timeoutMs) > 0 ? AbortSignal.timeout(Number(timeoutMs)) : undefined,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return !!(res && res.status === 400 && body && body.ok === false && body.error === 'missing_conversation_id');
  } catch {
    return false;
  }
}

async function gatewayEventsOk(baseUrl: LooseBoundaryValue, key: LooseBoundaryValue, timeoutMs = 900) {
  const secret = String(key || '').trim();
  if (!global.fetch || !secret) return false;
  const controller = new AbortController();
  const signal =
    Number(timeoutMs) > 0
      ? AbortSignal.any([controller.signal, AbortSignal.timeout(Number(timeoutMs))])
      : controller.signal;
  try {
    const url = `${String(baseUrl).replace(/\/+$/, '')}/events`;
    const res = await global.fetch(url, {
      headers: {
        authorization: `Bearer ${secret}`,
      },
      signal,
    });
    const contentType =
      res && res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : '';
    if (!(res && res.ok && /text\/event-stream/i.test(contentType))) return false;
    if (!res.body || typeof res.body.getReader !== 'function') return false;
    const reader = res.body.getReader();
    const probeMs = Math.min(75, Math.max(25, Math.floor(timeoutMs / 4)));
    const read: Promise<StreamProbeResult> = reader.read().catch(() => ({ error: true }));
    const result = await Promise.race<StreamProbeResult>([read, delay(probeMs, { pending: true })]);
    if (result && result.error) return false;
    if (result && result.done) return false;
    return true;
  } catch {
    return false;
  } finally {
    controller.abort();
  }
}

async function gatewayReadyOk(baseUrl: LooseBoundaryValue, key: LooseBoundaryValue, timeoutMs = 900) {
  const [health, auth, events] = await Promise.all([
    healthOk(baseUrl, timeoutMs),
    gatewayAuthOk(baseUrl, key, timeoutMs),
    gatewayEventsOk(baseUrl, key, timeoutMs),
  ]);
  return health && auth && events;
}

function parseGatewayBaseUrl(baseUrl: LooseBoundaryValue) {
  try {
    const parsed = new URL(String(baseUrl || ''));
    return {
      host: parsed.hostname || '127.0.0.1',
      port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
    };
  } catch {
    return { host: '127.0.0.1', port: 8766 };
  }
}

function portAvailable(host: LooseBoundaryValue, port: LooseBoundaryValue, timeoutMs = 300) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (ok: LooseBoundaryValue) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    server.once('error', () => done(false));
    server.listen({ host, port, exclusive: true }, () => done(true));
  });
}

async function nextAvailableGatewayPort(host: LooseBoundaryValue, preferredPort: LooseBoundaryValue) {
  const start = Math.max(1024, Math.min(65535, Math.trunc(Number(preferredPort) || 8766)));
  for (let port = start; port <= Math.min(65535, start + 100); port += 1) {
    if (await portAvailable(host, port)) return port;
  }
  throw new Error(`No available local Hermes gateway port near ${start}.`);
}

function gatewayAutostartEnabled() {
  return envFlag(GATEWAY_AUTOSTART_ENV, true);
}

function gatewayArgsFor() {
  return ['gateway', 'run', '--replace'];
}

function gatewayStartupWaitBudgetMs() {
  return GATEWAY_READY_ATTEMPTS * GATEWAY_READY_INTERVAL_MS;
}

function gatewayReadyPollDelayMs(attempt: LooseBoundaryValue, readyIntervalMs: LooseBoundaryValue) {
  const interval = Math.max(1, Math.trunc(Number(readyIntervalMs) || GATEWAY_READY_INTERVAL_MS));
  const fastDelay = Math.max(25, Math.min(75, Math.floor(interval / 3) || 25));
  return Math.min(interval, fastDelay * Math.max(1, Math.min(4, Math.trunc(Number(attempt) || 0) + 1)));
}

function childIsAlive(child: LooseBoundaryValue) {
  return !!(child && child.exitCode == null && child.signalCode == null);
}

function waitForChildExit(child: ChildProcess, timeoutMs = 1000) {
  if (!childIsAlive(child)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', finish);
      child.off('error', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
    child.once('error', finish);
  });
}

async function terminateGatewayChild(child: LooseBoundaryValue, log = console, reason = 'replace') {
  if (!childIsAlive(child)) return;
  if (gatewayProcess === child) gatewayProcess = null;
  log.warn('[agent-ui] stopping Hermes gateway process', { pid: child.pid || null, reason });
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  await waitForChildExit(child);
}

function appendOutputTail(current: LooseBoundaryValue, chunk: LooseBoundaryValue) {
  return `${current}${String(chunk || '')}`.slice(-GATEWAY_OUTPUT_TAIL_CHARS);
}

function gatewayStartupFailureMessage(
  baseUrl: LooseBoundaryValue,
  childExit: LooseBoundaryValue,
  stdoutTail: LooseBoundaryValue,
  stderrTail: LooseBoundaryValue,
) {
  const parts = [`Hermes gateway did not become ready at ${baseUrl}.`];
  if (childExit) {
    parts.push(
      `Process exited with code ${childExit.code == null ? 'unknown' : childExit.code}${childExit.signal ? ` (${childExit.signal})` : ''}.`,
    );
  }
  const stderr = String(stderrTail || '').trim();
  const stdout = String(stdoutTail || '').trim();
  if (stderr) parts.push(`Last stderr: ${stderr}`);
  if (!stderr && stdout) parts.push(`Last stdout: ${stdout}`);
  return parts.join(' ');
}

function missingHermesExecutableMessage(resolved: MutableJsonObject = {}) {
  const command = String(resolved.command || '').trim();
  if (command)
    return `Hermes executable is missing or not executable at ${command}. Check AGENT_UI_HERMES_BIN or rebuild Hermes.`;
  return 'Hermes executable is missing. Set AGENT_UI_HERMES_BIN or install Hermes in ~/Documents/hermes/hermes-agent.';
}

async function ensureGatewayProcess(log = console, opts: GatewayReadyOptions = {}) {
  const readyAttempts = Math.max(1, Math.trunc(Number(opts.readyAttempts) || GATEWAY_READY_ATTEMPTS));
  const readyIntervalMs = Math.max(1, Math.trunc(Number(opts.readyIntervalMs) || GATEWAY_READY_INTERVAL_MS));
  const readyRequestTimeoutMs = Math.max(
    1,
    Math.trunc(Number(opts.readyRequestTimeoutMs) || GATEWAY_READY_REQUEST_TIMEOUT_MS),
  );
  if (!gatewayAutostartEnabled()) return { ok: false, skipped: true, reason: 'autostart disabled' };
  let { env: gatewayEnv } = ensureGatewayEnvFile(gatewayEnvOverridesFromProcess());
  let baseUrl = syncGatewayEnvToProcess(gatewayEnv);
  let portRotation: MutableJsonObject = {};
  const hermesHome = effectiveGatewayHermesHome();
  const endpoint = parseGatewayBaseUrl(baseUrl);
  const preferredPortAvailable = await portAvailable(endpoint.host, endpoint.port);
  if (
    !preferredPortAvailable &&
    (await gatewayReadyOk(baseUrl, gatewayEnv.LOCAL_DESKTOP_GATEWAY_KEY, GATEWAY_OCCUPIED_PORT_PREFLIGHT_TIMEOUT_MS))
  ) {
    return { ok: true, alreadyRunning: true, baseUrl };
  }

  if (!preferredPortAvailable) {
    const previousBaseUrl = baseUrl;
    const replacementPort = await nextAvailableGatewayPort(endpoint.host, endpoint.port + 1);
    ({ env: gatewayEnv } = ensureGatewayEnvFile({
      LOCAL_DESKTOP_HOST: endpoint.host,
      LOCAL_DESKTOP_PORT: String(replacementPort),
    }));
    baseUrl = syncGatewayEnvToProcess(gatewayEnv);
    portRotation = {
      portRotated: true,
      previousBaseUrl,
      baseUrl,
      reason: 'preferred-port-occupied',
    };
    log.warn('[agent-ui] Hermes gateway port was occupied; using dedicated Agent UI gateway', portRotation);
  }

  ensureGatewayConfigFile(hermesHome);
  if (gatewayStartPromise) return gatewayStartPromise;
  if (childIsAlive(gatewayProcess)) {
    if (await gatewayReadyOk(baseUrl, gatewayEnv.LOCAL_DESKTOP_GATEWAY_KEY, readyRequestTimeoutMs)) {
      return { ok: true, alreadyRunning: true, baseUrl, pid: gatewayProcess.pid || null, ...portRotation };
    }
    await terminateGatewayChild(gatewayProcess, log, 'unready');
  }

  gatewayStartPromise = (async () => {
    const resolved = resolveHermesCommand();
    const { command } = resolved;
    if (!command || !executableExists(command)) {
      return { ok: false, error: missingHermesExecutableMessage(resolved), ...portRotation };
    }
    fs.mkdirSync(hermesHome, { recursive: true });
    const env = {
      ...process.env,
      ...gatewayEnv,
      HERMES_HOME: hermesHome,
      HERMES_BUNDLED_PLUGINS: localDesktopPluginRoot(),
      HOME: realUserHomeDir(),
      PATH: safeRuntimePath(),
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
    };
    const child = spawn(command, gatewayArgsFor(), {
      cwd: hermesCwd(command),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gatewayProcess = child;
    let stdoutTail = '';
    let stderrTail = '';
    let childExit = null;
    child.stdout.on('data', (chunk: LooseBoundaryValue) => {
      stdoutTail = appendOutputTail(stdoutTail, chunk);
      log.log('[agent-ui] Hermes gateway:', String(chunk).trim());
    });
    child.stderr.on('data', (chunk: LooseBoundaryValue) => {
      stderrTail = appendOutputTail(stderrTail, chunk);
      log.warn('[agent-ui] Hermes gateway:', String(chunk).trim());
    });
    child.once('exit', (code: LooseBoundaryValue, signal: LooseBoundaryValue) => {
      childExit = { code, signal };
      if (gatewayProcess === child) gatewayProcess = null;
      log.warn('[agent-ui] Hermes gateway exited', { code, signal });
    });
    child.once('error', (error: LooseBoundaryValue) => {
      if (gatewayProcess === child) gatewayProcess = null;
      log.warn('[agent-ui] Hermes gateway launch failed', error && error.message ? error.message : error);
    });

    for (let i = 0; i < readyAttempts; i += 1) {
      if (await gatewayReadyOk(baseUrl, gatewayEnv.LOCAL_DESKTOP_GATEWAY_KEY, readyRequestTimeoutMs)) {
        return { ok: true, started: true, baseUrl, pid: child.pid || null, ...portRotation };
      }
      if (childExit) break;
      await delay(gatewayReadyPollDelayMs(i, readyIntervalMs));
    }
    if (childIsAlive(child)) {
      await terminateGatewayChild(child, log, 'startup-timeout');
    }
    return {
      ok: false,
      error: gatewayStartupFailureMessage(baseUrl, childExit, stdoutTail, stderrTail),
      pid: child.pid || null,
      ...portRotation,
    };
  })();
  try {
    return await gatewayStartPromise;
  } finally {
    gatewayStartPromise = null;
  }
}

function stopGatewayProcess() {
  const child: LooseBoundaryValue = gatewayProcess;
  gatewayProcess = null;
  if (!childIsAlive(child)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
}

export {
  defaultHermesHome,
  effectiveGatewayHermesHome,
  ensureGatewayEnvFile,
  ensureGatewayConfigFile,
  ensureGatewayProcess,
  execFileText,
  executableExists,
  gatewayAuthOk,
  gatewayEventsOk,
  gatewayReadyOk,
  gatewayReadyPollDelayMs,
  gatewayArgsFor,
  gatewayStartupWaitBudgetMs,
  hermesCwd,
  nextAvailableGatewayPort,
  parseTranscriptionJson,
  portAvailable,
  resolveHermesCommand,
  safeRuntimePath,
  stopGatewayProcess,
  captureAndTranscribeVoice,
  formatVoiceCaptureErrorForUser,
};
