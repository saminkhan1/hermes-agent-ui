#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const EVAL_DIR = path.join(ROOT, '.agent-ui-eval');
const RUN_ID = process.env.AGENT_UI_EVAL_RUN_ID || `agent-UI-E2E-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const RUN_DIR = path.join(EVAL_DIR, 'runs', RUN_ID);
const CONFIG_DIR = path.join(RUN_DIR, 'config');
const WORKSPACE_DIR = path.join(RUN_DIR, 'workspace');
const TRANSCRIPT_FILE = path.join(RUN_DIR, 'voice-transcript.txt');
const PORT_FILE = path.join(RUN_DIR, 'eval-port.txt');
const INPUT = path.join(__dirname, 'swift', 'HumanInput.swift');
const DEFAULT_HERMES = path.join(os.homedir(), 'Documents', 'jarvis', '.aura', 'hermes-agent', '.venv', 'bin', 'hermes');
const HERMES_REQUESTED = process.env.AGENT_UI_HERMES_BIN || DEFAULT_HERMES;
const HERMES = resolveHermesBin(HERMES_REQUESTED) || HERMES_REQUESTED;
const REQUIRED_APPS = {
  'Google Chrome': 'com.google.Chrome',
  Preview: 'com.apple.Preview',
  Mail: 'com.apple.mail',
  Notes: 'com.apple.Notes',
  Reminders: 'com.apple.reminders',
  Obsidian: 'md.obsidian',
  Anki: 'net.ankiweb.launcher',
  GarageBand: 'com.apple.garageband10',
};
const SCENARIO_TIMEOUT_MS = Number(process.env.AGENT_UI_E2E_SCENARIO_TIMEOUT_MS || 600000);
const START_STAGGER_MS = Number(process.env.AGENT_UI_E2E_START_STAGGER_MS || 5000);
const RUN_MODE = String(process.env.AGENT_UI_E2E_MODE || 'serial').trim().toLowerCase();
const RUN_CONCURRENT = RUN_MODE === 'concurrent' || RUN_MODE === 'stress';
const SELECTED = new Set(
  String(process.env.AGENT_UI_E2E_SCENARIOS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
);
const DISPOSABLE_PREFIX = 'agent-UI E2E';
const DISPOSABLE_FILE_PREFIX = 'agent-UI-E2E';
const EVAL_PATH_NEEDLE = '.agent-ui-eval';
const LEGACY_PREVIEW_FIXTURE_NAMES = ['quarterly-risk-report.pdf', 'study-companion.pdf'];

function execFileP(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 30000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const idx = Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1);
  return xs[idx];
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}

function writeJson(file, value) {
  writeFile(file, JSON.stringify(value, null, 2));
}

function appleScriptString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function appleScriptList(values) {
  return `{${values.map(appleScriptString).join(', ')}}`;
}

function disposableName(...parts) {
  return [DISPOSABLE_PREFIX, RUN_ID, ...parts]
    .filter((part) => part != null && String(part).trim())
    .join(' ');
}

function disposableFile(dir, name) {
  return path.join(dir, `${DISPOSABLE_FILE_PREFIX}-${name}`);
}

function makeScenarioContext(scenario, dir) {
  return {
    dir,
    label: disposableName(scenario.name),
    name: (...parts) => disposableName(scenario.name, ...parts),
    file: (name) => disposableFile(dir, `${scenario.name}-${name}`),
  };
}

function promptForScenario(scenario) {
  return scenario.mode === 'voice' ? (scenario.transcript || scenario.prompt || '') : scenario.prompt;
}

function hermesCandidatesFromDir(dir) {
  return [
    path.join(dir, 'hermes'),
    path.join(dir, '.venv', 'bin', 'hermes'),
    path.join(dir, '.aura', 'hermes-agent', '.venv', 'bin', 'hermes'),
    path.join(dir, 'hermes-agent', '.venv', 'bin', 'hermes'),
  ];
}

function resolveHermesBin(value) {
  const requested = String(value || '').trim();
  if (!requested) return null;
  const hasPath = requested.includes('/') || requested.includes('\\');
  if (hasPath) {
    const abs = path.isAbsolute(requested) ? requested : path.resolve(process.cwd(), requested);
    try {
      if (fs.statSync(abs).isDirectory()) return hermesCandidatesFromDir(abs).find(isExecutable) || null;
    } catch {
      /* ignore */
    }
    return isExecutable(abs) ? abs : null;
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, requested);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function osascript(script) {
  return (await execFileP('osascript', ['-e', script], { timeout: 15000 })).stdout.trim();
}

async function applicationIsRunning(appName) {
  const out = await osascript(`tell application "System Events" to return exists application process ${appleScriptString(appName)}`).catch(() => 'false');
  return String(out).trim().toLowerCase() === 'true';
}

let inputBinPromise = null;

async function getInputBin() {
  if (process.env.AGENT_UI_E2E_USE_SWIFTC === '0') return { command: '/usr/bin/swift', prefix: [INPUT] };
  const bin = path.join(RUN_DIR, 'HumanInput');
  if (fs.existsSync(bin)) return { command: bin, prefix: [] };
  if (!inputBinPromise) {
    inputBinPromise = execFileP('/usr/bin/swiftc', ['-O', INPUT, '-o', bin], { timeout: 60000 }).then(() => ({ command: bin, prefix: [] }));
  }
  return inputBinPromise;
}

async function input(...args) {
  const bin = await getInputBin();
  await execFileP(bin.command, [...bin.prefix, ...args], { timeout: 60000 });
}

function request(port, method, pathname, body) {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : undefined,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(text || '{}'));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function center(rect) {
  return {
    x: Math.round((rect.left + rect.right) / 2),
    y: Math.round((rect.top + rect.bottom) / 2),
  };
}

async function waitFor(port, fn, timeoutMs = 30000, intervalMs = 100) {
  const start = Date.now();
  let last;
  while (Date.now() - start <= timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for condition: ${JSON.stringify(last)}`);
}

async function waitForPort() {
  await waitFor(0, () => fs.existsSync(PORT_FILE), 30000, 100);
  return Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
}

async function waitForModal(port, timeoutMs = 10000) {
  return waitFor(port, async () => {
    const targets = await request(port, 'GET', '/ui-targets');
    return targets.modal && targets.modal.visible && targets.modal.promptRect ? targets : null;
  }, timeoutMs, 75);
}

async function pressNewCatShortcut(port, appPid) {
  await input('hotkey', 'cmd+shift+c');
  try {
    return await waitForModal(port, 1000);
  } catch {
    await osascript('tell application "System Events" to key code 8 using {command down, shift down}');
    try {
      return await waitForModal(port, 1500);
    } catch {
      await osascript('tell application "System Events" to keystroke "c" using {command down, shift down}');
      try {
        return await waitForModal(port, 1500);
      } catch {
        for (const appName of ['agent-UI', 'agent-ui', 'Electron']) {
          await osascript(`tell application "${appName}" to activate`).catch(() => {});
          await sleep(250);
          await osascript('tell application "System Events" to key code 8 using {command down, shift down}').catch(() => {});
          try {
            return await waitForModal(port, 1500);
          } catch {
            /* try next app name */
          }
        }
        if (appPid) {
          await input('activate-pid', String(appPid)).catch(() => {});
          await input('hotkey-pid', String(appPid), 'cmd+shift+c').catch(() => {});
          try {
            return await waitForModal(port, 1500);
          } catch {
            /* try frontmost/app menu paths */
          }
          await osascript(`tell application "System Events" to set frontmost of first process whose unix id is ${Number(appPid)} to true`).catch(() => {});
          await sleep(250);
          await osascript('tell application "System Events" to key code 8 using {command down, shift down}').catch(() => {});
          try {
            return await waitForModal(port, 1500);
          } catch {
            await osascript(`
              tell application "System Events"
                tell (first process whose unix id is ${Number(appPid)})
                  click menu item "New Cat" of menu 1 of menu bar item 1 of menu bar 1
                end tell
              end tell
            `).catch(() => {});
            try {
              return await waitForModal(port, 1500);
            } catch {
              /* fall through to final wait */
            }
          }
        }
        return waitForModal(port, 10000);
      }
    }
  }
}

async function waitForNewCat(port, beforeIds) {
  return waitFor(port, async () => {
    const data = await request(port, 'GET', '/conversations');
    const found = (data.conversations || []).find((c) => !beforeIds.has(String(c.catId)));
    return found ? String(found.catId) : null;
  }, 30000, 200);
}

async function waitForCatVisible(port, catId) {
  const start = Date.now();
  await waitFor(port, async () => {
    const targets = await request(port, 'GET', '/ui-targets');
    const cats = targets.cats || [];
    if (!catId) return cats.length > 0 ? targets : null;
    return cats.some((cat) => String(cat.catId || '') === String(catId)) ? targets : null;
  }, 30000, 75);
  return Date.now() - start;
}

async function openConversationFromVisibleCat(port, catId) {
  const data = await waitFor(port, async () => {
    const targets = await request(port, 'GET', '/ui-targets');
    const cat = (targets.cats || []).find((c) => String(c.catId || '') === String(catId));
    return cat ? { targets, cat } : null;
  }, 30000, 75);
  const point = center(data.cat);
  await input('click', String(point.x), String(point.y));
  return waitFor(port, async () => {
    const targets = await request(port, 'GET', '/ui-targets');
    const convo = targets.conversation || {};
    const hasText = Number(convo.visibleTextLength || 0) > 0 || String(convo.visibleTextPreview || '').length > 0;
    const hasLines = Array.isArray(convo.lineEntries) && convo.lineEntries.length > 0;
    return convo.visible && hasText && hasLines ? targets : null;
  }, 15000, 100);
}

async function closeModalIfOpen(port) {
  await request(port, 'POST', '/close-modal', {}).catch(() => {});
  await sleep(250);
}

async function waitForSelectedFolder(port, folder) {
  return waitFor(port, async () => {
    const targets = await request(port, 'GET', '/ui-targets');
    return targets.modal && targets.modal.selectedFolderPath === folder ? targets : null;
  }, 10000, 100);
}

async function waitForPromptLength(port, expectedMin, timeoutMs = 10000) {
  return waitFor(port, async () => {
    const targets = await request(port, 'GET', '/ui-targets');
    return targets.modal && Number(targets.modal.promptValueLength || 0) >= expectedMin ? targets : null;
  }, timeoutMs, 100);
}

async function clearPromptField(modalPid, promptPoint) {
  await input('activate-pid', String(modalPid)).catch(() => {});
  await input('click', String(promptPoint.x), String(promptPoint.y)).catch(() => {});
  await input('hotkey-pid', String(modalPid), 'cmd+a').catch(() => {});
  await input('key-pid', String(modalPid), 'delete').catch(() => {});
  await sleep(100);
}

async function typePromptText(port, appPid, modalPid, promptPoint, text) {
  const expected = String(text || '').length;
  const pid = Number(modalPid || appPid);
  const attempts = [
    {
      name: 'click-type',
      run: async () => {
        await input('click-type', String(promptPoint.x), String(promptPoint.y), text);
      },
    },
    {
      name: 'combined-replace-global-hid',
      run: async () => {
        await input('replace-text', String(appPid), String(promptPoint.x), String(promptPoint.y), text);
      },
    },
    {
      name: 'global-hid',
      run: async () => {
        await input('activate-pid', String(appPid)).catch(() => {});
        await clearPromptField(pid, promptPoint);
        await input('type', text);
      },
    },
    {
      name: 'pid-targeted',
      run: async () => {
        await clearPromptField(pid, promptPoint);
        await input('type-pid', String(pid), text);
      },
    },
    {
      name: 'activated-pid-targeted',
      run: async () => {
        await input('activate-pid', String(appPid)).catch(() => {});
        await clearPromptField(pid, promptPoint);
        await input('type-pid', String(pid), text);
      },
    },
    {
      name: 'osascript-keystroke',
      run: async () => {
        await input('activate-pid', String(appPid)).catch(() => {});
        await input('click', String(promptPoint.x), String(promptPoint.y)).catch(() => {});
        await osascript(`tell application "System Events" to keystroke ${appleScriptString(text)}`);
      },
    },
  ];

  let lastError = null;
  const diagnostics = [];
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const started = Date.now();
    try {
      await attempt.run();
      await waitForPromptLength(port, expected, i === attempts.length - 1 ? 10000 : 1500);
      return { attempt: attempt.name, attempts: [...diagnostics, { name: attempt.name, ok: true, ms: Date.now() - started }] };
    } catch (e) {
      lastError = e;
      diagnostics.push({ name: attempt.name, ok: false, ms: Date.now() - started, error: (e && e.message) || String(e) });
    }
  }
  const err = lastError || new Error('Prompt field did not receive typed text');
  err.typeAttempts = diagnostics;
  throw err;
}

async function waitForTraceEvent(port, type, timeoutMs = 15000) {
  return waitFor(port, async () => {
    const trace = await request(port, 'GET', '/trace');
    const matches = (trace.events || []).filter((event) => event && event.type === type);
    return matches.length ? matches[matches.length - 1] : null;
  }, timeoutMs, 100);
}

function minimalPdf(title, lines) {
  const body = [title, '', ...lines].join('\\n').replace(/[()]/g, '');
  return `%PDF-1.3
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length ${body.length + 48} >>
stream
BT /F1 14 Tf 72 720 Td (${body}) Tj ET
endstream
endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000059 00000 n 
0000000116 00000 n 
0000000241 00000 n 
0000000311 00000 n 
trailer
<< /Root 1 0 R /Size 6 >>
startxref
${420 + body.length}
%%EOF
`;
}

function seedRecentFolder(folder) {
  ensureDir(CONFIG_DIR);
  writeJson(path.join(CONFIG_DIR, 'recent_folders.json'), [folder]);
}

async function openApp(app, target) {
  const args = ['-a', app];
  if (target) args.push(target);
  await execFileP('open', args, { timeout: 10000 });
  await sleep(1000);
}

async function focusApp(app) {
  await osascript(`tell application ${appleScriptString(app)} to activate`).catch(() => {});
  await sleep(750);
}

async function closeOpenTarget(app, target) {
  if (!target) return;
  if (app === 'Preview') {
    if (!(await applicationIsRunning('Preview'))) return;
    const targetPath = appleScriptString(target);
    const targetName = appleScriptString(path.basename(target));
    await osascript(`
      tell application "Preview"
        repeat with d in (documents as list)
          set shouldClose to false
          try
            set docPath to (path of d as text)
            if docPath is ${targetPath} or docPath contains ${targetPath} then set shouldClose to true
          end try
          try
            set docName to (name of d as text)
            if docName is ${targetName} then
              try
                set docPath to (path of d as text)
                if docPath contains ${appleScriptString(EVAL_PATH_NEEDLE)} or docPath contains ${appleScriptString(RUN_ID)} then set shouldClose to true
              end try
            end if
          end try
          if shouldClose then
            try
              close d saving no
            on error
              try
                close d
              end try
            end try
          end if
        end repeat
      end tell
    `).catch(() => {});
  }
  if (app === 'Google Chrome') {
    if (!(await applicationIsRunning('Google Chrome'))) return;
    const targetUrl = appleScriptString(pathToFileURL(target).href);
    const targetPath = appleScriptString(target);
    await osascript(`
      tell application "Google Chrome"
        repeat with w in (windows as list)
          repeat with i from (count of tabs of w) to 1 by -1
            try
              set tabUrl to (URL of tab i of w as text)
              if tabUrl is ${targetUrl} or tabUrl contains ${targetPath} then close tab i of w
            end try
          end repeat
        end repeat
      end tell
    `).catch(() => {});
  }
}

async function openScenarioApp(app, target, opts = {}) {
  if (opts.dedupe !== false) await closeOpenTarget(app, target);
  await openApp(app, target);
}

async function cleanupStep(report, name, fn) {
  const started = Date.now();
  try {
    await fn();
    if (report) report.steps.push({ name, ok: true, durationMs: Date.now() - started });
  } catch (e) {
    const error = (e && e.message) || String(e);
    if (report) report.steps.push({ name, ok: false, durationMs: Date.now() - started, error });
  }
}

async function cleanupPreviewDocuments() {
  if (!(await applicationIsRunning('Preview'))) return;
  const evalNeedle = appleScriptString(EVAL_PATH_NEEDLE);
  const runNeedle = appleScriptString(RUN_ID);
  const disposablePrefix = appleScriptString(DISPOSABLE_PREFIX);
  const disposableFilePrefix = appleScriptString(DISPOSABLE_FILE_PREFIX);
  const legacyNames = appleScriptList(LEGACY_PREVIEW_FIXTURE_NAMES);
  await osascript(`
    tell application "Preview"
      set fixtureNames to ${legacyNames}
      repeat with d in (documents as list)
        set shouldClose to false
        try
          set docPath to (path of d as text)
          if docPath contains ${evalNeedle} or docPath contains ${runNeedle} then set shouldClose to true
        end try
        try
          set docName to (name of d as text)
          if docName starts with ${disposablePrefix} or docName starts with ${disposableFilePrefix} or fixtureNames contains docName then set shouldClose to true
        end try
        if shouldClose then
          try
            close d saving no
          on error
            try
              close d
            end try
          end try
        end if
      end repeat
    end tell
  `);
}

async function cleanupChromeTabs() {
  if (!(await applicationIsRunning('Google Chrome'))) return;
  const evalNeedle = appleScriptString(EVAL_PATH_NEEDLE);
  const runNeedle = appleScriptString(RUN_ID);
  const disposableFilePrefix = appleScriptString(DISPOSABLE_FILE_PREFIX);
  await osascript(`
    tell application "Google Chrome"
      repeat with w in (windows as list)
        repeat with i from (count of tabs of w) to 1 by -1
          try
            set tabUrl to (URL of tab i of w as text)
            if tabUrl contains ${evalNeedle} or tabUrl contains ${runNeedle} or tabUrl contains ${disposableFilePrefix} then close tab i of w
          end try
        end repeat
      end repeat
    end tell
  `);
}

async function cleanupGarageBandDocuments() {
  if (!(await applicationIsRunning('GarageBand'))) return;
  const runNeedle = appleScriptString(RUN_ID);
  const disposablePrefix = appleScriptString(DISPOSABLE_PREFIX);
  await osascript(`
    tell application "GarageBand"
      repeat with d in (documents as list)
        set shouldClose to false
        try
          set docName to (name of d as text)
          if docName contains ${runNeedle} or docName starts with ${disposablePrefix} then set shouldClose to true
        end try
        if shouldClose then
          try
            close d saving no
          end try
        end if
      end repeat
    end tell
  `);
}

async function cleanupDisposableWindows(report = null) {
  await cleanupStep(report, 'preview-documents', cleanupPreviewDocuments);
  await cleanupStep(report, 'chrome-tabs', cleanupChromeTabs);
  await cleanupStep(report, 'garageband-documents', cleanupGarageBandDocuments);
}

async function cleanupDisposableData(label = 'cleanup') {
  const report = { label, startedAt: new Date().toISOString(), steps: [] };
  await cleanupDisposableWindows(report);
  await cleanupStep(report, 'mail-drafts', async () => osascript(`
    tell application "Mail"
      set doomed to (outgoing messages whose subject starts with ${appleScriptString(DISPOSABLE_PREFIX)})
      repeat with i from (count of doomed) to 1 by -1
        try
          delete item i of doomed
        end try
      end repeat
      set remaining to (outgoing messages whose subject starts with ${appleScriptString(DISPOSABLE_PREFIX)})
      repeat with msg in remaining
        try
          set subject of msg to "Discarded E2E draft"
          set content of msg to ""
          set visible of msg to false
        end try
      end repeat
    end tell
  `));
  await cleanupStep(report, 'reminder-lists', async () => osascript(`
    tell application "Reminders"
      set doomed to (lists whose name starts with ${appleScriptString(DISPOSABLE_PREFIX)})
      repeat with i from (count of doomed) to 1 by -1
        delete item i of doomed
      end repeat
    end tell
  `));
  await cleanupStep(report, 'notes-folders', async () => osascript(`
    tell application "Notes"
      set rootDoomed to (folders whose name starts with ${appleScriptString(DISPOSABLE_PREFIX)})
      repeat with i from (count of rootDoomed) to 1 by -1
        delete item i of rootDoomed
      end repeat
      set accs to every account
      repeat with a in accs
        set doomed to (every folder of a whose name starts with ${appleScriptString(DISPOSABLE_PREFIX)})
        repeat with i from (count of doomed) to 1 by -1
          delete item i of doomed
        end repeat
      end repeat
    end tell
  `));
  await cleanupDisposableWindows(report);
  report.finishedAt = new Date().toISOString();
  writeJson(path.join(RUN_DIR, `${label}.cleanup.json`), report);
  return report;
}

async function appCount(script) {
  const out = await osascript(script).catch(() => '0');
  return Number(out.trim()) || 0;
}

async function previewDisposableDocumentCount() {
  if (!(await applicationIsRunning('Preview'))) return 0;
  return appCount(`
    tell application "Preview"
      set n to 0
      repeat with d in (documents as list)
        set matched to false
        try
          set docPath to (path of d as text)
          if docPath contains ${appleScriptString(EVAL_PATH_NEEDLE)} or docPath contains ${appleScriptString(RUN_ID)} then set matched to true
        end try
        try
          set docName to (name of d as text)
          if docName starts with ${appleScriptString(DISPOSABLE_PREFIX)} or docName starts with ${appleScriptString(DISPOSABLE_FILE_PREFIX)} then set matched to true
        end try
        if matched then set n to n + 1
      end repeat
      return n
    end tell
  `);
}

async function chromeDisposableTabCount() {
  if (!(await applicationIsRunning('Google Chrome'))) return 0;
  return appCount(`
    tell application "Google Chrome"
      set n to 0
      repeat with w in (windows as list)
        repeat with t in (tabs of w)
          try
            set tabUrl to (URL of t as text)
            if tabUrl contains ${appleScriptString(EVAL_PATH_NEEDLE)} or tabUrl contains ${appleScriptString(RUN_ID)} or tabUrl contains ${appleScriptString(DISPOSABLE_FILE_PREFIX)} then set n to n + 1
          end try
        end repeat
      end repeat
      return n
    end tell
  `);
}

async function garageBandDisposableDocumentCount() {
  if (!(await applicationIsRunning('GarageBand'))) return 0;
  return appCount(`
    tell application "GarageBand"
      set n to 0
      repeat with d in (documents as list)
        try
          set docName to (name of d as text)
          if docName contains ${appleScriptString(RUN_ID)} or docName starts with ${appleScriptString(DISPOSABLE_PREFIX)} then set n to n + 1
        end try
      end repeat
      return n
    end tell
  `);
}

async function disposableCounts() {
  return {
    mail: await appCount(`tell application "Mail" to return count of (outgoing messages whose subject starts with ${appleScriptString(DISPOSABLE_PREFIX)})`),
    reminders: await appCount(`tell application "Reminders" to return count of (lists whose name starts with ${appleScriptString(DISPOSABLE_PREFIX)})`),
    notes: await appCount(`tell application "Notes" to return count of (folders whose name starts with ${appleScriptString(DISPOSABLE_PREFIX)})`),
    preview: await previewDisposableDocumentCount(),
    chrome: await chromeDisposableTabCount(),
    garageBand: await garageBandDisposableDocumentCount(),
  };
}

async function disposableLabelCounts(label) {
  const needle = appleScriptString(label);
  const mail = await appCount(`tell application "Mail" to return count of (outgoing messages whose subject contains ${needle})`);
  const reminderLists = await appCount(`tell application "Reminders" to return count of (lists whose name contains ${needle})`);
  const reminderItems = await appCount(`
    tell application "Reminders"
      set n to 0
      repeat with l in (lists whose name contains ${needle})
        try
          set n to n + (count of reminders of l)
        end try
      end repeat
      return n
    end tell
  `);
  const notesFolders = await appCount(`tell application "Notes" to return count of (folders whose name contains ${needle})`);
  const notesItems = await appCount(`
    tell application "Notes"
      set n to 0
      repeat with f in (folders whose name contains ${needle})
        try
          set n to n + (count of notes of f)
        end try
      end repeat
      repeat with a in every account
        repeat with f in (folders of a whose name contains ${needle})
          try
            set n to n + (count of notes of f)
          end try
        end repeat
      end repeat
      return n
    end tell
  `);
  return { mail, reminderLists, reminderItems, notesFolders, notesItems };
}

async function labelCountIncreased(result, keys) {
  const counts = await disposableLabelCounts(result.disposableLabel || '');
  result.labelCounts = counts;
  return countIncreased(counts, result.labelBaseline || {}, keys);
}

async function mailDraftExists(needle) {
  return (await appCount(`tell application "Mail" to return count of (outgoing messages whose subject contains ${appleScriptString(needle)})`)) > 0;
}

async function reminderListExists(needle) {
  return (await appCount(`tell application "Reminders" to return count of (lists whose name contains ${appleScriptString(needle)})`)) > 0;
}

async function notesFolderExists(needle) {
  return (await appCount(`tell application "Notes" to return count of (folders whose name contains ${appleScriptString(needle)})`)) > 0;
}

function ankiCollectionTouched(dir) {
  return existsAny(path.join(dir, '.anki-base'), ['collection.anki2', '.anki2'])
    || existsAny(dir, ['.apkg', 'anki']);
}

function garageBandArtifactExists(dir) {
  return existsAny(dir, ['.band', '.mid', '.midi', '.aif', '.aiff', '.wav']);
}

function existsAnyAfter(dir, needles, afterMs) {
  const haystack = [];
  function walk(p) {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.mtimeMs >= afterMs) haystack.push(p);
    if (st.isDirectory()) {
      for (const child of fs.readdirSync(p)) walk(path.join(p, child));
    }
  }
  walk(dir);
  const text = haystack.join('\n').toLowerCase();
  return needles.some((needle) => text.includes(String(needle).toLowerCase()));
}

function countIncreased(now, before, keys) {
  return keys.some((key) => Number(now[key] || 0) > Number(before[key] || 0));
}

function makeScenarioWorkspace(name) {
  const dir = path.join(WORKSPACE_DIR, name);
  ensureDir(dir);
  writeFile(path.join(dir, 'README.md'), [
    `# agent-UI E2E workspace`,
    `Run: ${RUN_ID}`,
    `Scenario: ${name}`,
    '',
    'All files here are disposable benchmark data. Do not use real user data.',
  ].join('\n'));
  return dir;
}

async function createNotesFolder(name, noteTitle, noteBody, opts = {}) {
  if (opts.focus) await focusApp('Notes');
  await osascript(`
    tell application "Notes"
      if not (exists folder ${appleScriptString(name)}) then make new folder with properties {name:${appleScriptString(name)}}
      make new note at folder ${appleScriptString(name)} with properties {name:${appleScriptString(noteTitle)}, body:${appleScriptString(noteBody)}}
    end tell
  `).catch(() => {});
  if (opts.focus) await focusApp('Notes');
}

async function createReminderList(name) {
  await osascript(`tell application "Reminders" to if not (exists list ${appleScriptString(name)}) then make new list with properties {name:${appleScriptString(name)}}`).catch(() => {});
}

async function createMailDraft(subject, body, opts = {}) {
  if (opts.focus) await focusApp('Mail');
  await osascript(`
    tell application "Mail"
      set msg to make new outgoing message with properties {subject:${appleScriptString(subject)}, content:${appleScriptString(body)}, visible:true}
      tell msg to make new to recipient at end of to recipients with properties {address:"agent-ui-e2e@example.invalid"}
    end tell
  `).catch(() => {});
  if (opts.focus) await focusApp('Mail');
}

async function setupObsidianVault(context, title, body) {
  const vault = path.join(context.dir, `${DISPOSABLE_FILE_PREFIX}-obsidian-vault`);
  const noteTitle = `${context.label} ${title}`;
  ensureDir(vault);
  writeFile(path.join(vault, `${noteTitle.replace(/[/:]/g, '-')}.md`), body);
  await openScenarioApp('Obsidian', vault).catch(() => {});
  return vault;
}

const scenarios = [
  {
    name: 'pdf-to-mail-action-pack',
    mode: 'typed',
    setup: async (context) => {
      const pdf = context.file('quarterly-risk-report.pdf');
      writeFile(pdf, minimalPdf('Quarterly Risk Report', [
        'Revenue risk: delayed enterprise renewals.',
        'Decision needed: extend pilot by two weeks.',
        'Action items: owner Sam for renewal analysis, owner Lee for launch notes.',
      ]));
      await createReminderList(context.name('PDF Actions'));
      await createNotesFolder(context.name('PDF Notes'), 'PDF source note', 'Summarize the visible report and back up the result here.');
      await openScenarioApp('Preview', pdf);
      return { pdf };
    },
    prompt: 'Read the visible PDF report. Draft an unsent Mail message to agent-ui-e2e@example.invalid summarizing risks, decisions, and next actions. Also create Reminders follow-ups and a Notes backup. Name all outputs agent-UI E2E.',
    oracle: async (dir, result) => (
      await labelCountIncreased(result, ['mail', 'reminderItems', 'notesItems'])
      || existsAnyAfter(dir, ['mail-draft', 'reminders', 'notes-backup'], result.submitAt || result.startedAt || 0)
    ),
  },
  {
    name: 'chrome-pdf-to-anki-study-pack',
    mode: 'typed',
    setup: async (context) => {
      const lesson = context.file('lesson.html');
      writeFile(lesson, '<h1>agent-UI E2E Spaced Repetition Lesson</h1><p>Key ideas: retrieval practice, interleaving, spacing, calibration, desirable difficulty.</p>');
      const pdf = context.file('study-companion.pdf');
      writeFile(pdf, minimalPdf('Study Companion', ['Cloze cards should test recall, not recognition.', 'Deck must include basic and cloze style cards.']));
      await setupObsidianVault(context, 'Study Plan', '# Study Plan\n\nCreate the final plan below.\n');
      await openScenarioApp('Google Chrome', lesson);
      await openScenarioApp('Preview', pdf);
      return { lesson, pdf };
    },
    prompt: 'Turn the visible Chrome lesson and PDF into an Anki study deck in the isolated Anki profile, with at least 12 basic/cloze cards. Then write a study plan in the disposable Obsidian vault. Name all outputs agent-UI E2E.',
    oracle: async (dir, result) => ankiCollectionTouched(dir) || existsAnyAfter(dir, ['anki', 'deck', 'Study Plan'], result.submitAt || result.startedAt || 0),
  },
  {
    name: 'garageband-beat-from-brief',
    mode: 'typed',
    setup: async (context) => {
      await setupObsidianVault(context, 'Production Notes', '# Production Notes\n');
      await openApp('GarageBand').catch(() => {});
      await createNotesFolder(context.name('GarageBand Brief'), 'GarageBand brief', 'Make a 16 bar lo-fi beat at 92 BPM with drums, bass, warm chords, and a small lead hook.', { focus: true });
    },
    prompt: 'Use the visible Notes creative brief to make a short GarageBand beat sketch. Save a disposable GarageBand project or MIDI/audio sketch in the selected folder, and write production notes in Obsidian. Include drums, bass, chords, melody, BPM, and sections.',
    oracle: async (dir, result) => garageBandArtifactExists(dir) || existsAnyAfter(dir, ['Production Notes'], result.submitAt || result.startedAt || 0),
  },
  {
    name: 'mail-to-reminders-and-obsidian-response',
    mode: 'voice',
    transcript: 'Turn the visible Mail request into a reply draft, create a timeline in Reminders, and update the Obsidian project note. Use only agent-UI E2E disposable data.',
    setup: async (context) => {
      await createReminderList(context.name('Client Timeline'));
      await setupObsidianVault(context, 'Client Timeline', '# Client Timeline\n');
      await createMailDraft(context.name('Client Request'), 'Please propose a launch timeline, owners, risks, and a polite response draft.', { focus: true });
    },
    oracle: async (dir, result) => (
      await labelCountIncreased(result, ['mail', 'reminderItems'])
      || existsAnyAfter(dir, ['Client Timeline', 'reply', 'timeline'], result.submitAt || result.startedAt || 0)
    ),
  },
  {
    name: 'notes-research-to-anki-and-mail',
    mode: 'typed',
    setup: async (context) => {
      await createNotesFolder(context.name('Research Notes'), 'Research Notes', 'Rough notes: compare latency, reliability, cleanup, and visible state. Ask reviewer to validate examples.');
      const source = context.file('source.html');
      writeFile(source, '<h1>Research Source</h1><p>Reliable automation needs traceability, cleanup, and deterministic fixtures.</p>');
      await openScenarioApp('Google Chrome', source);
    },
    prompt: 'Clean up the visible research notes, create an Anki study deck from them, and draft an unsent Mail review request. Keep all artifacts disposable and named agent-UI E2E.',
    oracle: async (dir, result) => (
      ankiCollectionTouched(dir)
      || await labelCountIncreased(result, ['mail', 'notesItems'])
      || existsAnyAfter(dir, ['research', 'review', 'anki'], result.submitAt || result.startedAt || 0)
    ),
  },
  {
    name: 'obsidian-release-to-garageband-sting-and-reminders',
    mode: 'voice',
    transcript: 'Use the visible Obsidian release checklist to create a short GarageBand launch sting and schedule release reminders. Save all files in the selected folder.',
    setup: async (context) => {
      await createReminderList(context.name('Release'));
      await openApp('GarageBand').catch(() => {});
      await setupObsidianVault(context, 'Release Checklist', '# Release Checklist\n\n- Make a 4 bar launch sting\n- Schedule publish, QA, and announcement tasks\n- Note asset filenames\n');
    },
    oracle: async (dir, result) => (
      garageBandArtifactExists(dir)
      || await labelCountIncreased(result, ['reminderItems'])
      || existsAnyAfter(dir, ['Release Checklist', 'release'], result.submitAt || result.startedAt || 0)
    ),
  },
];

function existsAny(dir, needles) {
  const haystack = [];
  function walk(p) {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    haystack.push(p);
    if (st.isDirectory()) {
      for (const child of fs.readdirSync(p)) walk(path.join(p, child));
    }
  }
  walk(dir);
  const text = haystack.join('\n').toLowerCase();
  return needles.some((needle) => text.includes(String(needle).toLowerCase()));
}

async function preflight() {
  if (process.platform !== 'darwin') throw new Error('human E2E benchmark requires macOS');
  if (!isExecutable(HERMES)) throw new Error(`Hermes is required and executable was not found: ${HERMES}`);
  if (path.basename(HERMES).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() !== 'hermes') {
    throw new Error(`AGENT_UI_HERMES_BIN must resolve to Hermes, got: ${HERMES}`);
  }
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) throw new Error('Missing build output. Run npm run build first.');
  for (const [name, bundle] of Object.entries(REQUIRED_APPS)) {
    const actual = await osascript(`id of application "${name}"`).catch(() => '');
    if (actual.trim() !== bundle) throw new Error(`Missing required app ${name} (${bundle})`);
  }
  await input('check-permissions');
}

function launchAgentUI() {
  const electron = require('electron');
  const child = spawn(electron, [path.join(ROOT, 'out', 'main', 'index.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGENT_UI_EVAL: '1',
      AGENT_UI_EVAL_RUN_ID: RUN_ID,
      AGENT_UI_EVAL_DIR: EVAL_DIR,
      AGENT_UI_EVAL_PORT_FILE: PORT_FILE,
      AGENT_UI_CONFIG_DIR: CONFIG_DIR,
      AGENT_UI_HERMES_BIN: HERMES,
      HERMES_SESSION_SOURCE: 'agent-ui',
      AGENT_UI_EVAL_TRANSCRIPT_FILE: TRANSCRIPT_FILE,
      AGENT_UI_CONTEXT_CAPTURE: '1',
      AGENT_UI_EVAL_ANKI_ROOT: path.join(RUN_DIR, 'anki-base'),
    },
  });
  child.stdout.on('data', (d) => fs.appendFileSync(path.join(RUN_DIR, 'agent-ui.stdout.log'), d));
  child.stderr.on('data', (d) => fs.appendFileSync(path.join(RUN_DIR, 'agent-ui.stderr.log'), d));
  return child;
}

async function prepareScenarioStart(port, scenario, context, result) {
  await closeModalIfOpen(port);
  seedRecentFolder(context.dir);
  result.setupArtifacts = await scenario.setup(context) || {};
  result.appBaseline = await disposableCounts();
  result.labelBaseline = await disposableLabelCounts(context.label);
  result.promptText = promptForScenario(scenario, result);
  if (scenario.mode === 'voice') writeFile(TRANSCRIPT_FILE, result.promptText);
  seedRecentFolder(context.dir);
}

async function startScenario(port, scenario, index, appPid) {
  const dir = makeScenarioWorkspace(scenario.name);
  const context = makeScenarioContext(scenario, dir);
  const started = Date.now();
  const result = {
    name: scenario.name,
    mode: scenario.mode,
    dir,
    disposableLabel: context.label,
    index,
    startedAt: started,
    workflowSuccess: 0,
    oraclePass: 0,
    cleanupSuccess: 0,
    modalFocus: 0,
    shortcutToModalMs: null,
    submitToCatVisibleMs: null,
    promptInputMs: null,
    promptVisibleMatch: 0,
    visibleTextStatePass: 0,
    visibleStates: [],
  };
  try {
    await prepareScenarioStart(port, scenario, context, result);
    const before = await request(port, 'GET', '/conversations');
    const beforeIds = new Set((before.conversations || []).map((c) => String(c.catId)));
    const shortcutAt = Date.now();
    await pressNewCatShortcut(port, appPid);
    const targets = await waitForSelectedFolder(port, dir);
    result.modalContextId = targets.modal && targets.modal.modalContextId ? String(targets.modal.modalContextId) : null;
    result.shortcutToModalMs = Date.now() - shortcutAt;
    result.modalFocus = targets.modal && targets.modal.activeElement && targets.modal.activeElement.id === 'prompt' ? 1 : 0;
    const modalPid = targets.modal && targets.modal.osProcessId ? Number(targets.modal.osProcessId) : appPid;
    if (targets.modal.selectedFolderPath !== dir) {
      throw new Error(`Selected folder mismatch: expected ${dir}, got ${targets.modal.selectedFolderPath || '(empty)'}`);
    }
    const promptPoint = center(targets.modal.promptRect);
    await input('click', String(promptPoint.x), String(promptPoint.y));
    const inputStartedAt = Date.now();
    if (scenario.mode === 'voice') {
      const mic = center(targets.modal.micButtonRect);
      await input('click', String(mic.x), String(mic.y));
      await waitForPromptLength(port, result.promptText.length);
    } else {
      const typed = await typePromptText(port, appPid, modalPid, promptPoint, result.promptText);
      result.promptInputAttempt = typed && typed.attempt ? typed.attempt : null;
      result.promptInputAttempts = typed && typed.attempts ? typed.attempts : [];
    }
    result.promptInputMs = Date.now() - inputStartedAt;
    const afterInputTargets = await request(port, 'GET', '/ui-targets').catch(() => null);
    if (afterInputTargets) {
      result.visibleStates.push(captureVisibleState('after_input', afterInputTargets));
      const promptPreview = afterInputTargets.modal && afterInputTargets.modal.promptValuePreview ? String(afterInputTargets.modal.promptValuePreview) : '';
      result.promptVisibleMatch = promptPreview === String(result.promptText || '').slice(0, 120) ? 1 : 0;
    }
    const submitAt = Date.now();
    result.submitAt = submitAt;
    await input('key', 'enter');
    await sleep(200);
    const afterEnter = await request(port, 'GET', '/ui-targets').catch(() => null);
    if (afterEnter && afterEnter.modal && afterEnter.modal.visible) {
      await input('hotkey-pid', String(modalPid), 'enter');
    }
    const catId = await waitForNewCat(port, beforeIds);
    result.catId = catId;
    const catVisibleMs = await waitForCatVisible(port, catId);
    result.submitToCatVisibleMs = Date.now() - submitAt || catVisibleMs;
    const afterSubmitTargets = await request(port, 'GET', '/ui-targets').catch(() => null);
    if (afterSubmitTargets) result.visibleStates.push(captureVisibleState('after_submit', afterSubmitTargets));
    const conversationRunningTargets = await openConversationFromVisibleCat(port, catId).catch(() => null);
    if (conversationRunningTargets) result.visibleStates.push(captureVisibleState('conversation_running', conversationRunningTargets));
    result.visibleTextStatePass = visibleStatePass(result);
    result.startedOk = true;
  } catch (e) {
    result.error = (e && e.message) || String(e);
  } finally {
    result.startDurationMs = Date.now() - started;
    writeJson(path.join(RUN_DIR, `${scenario.name}.result.json`), result);
  }
  return result;
}

async function finishScenario(port, scenario, result) {
  if (!result || !result.catId) {
    result.durationMs = Date.now() - (result.startedAt || Date.now());
    writeJson(path.join(RUN_DIR, `${scenario.name}.result.json`), result);
    return result;
  }
  try {
    const waited = await request(port, 'POST', '/wait', { catId: result.catId, timeoutMs: SCENARIO_TIMEOUT_MS });
    result.status = waited.status || 'timeout';
    if (!waited.ok || result.status === 'timeout') {
      const cancelled = await request(port, 'POST', '/cancel', { catId: result.catId }).catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e) }));
      result.cancelledAfterTimeout = !!cancelled.ok;
      if (cancelled.ok) {
        const afterCancel = await request(port, 'POST', '/wait', { catId: result.catId, timeoutMs: 15000 }).catch(() => null);
        if (afterCancel && afterCancel.status) result.status = afterCancel.status;
      }
    }
    result.hermesSessionId = waited.conversation && waited.conversation.hermesSessionId ? waited.conversation.hermesSessionId : null;
    result.artifacts = waited.artifacts || (waited.conversation && waited.conversation.artifacts) || null;
    result.oraclePass = await scenario.oracle(result.dir, result) ? 1 : 0;
    if (result.artifacts && result.artifacts.oracle) {
      writeJson(result.artifacts.oracle, {
        scenario: scenario.name,
        catId: result.catId,
        status: result.status,
        passed: !!result.oraclePass,
        checkedAt: new Date().toISOString(),
      });
    }
    result.workflowSuccess = waited.ok && waited.status === 'completed' && result.oraclePass ? 1 : 0;
    const conversationFinishedTargets = await openConversationFromVisibleCat(port, result.catId).catch(() => null);
    if (conversationFinishedTargets) result.visibleStates.push(captureVisibleState('conversation_finished', conversationFinishedTargets));
    const afterFinishTargets = await request(port, 'GET', '/ui-targets').catch(() => null);
    if (afterFinishTargets) result.visibleStates.push(captureVisibleState('after_finish', afterFinishTargets));
    result.visibleTextStatePass = visibleStatePass(result);
    await request(port, 'POST', '/dismiss', { catId: result.catId }).catch(() => {});
  } catch (e) {
    result.error = (e && e.message) || String(e);
  } finally {
    result.durationMs = Date.now() - (result.startedAt || Date.now());
    writeJson(path.join(RUN_DIR, `${scenario.name}.result.json`), result);
  }
  return result;
}

function traceLatency(events, fromType, toType) {
  const values = [];
  const byCat = new Map();
  for (const event of events) {
    const key = event.catId || '_global';
    if (event.type === fromType) byCat.set(key, event.at);
    if (event.type === toType && byCat.has(key)) {
      values.push(event.at - byCat.get(key));
      byCat.delete(key);
    }
  }
  return values;
}

function eventTime(event) {
  return Number.isFinite(Number(event && event.tRelMs)) ? Number(event.tRelMs) : Number(event && event.at);
}

function latencyBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(0, Math.round((eventTime(b) - eventTime(a)) * 1000) / 1000);
}

function latestBy(events, predicate) {
  const matches = events.filter(predicate);
  return matches.length ? matches[matches.length - 1] : null;
}

function firstBy(events, predicate) {
  return events.find(predicate) || null;
}

function summarizeLatency(events, results) {
  const byModal = new Map();
  const byCat = new Map();
  for (const event of events) {
    if (event.modalContextId) {
      const key = String(event.modalContextId);
      if (!byModal.has(key)) byModal.set(key, []);
      byModal.get(key).push(event);
    }
    if (event.catId) {
      const key = String(event.catId);
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key).push(event);
    }
  }
  const scenarios = (results || []).map((result) => {
    const modalEvents = result.modalContextId ? byModal.get(String(result.modalContextId)) || [] : [];
    const catEvents = result.catId ? byCat.get(String(result.catId)) || [] : [];
    const all = [...modalEvents, ...catEvents].sort((a, b) => eventTime(a) - eventTime(b));
    const e = (type) => firstBy(all, (ev) => ev.type === type);
    const shortcut = e('shortcut_received');
    const modalRequested = e('modal_show_requested');
    const modalCreated = e('modal_window_created');
    const modalLoaded = e('modal_dom_loaded');
    const modalFocused = e('modal_shown_and_focused');
    const pointerStart = e('pointer_context_capture_started');
    const pointerApp = e('pointer_app_context_captured');
    const pointerShot = e('pointer_screenshot_captured');
    const pointerDone = e('pointer_context_captured');
    const promptTyped = e('prompt_typed') || e('voice_transcript_inserted');
    const submitFromModal = e('submit_requested_from_modal');
    const submitReady = e('submit_pointer_context_ready');
    const submit = e('submit_requested');
    const catSpawnSent = e('cat_spawn_sent');
    const catSpawnRendered = e('cat_spawn_rendered');
    const runner = e('cli_runner_resolved');
    const artifactsReady = e('cat_artifacts_ready');
    const artifactsDone = e('cat_artifact_prepare_completed');
    const cliStarted = e('cli_process_started');
    const firstOutput = e('first_cli_output');
    const streamBubble = e('stream_bubble_rendered');
    const terminalState = e('terminal_state_rendered');
    const terminalVisual = e('terminal_visual_rendered');
    return {
      name: result.name,
      mode: result.mode,
      catId: result.catId || null,
      status: result.status || null,
      modalContextId: result.modalContextId || null,
      stepsMs: {
        shortcut_to_modal_request: latencyBetween(shortcut, modalRequested),
        modal_request_to_window_created: latencyBetween(modalRequested, modalCreated),
        modal_request_to_dom_loaded: latencyBetween(modalRequested, modalLoaded),
        modal_request_to_focused: latencyBetween(modalRequested, modalFocused),
        shortcut_to_modal_focused: latencyBetween(shortcut, modalFocused),
        pointer_total: pointerDone && pointerStart ? latencyBetween(pointerStart, pointerDone) : (pointerDone && pointerDone.durationMs != null ? Number(pointerDone.durationMs) : null),
        pointer_app_context: pointerApp && pointerApp.durationMs != null ? Number(pointerApp.durationMs) : null,
        pointer_screenshot: pointerShot && pointerShot.durationMs != null ? Number(pointerShot.durationMs) : null,
        modal_focused_to_input_ready: latencyBetween(modalFocused, promptTyped),
        input_ready_to_submit: latencyBetween(promptTyped, submitFromModal || submit),
        submit_to_pointer_ready: latencyBetween(submitFromModal, submitReady),
        submit_to_main_submit: latencyBetween(submitFromModal, submit),
        submit_to_spawn_sent: latencyBetween(submitFromModal, catSpawnSent),
        spawn_sent_to_rendered: latencyBetween(catSpawnSent, catSpawnRendered),
        spawn_sent_to_runner_resolved: latencyBetween(catSpawnSent, runner),
        runner_resolved_to_artifacts_ready: latencyBetween(runner, artifactsReady),
        artifacts_ready_to_prepare_done: latencyBetween(artifactsReady, artifactsDone),
        artifact_prepare_to_cli_started: latencyBetween(artifactsDone, cliStarted),
        cli_started_to_first_output: latencyBetween(cliStarted, firstOutput),
        first_output_to_stream_bubble: latencyBetween(firstOutput, streamBubble),
        cli_started_to_terminal_state: latencyBetween(cliStarted, terminalState),
        terminal_state_to_visual: latencyBetween(terminalState, terminalVisual),
      },
    };
  });
  const allStepNames = [...new Set(scenarios.flatMap((s) => Object.keys(s.stepsMs || {})))];
  const aggregate = {};
  for (const step of allStepNames) {
    const values = scenarios.map((s) => s.stepsMs[step]).filter((n) => Number.isFinite(Number(n))).map(Number);
    aggregate[step] = {
      count: values.length,
      min: values.length ? Math.min(...values) : null,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: values.length ? Math.max(...values) : null,
    };
  }
  return { runId: RUN_ID, runMode: RUN_MODE, generatedAt: new Date().toISOString(), aggregate, scenarios };
}

function writeLatencyReport(report) {
  writeJson(path.join(RUN_DIR, 'latency-report.json'), report);
  const lines = ['# agent-UI latency report', '', `Run: ${report.runId}`, `Mode: ${report.runMode}`, '', '## Aggregate step timings (ms)', '', '| step | count | p50 | p95 | max |', '|---|---:|---:|---:|---:|'];
  for (const [step, stats] of Object.entries(report.aggregate || {})) {
    lines.push(`| ${step} | ${stats.count} | ${stats.p50 ?? ''} | ${stats.p95 ?? ''} | ${stats.max ?? ''} |`);
  }
  lines.push('', '## Per scenario', '');
  for (const scenario of report.scenarios || []) {
    lines.push(`### ${scenario.name} (${scenario.status || 'unknown'})`, '');
    for (const [step, value] of Object.entries(scenario.stepsMs || {})) {
      if (value != null) lines.push(`- ${step}: ${value}ms`);
    }
    lines.push('');
  }
  writeFile(path.join(RUN_DIR, 'latency-report.md'), lines.join('\n'));
}

function metricLine(name, value) {
  const n = Number.isFinite(value) ? value : 0;
  return `METRIC ${name}=${n}`;
}

function captureVisibleState(label, targets = {}) {
  return {
    label,
    at: Date.now(),
    modalVisible: !!(targets.modal && targets.modal.visible),
    modalText: targets.modal && targets.modal.visibleTextPreview ? String(targets.modal.visibleTextPreview) : '',
    promptLength: targets.modal && Number.isFinite(Number(targets.modal.promptValueLength)) ? Number(targets.modal.promptValueLength) : 0,
    promptPreview: targets.modal && targets.modal.promptValuePreview ? String(targets.modal.promptValuePreview) : '',
    conversationVisible: !!(targets.conversation && targets.conversation.visible),
    conversationText: targets.conversation && targets.conversation.visibleTextPreview ? String(targets.conversation.visibleTextPreview) : '',
    conversationLineEntries: Array.isArray(targets.conversation && targets.conversation.lineEntries) ? targets.conversation.lineEntries.slice(0, 20) : [],
    catCount: Array.isArray(targets.cats) ? targets.cats.length : 0,
  };
}

function visibleStatePass(result) {
  const states = Array.isArray(result.visibleStates) ? result.visibleStates : [];
  const afterInput = states.find((s) => s.label === 'after_input');
  const afterSubmit = states.find((s) => s.label === 'after_submit');
  const conversationStates = states.filter((s) => String(s.label || '').startsWith('conversation_'));
  const promptOk = !!afterInput && afterInput.promptLength >= String(result.promptText || '').length && String(afterInput.promptPreview || '') === String(result.promptText || '').slice(0, 120);
  const submitOk = !!afterSubmit && afterSubmit.catCount > 0;
  const convoOk = conversationStates.some((state) => {
    const items = Array.isArray(state.conversationLineEntries) ? state.conversationLineEntries : [];
    const labels = items.map((it) => String(it.label || '').toLowerCase());
    const text = items.map((it) => String(it.text || '')).join('\n');
    return labels.includes('you') && labels.includes('agent') && text.length > 0;
  });
  return promptOk && submitOk && convoOk ? 1 : 0;
}

async function cancelUnfinishedScenarios(port, results) {
  for (const result of results || []) {
    if (!result || !result.catId) continue;
    if (['completed', 'error', 'cancelled'].includes(String(result.status || '').toLowerCase())) continue;
    const cancelled = await request(port, 'POST', '/cancel', { catId: result.catId }).catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e) }));
    result.cancelledDuringCleanup = !!cancelled.ok;
    if (!cancelled.ok) result.cancelError = cancelled.error || 'cancel failed';
    writeJson(path.join(RUN_DIR, `${result.name}.result.json`), result);
  }
}

async function main() {
  ensureDir(RUN_DIR);
  ensureDir(WORKSPACE_DIR);
  ensureDir(CONFIG_DIR);
  writeFile(TRANSCRIPT_FILE, '');
  await preflight();
  if (process.argv.includes('--preflight-only')) return;

  await cleanupDisposableData('pre-run');
  const child = launchAgentUI();
  const port = await waitForPort();
  await request(port, 'GET', '/health');
  await waitForTraceEvent(port, 'overlay_ready');
  const shortcutReady = await waitForTraceEvent(port, 'shortcut_registered');
  if (!shortcutReady.registered) {
    throw new Error(`agent-UI global shortcut did not register: ${shortcutReady.accelerator || '(unknown)'}`);
  }

  const activeScenarios = scenarios.filter((s) => !SELECTED.size || SELECTED.has(s.name));
  const results = [];
  try {
    const started = [];
    if (RUN_CONCURRENT) {
      for (let i = 0; i < activeScenarios.length; i++) {
        const scenario = activeScenarios[i];
        const result = await startScenario(port, scenario, i, child.pid);
        started.push({ scenario, result });
        results.push(result);
        if (i < activeScenarios.length - 1) {
          await sleep(START_STAGGER_MS);
        }
      }
      await Promise.all(started.map(({ scenario, result }) => finishScenario(port, scenario, result)));
    } else {
      for (let i = 0; i < activeScenarios.length; i++) {
        const scenario = activeScenarios[i];
        const result = await startScenario(port, scenario, i, child.pid);
        started.push({ scenario, result });
        results.push(result);
        await finishScenario(port, scenario, result);
      }
    }
    await cancelUnfinishedScenarios(port, results);
    try {
      await cleanupDisposableData('post-run');
      const remaining = await disposableCounts();
      const ok = Object.values(remaining).every((n) => Number(n || 0) === 0);
      for (const result of results) {
        result.cleanupSuccess = ok ? 1 : 0;
        if (!ok) result.cleanupRemaining = remaining;
        writeJson(path.join(RUN_DIR, `${result.name}.result.json`), result);
      }
    } catch (e) {
      for (const result of results) {
        result.cleanupSuccess = 0;
        result.cleanupError = (e && e.message) || String(e);
        writeJson(path.join(RUN_DIR, `${result.name}.result.json`), result);
      }
    }
    const trace = await request(port, 'GET', '/trace').catch(() => ({ events: [] }));
    const events = trace.events || [];
    writeJson(path.join(RUN_DIR, 'results.json'), { runId: RUN_ID, runMode: RUN_MODE, results, traceFile: trace.traceFile || null });
    const latencyReport = summarizeLatency(events, results);
    writeLatencyReport(latencyReport);

    const count = Math.max(1, results.length);
    const typed = results.filter((r) => r.mode === 'typed');
    const voice = results.filter((r) => r.mode === 'voice');
    const workflowSuccessRate = results.reduce((s, r) => s + r.workflowSuccess, 0) / count;
    const typedSuccessRate = typed.length ? typed.reduce((s, r) => s + r.workflowSuccess, 0) / typed.length : 1;
    const voiceSuccessRate = voice.length ? voice.reduce((s, r) => s + r.workflowSuccess, 0) / voice.length : 1;
    const modalFocusSuccessRate = results.reduce((s, r) => s + r.modalFocus, 0) / count;
    const oraclePassRate = results.reduce((s, r) => s + r.oraclePass, 0) / count;
    const cleanupSuccessRate = results.reduce((s, r) => s + r.cleanupSuccess, 0) / count;
    const promptVisibleMatchRate = results.reduce((s, r) => s + (r.promptVisibleMatch || 0), 0) / count;
    const visibleTextStatePassRate = results.reduce((s, r) => s + (r.visibleTextStatePass || 0), 0) / count;
    const promptInputP95 = percentile(results.map((r) => r.promptInputMs), 95);
    const promptCharsPerSec = results.reduce((s, r) => s + (String(r.promptText || '').length || 0), 0) / Math.max(0.001, results.reduce((s, r) => s + (Number(r.promptInputMs || 0) / 1000), 0));
    const shortcutP95 = percentile(results.map((r) => r.shortcutToModalMs), 95);
    const submitP95 = percentile(results.map((r) => r.submitToCatVisibleMs), 95);
    const firstOutputToBubbleP95 = percentile(traceLatency(events, 'first_cli_output', 'stream_bubble_rendered'), 95);
    const terminalToVisualP95 = percentile(traceLatency(events, 'terminal_state_rendered', 'terminal_visual_rendered'), 95);
    const humanUiReliability = (modalFocusSuccessRate + results.filter((r) => Number.isFinite(r.submitToCatVisibleMs)).length / count) / 2;
    const typedLatencyScore = Math.max(0, Math.min(1, (300 - shortcutP95) / 300)) * 0.5
      + Math.max(0, Math.min(1, (150 - submitP95) / 150)) * 0.5;
    const visualStateAccuracy =
      (events.some((e) => e.type === 'stream_bubble_rendered') ? 0.5 : 0)
      + (events.some((e) => e.type === 'terminal_visual_rendered') ? 0.5 : 0);
    const uiCompositeScore = 100 * (
      0.30 * oraclePassRate
      + 0.20 * humanUiReliability
      + 0.15 * typedLatencyScore
      + 0.15 * voiceSuccessRate
      + 0.10 * visualStateAccuracy
      + 0.10 * cleanupSuccessRate
    );

    console.log(metricLine('ui_composite_score', uiCompositeScore));
    console.log(metricLine('workflow_success_rate', workflowSuccessRate));
    console.log(metricLine('typed_success_rate', typedSuccessRate));
    console.log(metricLine('voice_success_rate', voiceSuccessRate));
    console.log(metricLine('shortcut_to_modal_p95_ms', shortcutP95));
    console.log(metricLine('modal_focus_success_rate', modalFocusSuccessRate));
    console.log(metricLine('submit_to_cat_visible_p95_ms', submitP95));
    console.log(metricLine('prompt_input_p95_ms', promptInputP95));
    console.log(metricLine('prompt_chars_per_sec', promptCharsPerSec));
    console.log(metricLine('prompt_visible_match_rate', promptVisibleMatchRate));
    console.log(metricLine('visible_text_state_pass_rate', visibleTextStatePassRate));
    console.log(metricLine('first_output_to_bubble_p95_ms', firstOutputToBubbleP95));
    console.log(metricLine('terminal_to_visual_p95_ms', terminalToVisualP95));
    console.log(metricLine('oracle_pass_rate', oraclePassRate));
    console.log(metricLine('cleanup_success_rate', cleanupSuccessRate));
  } finally {
    await cancelUnfinishedScenarios(port, results).catch(() => {});
    await request(port, 'POST', '/shutdown', {}).catch(() => {});
    child.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(`[agent-ui-e2e] ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
