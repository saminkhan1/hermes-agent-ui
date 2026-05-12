'use strict';

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';

function evalToken() {
  return String(process.env.AGENT_UI_EVAL_TOKEN || '').trim();
}

function safeCompare(a: LooseBoundaryValue, b: LooseBoundaryValue) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function readEvalJson(req: LooseBoundaryValue) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: LooseBoundaryValue) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendEvalJson(res: LooseBoundaryValue, statusCode: LooseBoundaryValue, payload: LooseBoundaryValue) {
  const text = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function writeEvalPortFile(port: LooseBoundaryValue) {
  const file = String(process.env.AGENT_UI_EVAL_PORT_FILE || '').trim();
  if (!file) return;
  fs.writeFileSync(file, `${port}\n`, 'utf8');
}

function requestAuthorized(req: LooseBoundaryValue) {
  const token = evalToken();
  if (!token) return false;
  const header = String((req.headers && req.headers.authorization) || '').trim();
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return safeCompare(header.slice(prefix.length).trim(), token);
}

async function handleEvalRequest(req: LooseBoundaryValue, res: LooseBoundaryValue, handlers: LooseBoundaryValue) {
  try {
    if (!requestAuthorized(req)) {
      sendEvalJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      sendEvalJson(res, 200, { ok: true, app: 'agent-UI', eval: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/conversation') {
      sendEvalJson(res, 200, await handlers.getConversation(url.searchParams.get('catId')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/conversations') {
      sendEvalJson(res, 200, await handlers.listConversations());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/ui-targets') {
      sendEvalJson(res, 200, await handlers.getUiTargets());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/start') {
      sendEvalJson(res, 200, await handlers.start(await readEvalJson(req)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/open-launcher') {
      sendEvalJson(res, 200, await handlers.openLauncher(await readEvalJson(req)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/followup') {
      sendEvalJson(res, 200, await handlers.followup(await readEvalJson(req)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/cancel') {
      sendEvalJson(res, 200, await handlers.cancel(await readEvalJson(req)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/open-conversation') {
      sendEvalJson(res, 200, await handlers.openConversation(await readEvalJson(req)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/set-input-mode') {
      sendEvalJson(res, 200, await handlers.setInputMode(await readEvalJson(req)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/wait') {
      sendEvalJson(res, 200, await handlers.wait(await readEvalJson(req)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/trace') {
      sendEvalJson(res, 200, await handlers.getTrace());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/close-modal') {
      sendEvalJson(res, 200, await handlers.closeModal());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/dismiss') {
      sendEvalJson(res, 200, await handlers.dismiss(await readEvalJson(req)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      sendEvalJson(res, 200, { ok: true });
      setTimeout(() => handlers.shutdown(), 25);
      return;
    }
    sendEvalJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    sendEvalJson(res, 500, { ok: false, error: e instanceof Error && e.message ? e.message : String(e) });
  }
}

function startAgentUIEvalServer(handlers: LooseBoundaryValue, log = console) {
  if (process.env.AGENT_UI_EVAL !== '1') return null;
  if (!evalToken()) {
    log.warn('[agent-ui] eval server disabled: AGENT_UI_EVAL_TOKEN is required.');
    return null;
  }

  const server = http.createServer((req: LooseBoundaryValue, res: LooseBoundaryValue) => {
    void handleEvalRequest(req, res, handlers);
  });

  const port = Number(process.env.AGENT_UI_EVAL_PORT || 0);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    writeEvalPortFile(actualPort);
    log.log(`[agent-ui] eval server listening on http://127.0.0.1:${actualPort}`);
  });

  return {
    closeSync() {
      try {
        server.close();
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

export { startAgentUIEvalServer };
