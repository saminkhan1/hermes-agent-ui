'use strict';

const fs = require('fs');
const http = require('http');

function readEvalJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
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

function sendEvalJson(res, statusCode, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function writeEvalPortFile(port) {
  const file = String(process.env.AGENT_UI_EVAL_PORT_FILE || '').trim();
  if (!file) return;
  fs.writeFileSync(file, `${port}\n`, 'utf8');
}

function startAgentUIEvalServer(handlers, log = console) {
  if (process.env.AGENT_UI_EVAL !== '1') return null;

  const server = http.createServer(async (req, res) => {
    try {
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
      sendEvalJson(res, 500, { ok: false, error: (e && e.message) || String(e) });
    }
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

module.exports = {
  startAgentUIEvalServer,
};
