'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createControlServer } = require('../../src/main/control-server');

// A control server over a mutable recorder state whose commands drive the state
// transitions the real renderer would report back — so a POST resolves once the
// recorder actually reaches the target state.
function harness({ online = true, confirm = true } = {}) {
  const events = new EventEmitter();
  const commands = [];
  let state = { session: online ? 'online' : 'offline', recorder: { status: 'idle', muted: false } };
  const set = (next) => {
    state = { ...state, recorder: { ...state.recorder, ...next } };
    events.emit('state', state);
  };
  const control = createControlServer({
    port: 0,
    commandTimeoutMs: 400,
    getState: () => state,
    onCommand: (action) => {
      commands.push(action);
      if (!confirm) return;
      setImmediate(() => {
        if (action === 'start' || action === 'resume') set({ status: 'recording' });
        else if (action === 'stop') set({ status: 'idle' });
        else if (action === 'pause') set({ status: 'paused' });
        else if (action === 'mute') set({ muted: true });
        else if (action === 'unmute') set({ muted: false });
      });
    },
    events,
  });
  return { control, commands };
}

async function req(base, method, path) {
  const res = await fetch(base + path, { method });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

test('GET /status reports recorder state and each command awaits its target state', async (t) => {
  const h = harness();
  const addr = await h.control.start();
  t.after(() => h.control.close());
  const base = `http://127.0.0.1:${addr.port}`;

  assert.deepEqual((await req(base, 'GET', '/status')).body,
    { ok: true, recorder: 'idle', muted: false, online: true });

  assert.equal((await req(base, 'POST', '/start')).body.recorder, 'recording');
  assert.equal((await req(base, 'POST', '/pause')).body.recorder, 'paused');
  assert.equal((await req(base, 'POST', '/resume')).body.recorder, 'recording');
  assert.equal((await req(base, 'POST', '/mute')).body.muted, true);
  assert.equal((await req(base, 'POST', '/unmute')).body.muted, false);
  const stop = await req(base, 'POST', '/stop');
  assert.equal(stop.body.ok, true);
  assert.equal(stop.body.recorder, 'idle');
  assert.deepEqual(h.commands, ['start', 'pause', 'resume', 'mute', 'unmute', 'stop']);
});

test('unknown action is a 400 and never reaches the recorder', async (t) => {
  const h = harness();
  const addr = await h.control.start();
  t.after(() => h.control.close());
  const bad = await req(`http://127.0.0.1:${addr.port}`, 'POST', '/erase');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'bad_action');
  assert.deepEqual(h.commands, []);
});

test('commands are rejected 409 when the recorder is offline (auth mode, not activated)', async (t) => {
  const h = harness({ online: false });
  const addr = await h.control.start();
  t.after(() => h.control.close());
  const r = await req(`http://127.0.0.1:${addr.port}`, 'POST', '/start');
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'not_ready');
  assert.deepEqual(h.commands, []);
});

test('a command the recorder never confirms times out as 504', async (t) => {
  const h = harness({ confirm: false });
  const addr = await h.control.start();
  t.after(() => h.control.close());
  const r = await req(`http://127.0.0.1:${addr.port}`, 'POST', '/start');
  assert.equal(r.status, 504);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error.code, 'timeout');
  assert.deepEqual(h.commands, ['start']);
});

test('the API is open to any origin (no allowlist) and answers PNA preflight', async (t) => {
  const h = harness();
  const addr = await h.control.start();
  t.after(() => h.control.close());
  const base = `http://127.0.0.1:${addr.port}`;

  const cors = await req(base, 'GET', '/status');
  assert.equal(cors.headers.get('access-control-allow-origin'), '*');

  const preflight = await fetch(`${base}/start`, {
    method: 'OPTIONS',
    headers: { Origin: 'null', 'Access-Control-Request-Private-Network': 'true' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
});
