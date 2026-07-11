'use strict';

const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');

const ACTIONS = new Set(['start', 'stop', 'pause', 'resume', 'mute', 'unmute']);

function createControlServer({
  host = '127.0.0.1', port = 8765, allowedOrigins = [], getState,
  onCommand, onActivate, onDeactivate, events,
}) {
  const origins = new Set(allowedOrigins);
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (req.method === 'OPTIONS' && origins.has(origin)) {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!origins.has(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, payload) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, ...payload }));
  };
  const broadcast = (payload) => {
    for (const ws of wss.clients) send(ws, payload);
  };
  const ack = (ws, requestId, ok, error) => {
    if (requestId == null) return;
    send(ws, { type: 'ack', requestId, ok, ...(error ? { error } : {}) });
  };

  async function handle(ws, raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch (_) { return; }
    if (message.v !== 1) return;

    if (message.type === 'status') {
      ack(ws, message.requestId, true);
      send(ws, { type: 'state', ...getState() });
      return;
    }
    if (message.type === 'command') {
      if (!ACTIONS.has(message.action)) {
        ack(ws, message.requestId, false, { code: 'bad_action', message: 'unsupported action' });
        return;
      }
      if (getState().session !== 'online') {
        ack(ws, message.requestId, false, { code: 'not_activated', message: 'recorder is offline' });
        return;
      }
      onCommand(message.action, { requestId: message.requestId });
      ack(ws, message.requestId, true);
      return;
    }
    if (message.type === 'activate') {
      try {
        await onActivate(message);
        ack(ws, message.requestId, true);
      } catch (error) {
        const code = error.code || 'activation_failed';
        ack(ws, message.requestId, false, { code, message: error.message });
      }
      return;
    }
    if (message.type === 'deactivate') {
      await onDeactivate();
      ack(ws, message.requestId, true);
    }
  }

  wss.on('connection', (ws) => {
    send(ws, { type: 'state', ...getState() });
    ws.on('message', (raw) => { handle(ws, raw).catch(() => {}); });
  });

  const onState = (state) => broadcast({ type: 'state', ...state });
  const onEvent = (event) => broadcast({ type: 'event', ...event });
  events.on('state', onState);
  events.on('event', onEvent);

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      events.off('state', onState);
      events.off('event', onEvent);
      for (const ws of wss.clients) ws.close();
      await new Promise((resolve) => wss.close(() => server.close(resolve)));
    },
    address: () => server.address(),
  };
}

module.exports = { ACTIONS, createControlServer };
