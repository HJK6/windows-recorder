'use strict';

/*
 * mock-ws-server.js — TEST-ONLY in-tree stand-in for the AWS API Gateway
 * WebSocket API. It lets the desktop WS client be exercised end to end in plain
 * Node with no AWS. It is never imported by the packaged app (src/**), so the
 * workstation still has no listener; this server only ever runs inside tests.
 *
 * It mirrors the server contract the real Lambdas implement:
 *  - $connect authorizer: validate the Bearer device token (signature, exp,
 *    scope=device) and reject otherwise (tests the auth-denial proof).
 *  - on `hello`     -> reply `welcome` with CURRENT desired state only.
 *  - on `heartbeat` -> reply `heartbeat.ack`.
 *  - on `command.ack` -> record it (tests assert APPLIED acks).
 *  - sendCommand(...) -> push a `recording.setDesiredState` command down.
 */

const { WebSocketServer } = require('ws');
const { EventEmitter } = require('node:events');
const jwt = require('../../src/shared/jwt');

function createMockWsServer({ secret, requireScope = 'device' } = {}) {
  const emitter = new EventEmitter();
  const acks = [];
  const hellos = [];
  const heartbeats = [];
  let welcomeRecordings = []; // what the next `welcome` advertises as desired
  let revision = 0;
  let sockets = new Set();

  let resolveReady;
  const readyPromise = new Promise((r) => { resolveReady = r; });

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient(info, cb) {
      // Emulate the $connect Lambda authorizer.
      const header = info.req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const result = jwt.verify(token, secret);
      if (!result.valid) { cb(false, 401, 'Unauthorized'); return; }
      if (requireScope && !jwt.hasScope(result.payload, requireScope)) {
        cb(false, 403, 'Forbidden'); return;
      }
      info.req.deviceId = result.payload.sub;
      cb(true);
    },
  });

  wss.on('listening', () => resolveReady());

  wss.on('connection', (socket, req) => {
    socket.deviceId = req.deviceId;
    sockets.add(socket);
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      switch (msg.type) {
        case 'hello':
          hellos.push(msg);
          socket.send(JSON.stringify({
            type: 'welcome',
            serverTime: new Date().toISOString(),
            recordings: welcomeRecordings,
          }));
          emitter.emit('hello', msg);
          break;
        case 'heartbeat':
          heartbeats.push(msg);
          socket.send(JSON.stringify({ type: 'heartbeat.ack', serverTime: new Date().toISOString() }));
          break;
        case 'command.ack':
          acks.push(msg);
          emitter.emit('ack', msg);
          break;
        default:
          break;
      }
    });
    socket.on('close', () => sockets.delete(socket));
    emitter.emit('connection', socket);
  });

  function broadcast(obj) {
    const str = JSON.stringify(obj);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(str);
  }

  return {
    emitter,
    acks,
    hellos,
    heartbeats,
    ready: () => readyPromise,
    get connections() { return sockets.size; },
    url() { return `ws://127.0.0.1:${wss.address().port}`; },
    setWelcomeRecordings(list) { welcomeRecordings = list; },
    // Push a desired-state command to the connected desktop.
    sendCommand(desiredState, { recordingId, revision: rev } = {}) {
      revision = rev != null ? rev : revision + 1;
      broadcast({
        type: 'command',
        command: {
          type: 'recording.setDesiredState',
          commandId: `cmd-${recordingId}-${revision}`,
          recordingId,
          revision,
          desiredState,
          issuedAt: new Date().toISOString(),
        },
      });
      return revision;
    },
    // Wait for the next ack (optionally matching a predicate).
    waitForAck(pred = () => true, timeoutMs = 5000) {
      const existing = acks.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { emitter.off('ack', onAck); reject(new Error('ack timeout')); }, timeoutMs);
        function onAck(a) { if (pred(a)) { clearTimeout(timer); emitter.off('ack', onAck); resolve(a); } }
        emitter.on('ack', onAck);
      });
    },
    dropAll() { for (const s of sockets) s.terminate(); sockets = new Set(); },
    close() { return new Promise((resolve) => wss.close(resolve)); },
  };
}

module.exports = { createMockWsServer };
