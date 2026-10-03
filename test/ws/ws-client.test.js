'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createMockWsServer } = require('./mock-ws-server');
const { createWsClient } = require('../../src/main/ws-client');
const { createStaticIdentity } = require('../../src/main/identity');
const jwt = require('../../src/shared/jwt');

const SECRET = 'test-signing-secret';
const deviceToken = (opts = {}) => jwt.sign({ sub: 'test-device', scope: 'device' }, SECRET, opts);

// Build a WS client wired to a fake recorder that moves the observed status
// forward on the next tick (standing in for the renderer's IPC reports).
function makeClient(server, { token = deviceToken(), overrides = {} } = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let state = { recorder: { status: 'idle', muted: false }, session: 'online' };
  const relayCalls = [];
  const setStatus = (status) => {
    state = { recorder: { status, muted: false }, session: 'online' };
    events.emit('state', state);
  };
  const relay = (action) => {
    relayCalls.push(action);
    setImmediate(() => {
      if (action === 'start' || action === 'resume') setStatus('recording');
      else if (action === 'pause') setStatus('paused');
      else if (action === 'stop') setStatus('idle');
    });
  };
  const client = createWsClient({
    wsUrl: server.url(),
    identity: createStaticIdentity(token),
    getState: () => state,
    relay,
    events,
    WebSocketImpl: WebSocket,
    commandTimeoutMs: 3000,
    heartbeat: { idleMs: 100000, activeMs: 100000 },
    backoff: { baseMs: 10, capMs: 30 },
    healthyResetMs: 5,
    ...overrides,
  });
  return { client, events, relayCalls, getStatus: () => state.recorder.status };
}

function onceEmitter(emitter, name, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    emitter.once(name, (x) => { clearTimeout(timer); resolve(x); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('hello handshake + start/pause/resume/stop each applies and acks APPLIED', async (t) => {
  const server = createMockWsServer({ secret: SECRET });
  await server.ready();
  const h = makeClient(server);
  t.after(async () => { h.client.stop(); await server.close(); });

  h.client.start();
  await onceEmitter(server.emitter, 'hello');

  server.sendCommand('RECORDING', { recordingId: 'rec1', revision: 1 });
  const a1 = await server.waitForAck((a) => a.revision === 1);
  assert.equal(a1.status, 'APPLIED');
  assert.equal(a1.observedState, 'RECORDING');

  server.sendCommand('PAUSED', { recordingId: 'rec1', revision: 2 });
  assert.equal((await server.waitForAck((a) => a.revision === 2)).observedState, 'PAUSED');

  server.sendCommand('RECORDING', { recordingId: 'rec1', revision: 3 }); // resume
  assert.equal((await server.waitForAck((a) => a.revision === 3)).observedState, 'RECORDING');

  server.sendCommand('STOPPED', { recordingId: 'rec1', revision: 4 });
  const a4 = await server.waitForAck((a) => a.revision === 4);
  assert.equal(a4.status, 'APPLIED');
  assert.equal(a4.observedState, 'IDLE');

  assert.deepEqual(h.relayCalls, ['start', 'pause', 'resume', 'stop']);
});

test('expired device token is denied at connect (no channel, no ack)', async (t) => {
  const server = createMockWsServer({ secret: SECRET });
  await server.ready();
  const h = makeClient(server, {
    token: deviceToken({ expiresInSec: -10 }),
    overrides: { backoff: { baseMs: 10000, capMs: 10000 } },
  });
  t.after(async () => { h.client.stop(); await server.close(); });

  h.client.start();
  await sleep(400);
  assert.equal(server.connections, 0, 'server rejects the expired token at $connect');
  assert.equal(h.client.isReady(), false);
  assert.equal(h.relayCalls.length, 0);
});

test('wrong-scope token is denied at connect', async (t) => {
  const server = createMockWsServer({ secret: SECRET, requireScope: 'device' });
  await server.ready();
  const h = makeClient(server, {
    token: jwt.sign({ sub: 'x', scope: 'control' }, SECRET),
    overrides: { backoff: { baseMs: 10000, capMs: 10000 } },
  });
  t.after(async () => { h.client.stop(); await server.close(); });

  h.client.start();
  await sleep(400);
  assert.equal(server.connections, 0);
  assert.equal(h.client.isReady(), false);
});

test('reconnect after a drop does not restart the encoder or duplicate capture', async (t) => {
  const server = createMockWsServer({ secret: SECRET });
  await server.ready();
  const h = makeClient(server);
  t.after(async () => { h.client.stop(); await server.close(); });

  h.client.start();
  await onceEmitter(server.emitter, 'hello');
  server.sendCommand('RECORDING', { recordingId: 'rec9', revision: 1 });
  await server.waitForAck((a) => a.recordingId === 'rec9' && a.status === 'APPLIED');
  assert.equal(h.getStatus(), 'recording');
  assert.deepEqual(h.relayCalls, ['start']);

  // Same desired state advertised on reconnect; then force-drop the socket.
  server.setWelcomeRecordings([{ recordingId: 'rec9', revision: 1, desiredState: 'RECORDING' }]);
  const reHello = onceEmitter(server.emitter, 'hello');
  server.dropAll();
  await reHello;
  await sleep(150);

  assert.equal(h.getStatus(), 'recording', 'still recording across the drop');
  assert.deepEqual(h.relayCalls, ['start'], 'start is not relayed a second time');
  const recAcks = server.acks.filter((a) => a.recordingId === 'rec9');
  assert.ok(recAcks.length >= 1 && recAcks.every((a) => a.status === 'APPLIED'));
});

test('duplicate/stale command (<= applied revision) is idempotent — no re-apply', async (t) => {
  const server = createMockWsServer({ secret: SECRET });
  await server.ready();
  const h = makeClient(server);
  t.after(async () => { h.client.stop(); await server.close(); });

  h.client.start();
  await onceEmitter(server.emitter, 'hello');
  server.sendCommand('RECORDING', { recordingId: 'recX', revision: 5 });
  await server.waitForAck((a) => a.revision === 5 && a.status === 'APPLIED');

  server.sendCommand('RECORDING', { recordingId: 'recX', revision: 5 }); // duplicate
  server.sendCommand('RECORDING', { recordingId: 'recX', revision: 3 }); // stale
  await sleep(150);
  assert.deepEqual(h.relayCalls, ['start'], 'no re-apply for duplicate/stale revisions');
});
