#!/usr/bin/env node
'use strict';

const { execFile } = require('child_process');

const DISPOSABLE_PREFIX = 'agent-UI E2E';
const DISPOSABLE_FILE_PREFIX = 'agent-UI-E2E';
const EVAL_PATH_NEEDLE = '.agent-ui-eval';

function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { encoding: 'utf8', timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(String(stdout || '').trim());
    });
  });
}

async function count(script) {
  const out = await osascript(script).catch(() => '0');
  return Number(out.trim()) || 0;
}

function appleScriptString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function applicationIsRunning(appName) {
  const out = await osascript(`tell application "System Events" to return exists application process ${appleScriptString(appName)}`).catch(() => 'false');
  return String(out).trim().toLowerCase() === 'true';
}

async function previewCount() {
  if (!(await applicationIsRunning('Preview'))) return 0;
  return count(`
    tell application "Preview"
      set n to 0
      repeat with d in (documents as list)
        set matched to false
        try
          set docPath to (path of d as text)
          if docPath contains ${appleScriptString(EVAL_PATH_NEEDLE)} then set matched to true
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

async function chromeCount() {
  if (!(await applicationIsRunning('Google Chrome'))) return 0;
  return count(`
    tell application "Google Chrome"
      set n to 0
      repeat with w in (windows as list)
        repeat with t in (tabs of w)
          try
            set tabUrl to (URL of t as text)
            if tabUrl contains ${appleScriptString(EVAL_PATH_NEEDLE)} or tabUrl contains ${appleScriptString(DISPOSABLE_FILE_PREFIX)} then set n to n + 1
          end try
        end repeat
      end repeat
      return n
    end tell
  `);
}

async function garageBandCount() {
  if (!(await applicationIsRunning('GarageBand'))) return 0;
  return count(`
    tell application "GarageBand"
      set n to 0
      repeat with d in (documents as list)
        try
          set docName to (name of d as text)
          if docName starts with ${appleScriptString(DISPOSABLE_PREFIX)} or docName starts with ${appleScriptString(DISPOSABLE_FILE_PREFIX)} then set n to n + 1
        end try
      end repeat
      return n
    end tell
  `);
}

(async () => {
  const notes = await count(`tell application "Notes" to return count of (folders whose name starts with ${appleScriptString(DISPOSABLE_PREFIX)})`);
  const reminders = await count(`tell application "Reminders" to return count of (lists whose name starts with ${appleScriptString(DISPOSABLE_PREFIX)})`);
  const mail = await count(`tell application "Mail" to return count of (outgoing messages whose subject starts with ${appleScriptString(DISPOSABLE_PREFIX)})`);
  const preview = await previewCount();
  const chrome = await chromeCount();
  const garageBand = await garageBandCount();
  const total = notes + reminders + mail + preview + chrome + garageBand;
  if (total > 0) {
    console.error(`[no-leftovers] disposable app data remains: notes=${notes} reminders=${reminders} mail=${mail} preview=${preview} chrome=${chrome} garageBand=${garageBand}`);
    process.exit(1);
  }
  console.log('[no-leftovers] ok');
})().catch((e) => {
  console.error(`[no-leftovers] ${e.message}`);
  process.exit(1);
});
