'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');

function getIpcFilePath() {
  const dir = path.join(os.homedir(), '.agent-ui');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return path.join(dir, 'ipc.json');
}

/**
 * @param {{ onIdeSessionStart?: (p: object) => void, onIdeSessionEnd?: (p: object) => void, log?: Console }} options
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function startHookServer(options = {}) {
  const { onIdeSessionStart, onIdeSessionEnd, log = console } = options;
  const serverToken = randomBytes(32).toString('hex');
  const ipcFilePath = getIpcFilePath();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/event') {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let json;
        try {
          const body = Buffer.concat(chunks).toString('utf8') || '{}';
          json = JSON.parse(body);
        } catch (e) {
          log.warn('[agent-ui] hook server: bad JSON', e);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        const eventName = json && typeof json === 'object' ? json.event : undefined;
        log.log('[agent-ui] hook event received:', eventName);
        if (json == null || typeof json !== 'object' || json.token !== serverToken) {
          log.log('[agent-ui] hook event rejected: bad token');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        const event = json.event;
        const payload = json.payload && typeof json.payload === 'object' ? json.payload : {};
        try {
          if (event === 'ide-session-start' && typeof onIdeSessionStart === 'function') {
            const sid = payload && payload.session_id != null ? String(payload.session_id) : '';
            log.log('[agent-ui] dispatching ide-session-start session=', sid);
            onIdeSessionStart(payload);
          } else if (event === 'ide-session-end' && typeof onIdeSessionEnd === 'function') {
            const sid = payload && payload.session_id != null ? String(payload.session_id) : '';
            log.log('[agent-ui] dispatching ide-session-end session=', sid);
            onIdeSessionEnd(payload);
          }
        } catch (e) {
          log.warn('[agent-ui] hook handler error', e);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });

    server.on('error', (e) => {
      log.warn('[agent-ui] hook server error', e);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      try {
        const record = { port, token: serverToken, pid: process.pid, updated: new Date().toISOString() };
        fs.writeFileSync(ipcFilePath, JSON.stringify(record, null, 2), { mode: 0o600 });
        try {
          fs.chmodSync(ipcFilePath, 0o600);
        } catch {
          // ignore
        }
      } catch (e) {
        log.warn('[agent-ui] could not write ipc.json', e);
        server.close();
        reject(e);
        return;
      }
      const closeSync = () => {
        try {
          server.close();
        } catch (e) {
          log.warn('[agent-ui] hook server close', e);
        }
        try {
          if (fs.existsSync(ipcFilePath)) {
            fs.unlinkSync(ipcFilePath);
          }
        } catch (e) {
          log.warn('[agent-ui] could not remove ipc.json', e);
        }
      };
      resolve({ port, closeSync });
    });
  });
}

module.exports = { startHookServer, getIpcFilePath };
