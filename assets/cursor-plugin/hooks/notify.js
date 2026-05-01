/**
 * POSTs to the agent-ui hook server and resolves when the request finishes
 * (response body drained, network error, or timeout). Callers must await before
 * process.exit so the TCP write is not torn down mid-flight.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getHookDebugLogPath() {
  return path.join(os.homedir(), '.agent-ui', 'hook-debug.log');
}

/**
 * @param {string} line
 */
function appendHookDebug(line) {
  try {
    const dir = path.join(os.homedir(), '.agent-ui');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(getHookDebugLogPath(), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // intentional no-op — hooks must never block Cursor on log failure
  }
}

function getIpcPath() {
  return path.join(os.homedir(), '.agent-ui', 'ipc.json');
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [payload]
 * @returns {Promise<void>}
 */
function notify(event, payload) {
  let ipc;
  try {
    ipc = JSON.parse(fs.readFileSync(getIpcPath(), 'utf8'));
  } catch {
    appendHookDebug(`ENTRY notify event=${event} ipcPath=${getIpcPath()} ipc=unreadable`);
    return Promise.resolve();
  }
  if (!ipc || !ipc.port || !ipc.token) {
    appendHookDebug(
      `ENTRY notify event=${event} ipcPath=${getIpcPath()} ipc=missing_fields port=${ipc && ipc.port}`
    );
    return Promise.resolve();
  }
  appendHookDebug(`ENTRY notify event=${event} ipcPath=${getIpcPath()} port=${ipc.port}`);
  const data = JSON.stringify({ event, token: ipc.token, payload: payload || {} });

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(ipc.port),
        path: '/event',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        appendHookDebug(`RESPONSE event=${event} status=${res.statusCode}`);
        res.on('end', finish);
        try {
          res.resume();
        } catch {
          finish();
        }
      }
    );
    req.on('error', (err) => {
      appendHookDebug(
        `ERROR event=${event} code=${err && err.code} message=${err && err.message}`
      );
      finish();
    });
    req.setTimeout(1000, () => {
      appendHookDebug(`TIMEOUT event=${event} ms=1000`);
      try {
        req.destroy();
      } catch {
        // ignore
      }
      finish();
    });
    appendHookDebug(`SEND event=${event} bytes=${Buffer.byteLength(data)}`);
    req.write(data);
    req.end();
  });
}

module.exports = { notify, getIpcPath, appendHookDebug };
