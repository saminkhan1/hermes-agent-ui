'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { randomBytes } = require('crypto');
const {
  defaultGatewayEnvPath,
  gatewayBaseUrlFromEnv,
  readGatewayEnvFile,
  realUserHomeDir,
} = require('./hermes-gateway-client');

const CLI_BIN_ENV = 'AGENT_UI_HERMES_BIN';
const HERMES_HOME_ENV = 'AGENT_UI_HERMES_HOME';
const GATEWAY_AUTOSTART_ENV = 'AGENT_UI_HERMES_GATEWAY_AUTOSTART';
const LOCAL_DESKTOP_USER = 'local';
const LOCAL_DESKTOP_PLATFORM = 'local_desktop';
const SAFE_RUNTIME_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

let gatewayProcess = null;
let gatewayStartPromise = null;

function executableExists(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function execFileText(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 5000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function execFileTextWithJsonEvents(command, args, opts = {}, onJsonLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    const timeoutMs = Number(opts.timeout || 0);
    const timer = timeoutMs > 0 ? setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs) : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
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
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
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
      if (code !== 0) {
        const err = new Error(`Process exited with code ${code}${signal ? ` (${signal})` : ''}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function packageRootFromMainDir(mainDir = __dirname) {
  return path.resolve(mainDir, '..', '..');
}

function bundledHermesCommand() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'hermes-runtime', 'bin', 'hermes'));
  }
  candidates.push(path.join(packageRootFromMainDir(), 'build', 'hermes-runtime', 'bin', 'hermes'));
  for (const candidate of candidates) {
    if (executableExists(candidate)) return candidate;
  }
  return '';
}

function resolveHermesCommand() {
  const configured = String(process.env[CLI_BIN_ENV] || '').trim();
  const candidates = [configured, bundledHermesCommand()].filter(Boolean);
  const requested = candidates[0] || '';
  return {
    command: requested ? (path.isAbsolute(requested) ? requested : path.resolve(process.cwd(), requested)) : '',
    configured: !!configured,
    bundled: !!requested && requested === bundledHermesCommand(),
  };
}

function hermesCwd(command) {
  const bundled = bundledHermesCommand();
  if (bundled && command === bundled) return path.dirname(path.dirname(bundled));
  return process.cwd();
}

function bundledHermesRootForCommand(command) {
  const resolved = path.resolve(String(command || ''));
  const binDir = path.dirname(resolved);
  const root = path.dirname(binDir);
  if (path.basename(resolved) !== 'hermes') return '';
  if (path.basename(binDir) !== 'bin') return '';
  if (!fs.existsSync(path.join(root, 'hermes-agent', 'tools', 'voice_mode.py'))) return '';
  return root;
}

async function bundledHermesRuntimeForCommand(command, opts = {}) {
  const root = bundledHermesRootForCommand(command);
  if (!root) return null;
  const python = await bundledHermesPython(command, opts);
  if (!python) return null;
  const agentRoot = path.join(root, 'hermes-agent');
  return {
    agentRoot,
    hermesHome: defaultHermesHome(),
    projectRoot: agentRoot,
    python,
  };
}

async function hermesPythonRuntimeForCommand(command, opts = {}) {
  return await bundledHermesRuntimeForCommand(command, opts);
}

function parseTranscriptionJson(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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

async function bundledHermesPython(command, _opts = {}) {
  const root = bundledHermesRootForCommand(command);
  if (!root) return '';
  const python = path.join(root, 'python', 'bin', 'python3');
  if (executableExists(python) && await bundledVoiceDependenciesAvailable(python)) return python;
  return '';
}

async function bundledVoiceDependenciesAvailable(python) {
  if (!executableExists(python)) return false;
  try {
    const stdout = await execFileText(python, ['-c', [
      'import importlib.util, json',
      'missing = [name for name in ("sounddevice", "numpy", "faster_whisper") if importlib.util.find_spec(name) is None]',
      'print(json.dumps({"ok": not missing, "missing": missing}))',
    ].join('\n')], { timeout: 10000 });
    const result = parseTranscriptionJson(stdout);
    return !!(result && result.ok);
  } catch {
    return false;
  }
}

function formatVoiceCaptureErrorForUser(value) {
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

async function captureAndTranscribeVoice(opts = {}) {
  const { command } = resolveHermesCommand();
  if (!command || !executableExists(command)) {
    return { ok: false, error: 'Hermes executable is missing. Bundle Hermes with npm run bundle:hermes or set AGENT_UI_HERMES_BIN.' };
  }
  try {
    const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
    const runtime = await hermesPythonRuntimeForCommand(command, opts);
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
      '    requirements = check_voice_requirements()',
      '    if not requirements.get("available"):',
      '        raise RuntimeError(requirements.get("details") or "Hermes voice mode requirements are not available.")',
      '    silence_threshold = int(cfg.get("silence_threshold", 200))',
      '    silence_duration = float(cfg.get("silence_duration", 3.0))',
      '    max_recording_seconds = float(cfg.get("max_recording_seconds", 120))',
      '    beep_enabled = bool(cfg.get("beep_enabled", True))',
      '    stopped = threading.Event()',
      '    recorder = create_audio_recorder()',
      '    if hasattr(recorder, "_silence_threshold"):',
      '        recorder._silence_threshold = silence_threshold',
      '    if hasattr(recorder, "_silence_duration"):',
      '        recorder._silence_duration = silence_duration',
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
      '        print(json.dumps({"status": "transcribing"}), flush=True)',
      '        result = transcribe_recording(audio_path)',
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
    const stdout = await execFileTextWithJsonEvents(runtime.python, ['-c', code], {
      cwd: runtime.agentRoot,
      env: {
        ...process.env,
        HOME: realUserHomeDir(),
        HERMES_HOME: runtime.hermesHome,
        PATH: SAFE_RUNTIME_PATH,
        PYTHONNOUSERSITE: '1',
        PYTHONPATH: runtime.agentRoot,
        AGENT_UI_HERMES_PROJECT_ROOT: runtime.projectRoot,
      },
      timeout: opts.timeoutMs || 180000,
    }, (event) => {
      if (onStatus && event.status) onStatus(String(event.status));
    });
    const result = parseTranscriptionJson(stdout);
    if (!result) return { ok: false, error: 'Hermes returned no voice result.' };
    const transcript = String(result.transcript || '').trim();
    if (!result.success || !transcript) {
      return { ok: false, error: formatVoiceCaptureErrorForUser(result.error || 'No speech was detected.') };
    }
    return {
      ok: true,
      transcript,
      provider: result.provider || result.model || null,
      raw: result,
    };
  } catch (e) {
    return { ok: false, error: formatVoiceCaptureErrorForUser((e && (e.stderr || e.message)) || String(e)) };
  }
}

function defaultHermesHome() {
  const configured = String(process.env[HERMES_HOME_ENV] || '').trim();
  return configured ? path.resolve(configured) : path.join(realUserHomeDir(), '.agent-ui', 'hermes-home');
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

function lineIndent(line) {
  const match = String(line || '').match(/^ */);
  return match ? match[0].length : 0;
}

function isStructuralLine(line) {
  const trimmed = String(line || '').trim();
  return !!trimmed && !trimmed.startsWith('#');
}

function topLevelKeyIndex(lines, key) {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  return lines.findIndex((line) => re.test(line));
}

function blockEndIndex(lines, start, parentIndent) {
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isStructuralLine(lines[i]) && lineIndent(lines[i]) <= parentIndent) return i;
  }
  return lines.length;
}

function childKeyIndex(lines, start, end, key, minIndent) {
  const re = new RegExp(`^\\s{${minIndent},}${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  for (let i = start; i < end; i += 1) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

function enabledLineIndex(lines, start, end, minIndent) {
  const re = new RegExp(`^\\s{${minIndent},}enabled\\s*:`);
  for (let i = start; i < end; i += 1) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

function localDesktopEnabledInYaml(text) {
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

function ensureLocalDesktopInYaml(text) {
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
  ensureDir(home);
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
      const platforms = root.platforms && typeof root.platforms === 'object' && !Array.isArray(root.platforms)
        ? root.platforms
        : {};
      const localDesktop = platforms[LOCAL_DESKTOP_PLATFORM] && typeof platforms[LOCAL_DESKTOP_PLATFORM] === 'object'
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

function ensureGatewayEnvFile(overrides = {}) {
  const file = defaultGatewayEnvPath();
  const current = readGatewayEnvFile(file);
  const nextPort = overrides.LOCAL_DESKTOP_PORT || overrides.port || current.LOCAL_DESKTOP_PORT || '8766';
  const merged = {
    LOCAL_DESKTOP_GATEWAY_KEY: current.LOCAL_DESKTOP_GATEWAY_KEY || current.AGENT_UI_HERMES_GATEWAY_KEY || randomBytes(32).toString('hex'),
    LOCAL_DESKTOP_ALLOWED_USERS: current.LOCAL_DESKTOP_ALLOWED_USERS || LOCAL_DESKTOP_USER,
    LOCAL_DESKTOP_ALLOW_ALL_USERS: current.LOCAL_DESKTOP_ALLOW_ALL_USERS || 'false',
    LOCAL_DESKTOP_HOST: current.LOCAL_DESKTOP_HOST || '127.0.0.1',
    LOCAL_DESKTOP_PORT: String(nextPort),
    AGENT_UI_HERMES_GATEWAY_URL: current.AGENT_UI_HERMES_GATEWAY_URL || '',
  };
  ensureDir(path.dirname(file));
  const body = [
    '# Generated by agent-UI. Shared by the Electron app and Hermes local_desktop gateway.',
    `LOCAL_DESKTOP_GATEWAY_KEY=${merged.LOCAL_DESKTOP_GATEWAY_KEY}`,
    `LOCAL_DESKTOP_ALLOWED_USERS=${merged.LOCAL_DESKTOP_ALLOWED_USERS}`,
    `LOCAL_DESKTOP_ALLOW_ALL_USERS=${merged.LOCAL_DESKTOP_ALLOW_ALL_USERS}`,
    `LOCAL_DESKTOP_HOST=${merged.LOCAL_DESKTOP_HOST}`,
    `LOCAL_DESKTOP_PORT=${merged.LOCAL_DESKTOP_PORT}`,
    merged.AGENT_UI_HERMES_GATEWAY_URL ? `AGENT_UI_HERMES_GATEWAY_URL=${merged.AGENT_UI_HERMES_GATEWAY_URL}` : '',
    '',
  ].filter((line) => line !== '').join('\n');
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  return { file, env: merged };
}

async function healthOk(baseUrl, timeoutMs = 900) {
  if (!global.fetch) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await global.fetch(`${String(baseUrl).replace(/\/+$/, '')}/health`, { signal: controller.signal });
    return !!(res && res.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function gatewayAuthOk(baseUrl, key, timeoutMs = 900) {
  const secret = String(key || '').trim();
  if (!global.fetch || !secret) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${String(baseUrl).replace(/\/+$/, '')}/messages`;
    const res = await global.fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return !!(
      res &&
      res.status === 400 &&
      body &&
      body.ok === false &&
      body.error === 'missing_conversation_id'
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function gatewayReadyOk(baseUrl, key, timeoutMs = 900) {
  return await healthOk(baseUrl, timeoutMs) && await gatewayAuthOk(baseUrl, key, timeoutMs);
}

function parseGatewayBaseUrl(baseUrl) {
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

function portAvailable(host, port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (ok) => {
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

async function nextAvailableGatewayPort(host, preferredPort) {
  const start = Math.max(1024, Math.min(65535, Math.trunc(Number(preferredPort) || 8766)));
  for (let port = start; port <= Math.min(65535, start + 100); port += 1) {
    if (await portAvailable(host, port)) return port;
  }
  throw new Error(`No available local Hermes gateway port near ${start}.`);
}

function gatewayAutostartEnabled() {
  const raw = String(process.env[GATEWAY_AUTOSTART_ENV] || '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

function gatewayArgsFor(command) {
  return ['gateway', 'run', '--replace'];
}

async function ensureGatewayProcess(log = console) {
  if (!gatewayAutostartEnabled()) return { ok: false, skipped: true, reason: 'autostart disabled' };
  let { env: gatewayEnv } = ensureGatewayEnvFile();
  let baseUrl = gatewayBaseUrlFromEnv();
  const hermesHome = effectiveGatewayHermesHome();
  if (await gatewayReadyOk(baseUrl, gatewayEnv.LOCAL_DESKTOP_GATEWAY_KEY)) {
    return { ok: true, alreadyRunning: true, baseUrl };
  }

  const endpoint = parseGatewayBaseUrl(baseUrl);
  if (!await portAvailable(endpoint.host, endpoint.port)) {
    const replacementPort = await nextAvailableGatewayPort(endpoint.host, endpoint.port + 1);
    ({ env: gatewayEnv } = ensureGatewayEnvFile({ LOCAL_DESKTOP_PORT: String(replacementPort) }));
    baseUrl = gatewayBaseUrlFromEnv();
    log.warn('[agent-ui] Hermes gateway port was occupied; using', baseUrl);
  }

  ensureGatewayConfigFile(hermesHome);
  if (gatewayProcess && !gatewayProcess.killed) return { ok: true, starting: true, baseUrl };
  if (gatewayStartPromise) return gatewayStartPromise;

  gatewayStartPromise = (async () => {
    const { command } = resolveHermesCommand();
    if (!command || !executableExists(command)) {
      return { ok: false, error: 'Hermes executable is missing. Bundle Hermes with npm run bundle:hermes or set AGENT_UI_HERMES_BIN.' };
    }
    ensureDir(hermesHome);
    const env = {
      ...process.env,
      ...gatewayEnv,
      HERMES_HOME: hermesHome,
      HOME: realUserHomeDir(),
      PATH: SAFE_RUNTIME_PATH,
      PYTHONNOUSERSITE: '1',
    };
    const child = spawn(command, gatewayArgsFor(command), {
      cwd: hermesCwd(command),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gatewayProcess = child;
    child.stdout.on('data', (chunk) => log.log('[agent-ui] Hermes gateway:', String(chunk).trim()));
    child.stderr.on('data', (chunk) => log.warn('[agent-ui] Hermes gateway:', String(chunk).trim()));
    child.once('exit', (code, signal) => {
      if (gatewayProcess === child) gatewayProcess = null;
      log.warn('[agent-ui] Hermes gateway exited', { code, signal });
    });
    child.once('error', (error) => {
      if (gatewayProcess === child) gatewayProcess = null;
      log.warn('[agent-ui] Hermes gateway launch failed', error && error.message ? error.message : error);
    });

    for (let i = 0; i < 20; i += 1) {
      if (await gatewayReadyOk(baseUrl, gatewayEnv.LOCAL_DESKTOP_GATEWAY_KEY, 500)) {
        return { ok: true, started: true, baseUrl, pid: child.pid || null };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, error: `Hermes gateway did not become ready at ${baseUrl}.`, pid: child.pid || null };
  })();
  try {
    return await gatewayStartPromise;
  } finally {
    gatewayStartPromise = null;
  }
}

function stopGatewayProcess() {
  const child = gatewayProcess;
  gatewayProcess = null;
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
}

module.exports = {
  defaultHermesHome,
  effectiveGatewayHermesHome,
  ensureGatewayEnvFile,
  ensureGatewayConfigFile,
  ensureGatewayProcess,
  executableExists,
  gatewayAuthOk,
  gatewayReadyOk,
  gatewayArgsFor,
  hermesCwd,
  nextAvailableGatewayPort,
  parseTranscriptionJson,
  portAvailable,
  resolveHermesCommand,
  stopGatewayProcess,
  captureAndTranscribeVoice,
  formatVoiceCaptureErrorForUser,
};
