'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const Session = require('../../src/shared/sessionState');
const { createControlServer } = require('../../src/main/control-server');

function nextMessage(ws, predicate) {
  return new Promise((resolve) => ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (predicate(message)) resolve(message);
  }));
}

async function connect(state, commands) {
  const origin = 'http://127.0.0.1:8788';
  const control = createControlServer({
    port: 0,
    allowedOrigins: [origin],
    getState: () => state,
    onCommand: (action) => commands.push(action),
    onActivate: async () => {},
    onDeactivate: async () => {},
    events: new EventEmitter(),
  });
  const address = await control.start();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`, { origin });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, control };
}

test('control channel accepts no-token commands only in explicit demo state', async (t) => {
  const commands = [];
  const demo = await connect(Session.initialState({ demoMode: true }), commands);
  t.after(() => demo.control.close());
  const demoAck = nextMessage(demo.ws, (message) => message.type === 'ack');
  demo.ws.send(JSON.stringify({ v: 1, type: 'command', action: 'start', requestId: 'demo' }));
  assert.equal((await demoAck).ok, true);
  assert.deepEqual(commands, ['start']);

  const normal = await connect(Session.initialState(), commands);
  t.after(() => normal.control.close());
  const normalAck = nextMessage(normal.ws, (message) => message.type === 'ack');
  normal.ws.send(JSON.stringify({ v: 1, type: 'command', action: 'start', requestId: 'normal' }));
  const rejected = await normalAck;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'not_activated');
  assert.deepEqual(commands, ['start']);
});
