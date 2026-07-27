'use strict';

const http = require('node:http');

const ACTIONS = new Set(['start', 'stop', 'pause', 'resume', 'mute', 'unmute']);

// The state a given command is trying to bring the recorder to. A POST resolves
// only once the recorder has actually reached it (or the wait times out).
function reached(action, state) {
  const status = state.recorder.status;
  const muted = Boolean(state.recorder.muted);
  switch (action) {
    case 'start': return status === 'recording';
    case 'stop': return status === 'idle';
    case 'pause': return status === 'paused';
    case 'resume': return status === 'recording';
    case 'mute': return muted;
    case 'unmute': return !muted;
    default: return false;
  }
}

function summary(state) {
  return {
    recorder: state.recorder.status,
    muted: Boolean(state.recorder.muted),
    online: state.session === 'online',
  };
}

// Loopback HTTP control API driving the desktop recorder. No auth, open to any
// origin (loopback-only). Request/response only — no WebSocket, no server push.
function createControlServer({
  host = '127.0.0.1', port = 18765, getState, onCommand, events, commandTimeoutMs = 3000,
}) {
  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Origin');
  }
  function json(res, status, body) {
    cors(res);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  }

  // Resolves true once the recorder reaches the action's target state, false on
  // timeout. Returns a canceler so the caller can tear it down if the command
  // could not even be issued (avoids a leaked listener + a full-timeout stall).
  function awaitState(action) {
    let settle;
    let timer;
    const promise = new Promise((resolve) => { settle = resolve; });
    const onState = (state) => { if (reached(action, state)) finish(true); };
    const finish = (ok) => { clearTimeout(timer); events.off('state', onState); settle(ok); };
    timer = setTimeout(() => finish(false), commandTimeoutMs);
    events.on('state', onState);
    return { promise, cancel: () => finish(false) };
  }

  async function handleCommand(action, res) {
    if (!ACTIONS.has(action)) {
      json(res, 400, { ok: false, error: { code: 'bad_action', message: 'unsupported action' } });
      return;
    }
    if (getState().session !== 'online') {
      json(res, 409, { ok: false, error: { code: 'not_ready', message: 'recorder is offline' } });
      return;
    }
    if (reached(action, getState())) {
      json(res, 200, { ok: true, ...summary(getState()) });
      return;
    }
    const waiter = awaitState(action);
    try {
      onCommand(action);
    } catch (_) {
      waiter.cancel();
      json(res, 503, { ok: false, error: { code: 'recorder_unavailable', message: 'recorder is not ready' } });
      return;
    }
    const ok = await waiter.promise;
    json(res, ok ? 200 : 504, {
      ok,
      ...(ok ? {} : { error: { code: 'timeout', message: 'recorder did not confirm the command' } }),
      ...summary(getState()),
    });
  }

  const server = http.createServer((req, res) => {
    const route = (req.url || '/').split('?')[0];
    if (req.method === 'OPTIONS') {
      cors(res);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      // Private Network Access preflight: a file:// / public-origin page reaching
      // loopback needs this echoed back or Chrome/Edge blocks the request.
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === 'GET' && route === '/status') {
      json(res, 200, { ok: true, ...summary(getState()) });
      return;
    }
    if (req.method === 'POST' && route.length > 1) {
      handleCommand(route.slice(1), res)
        .catch(() => json(res, 500, { ok: false, error: { code: 'internal', message: 'command failed' } }));
      return;
    }
    json(res, 404, { ok: false, error: { code: 'not_found', message: 'unknown route' } });
  });

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    address: () => server.address(),
  };
}

module.exports = { ACTIONS, createControlServer };
