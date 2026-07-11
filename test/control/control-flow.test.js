'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const Session = require('../../src/shared/sessionState');
const { createControlServer } = require('../../src/main/control-server');
const { createActivationClient } = require('../../src/main/activation');
const { createMockBackend } = require('../../mocks/backend/server');

const allowedOrigin = 'http://127.0.0.1:8788';

function nextMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), 3000);
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', listener);
      resolve(message);
    };
    ws.on('message', listener);
  });
}

function openSocket(url, origin = allowedOrigin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function options(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'OPTIONS', path: '/',
      headers: {
        Origin: allowedOrigin,
        'Access-Control-Request-Private-Network': 'true',
      },
    }, (res) => {
      res.resume();
      res.once('end', () => resolve(res));
    });
    req.once('error', reject);
    req.end();
  });
}

test('control channel is fail-closed, activates, rejects bad origins, and answers PNA', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-control-'));
  const backend = createMockBackend({ port: 0, dataDir });
  await backend.start();
  t.after(async () => { await backend.close(); await fs.rm(dataDir, { recursive: true }); });

  const client = createActivationClient({ baseUrl: backend.baseUrl });
  const events = new EventEmitter();
  const commands = [];
  let releaseActivation = null;
  let state = Session.initialState();
  const publish = (event) => {
    state = Session.reduce(state, event);
    events.emit('state', state);
  };
  const control = createControlServer({
    port: 0,
    allowedOrigins: [allowedOrigin],
    getState: () => state,
    onCommand: (action) => commands.push(action),
    onActivate: async (message) => {
      if (!Session.canActivate(state)) {
        const error = new Error('activation already in progress');
        error.code = 'already_activated';
        throw error;
      }
      publish({ type: 'ACTIVATE_START' });
      if (message.flexToken === 'mock-flex-slow') {
        await new Promise((resolve) => { releaseActivation = resolve; });
      }
      const result = await client.validateFlexToken(message.flexToken);
      publish({
        type: 'ACTIVATE_SUCCESS', identity: result.identity, sessionId: result.sessionId,
      });
    },
    onDeactivate: async () => publish({ type: 'DEACTIVATE' }),
    events,
  });
  const address = await control.start();
  assert.equal(address.address, '127.0.0.1');
  t.after(() => control.close());
  const url = `ws://127.0.0.1:${address.port}`;
  const ws = await openSocket(url);
  t.after(() => ws.close());
  const ws2 = await openSocket(url);
  t.after(() => ws2.close());

  const initialState = nextMessage(ws, (message) => message.type === 'state' && message.session === 'offline');
  ws.send(JSON.stringify({ v: 1, type: 'status', requestId: 'status' }));
  assert.equal((await initialState).session, 'offline');
  const offlineAck = nextMessage(ws, (message) => message.type === 'ack' && message.requestId === 'offline');
  ws.send(JSON.stringify({ v: 1, type: 'command', action: 'start', requestId: 'offline' }));
  assert.equal((await offlineAck).error.code, 'not_activated');
  assert.deepEqual(commands, []);

  const onlineState = nextMessage(ws, (message) => message.type === 'state' && message.session === 'online');
  const onlineState2 = nextMessage(ws2, (message) => message.type === 'state' && message.session === 'online');
  const activateAck = nextMessage(ws, (message) => message.type === 'ack' && message.requestId === 'activate');
  ws.send(JSON.stringify({
    v: 1, type: 'activate', requestId: 'activate', flexToken: 'mock-flex-demo',
    context: { recordingKind: 'call' },
  }));
  assert.equal((await onlineState).identity.email, 'demo@example.invalid');
  assert.equal((await onlineState2).identity.email, 'demo@example.invalid');
  assert.equal((await activateAck).ok, true);

  const activatingState = nextMessage(ws, (message) => message.type === 'state' && message.session === 'activating');
  const slowOnline = nextMessage(ws, (message) => message.type === 'state'
    && message.session === 'online' && message.identity.agentId === 'mock-agent-slow');
  const slowAck = nextMessage(ws, (message) => message.type === 'ack' && message.requestId === 'slow');
  ws.send(JSON.stringify({
    v: 1, type: 'activate', requestId: 'slow', flexToken: 'mock-flex-slow',
    context: { recordingKind: 'call' },
  }));
  await activatingState;
  const racingAck = nextMessage(ws, (message) => message.type === 'ack' && message.requestId === 'racing');
  ws.send(JSON.stringify({
    v: 1, type: 'activate', requestId: 'racing', flexToken: 'mock-flex-racing',
    context: { recordingKind: 'video' },
  }));
  assert.equal((await racingAck).error.code, 'already_activated');
  releaseActivation();
  assert.equal((await slowOnline).sessionId, state.sessionId);
  assert.equal((await slowAck).ok, true);

  const event1 = nextMessage(ws, (message) => message.type === 'event' && message.event === 'activated');
  const event2 = nextMessage(ws2, (message) => message.type === 'event' && message.event === 'activated');
  events.emit('event', { event: 'activated', data: { source: 'test' } });
  assert.equal((await event1).data.source, 'test');
  assert.equal((await event2).data.source, 'test');

  for (const action of ['start', 'stop', 'pause', 'resume', 'mute', 'unmute']) {
    const actionAck = nextMessage(ws, (message) => message.type === 'ack' && message.requestId === action);
    ws.send(JSON.stringify({ v: 1, type: 'command', action, requestId: action }));
    assert.equal((await actionAck).ok, true);
  }
  assert.deepEqual(commands, ['start', 'stop', 'pause', 'resume', 'mute', 'unmute']);

  const badAck = nextMessage(ws, (message) => message.type === 'ack' && message.requestId === 'bad');
  ws.send(JSON.stringify({ v: 1, type: 'command', action: 'erase', requestId: 'bad' }));
  assert.equal((await badAck).error.code, 'bad_action');

  await assert.rejects(openSocket(url, 'https://not-allowed.invalid'));
  const pna = await options(address.port);
  assert.equal(pna.statusCode, 204);
  assert.equal(pna.headers['access-control-allow-private-network'], 'true');
  assert.equal(pna.headers['access-control-allow-origin'], allowedOrigin);
});

test('synthetic recording bytes use only the minted token and server-derived fields', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-activation-'));
  const backend = createMockBackend({ port: 0, dataDir });
  await backend.start();
  t.after(async () => { await backend.close(); await fs.rm(dataDir, { recursive: true }); });

  const client = createActivationClient({ baseUrl: backend.baseUrl });
  const session = await client.validateFlexToken('mock-flex-upload');
  const bytes = Buffer.from('synthetic-webm-bytes');
  const meta = {
    recordingId: 'recording-1234',
    startedAt: 1000,
    endedAt: 2500,
    durationMs: 1500,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  const result = await client.processRecording({
    session,
    buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    meta,
    context: { recordingKind: 'call', identity: { email: 'ignored@example.invalid' } },
  });

  const presign = backend.observations.find((entry) => entry.route === 'presign');
  const metadata = backend.observations.find((entry) => entry.route === 'metadata');
  assert.equal(presign.authorization, `Bearer ${session.sessionToken}`);
  assert.equal(metadata.authorization, `Bearer ${session.sessionToken}`);
  assert.equal(presign.authorization.includes('mock-flex-'), false);
  assert.match(result.objectKey, new RegExp(`^recordings/healthfirst/${session.sessionId}/recording-1234-`));

  const uploaded = await fs.readFile(path.join(dataDir, 'mock-s3', ...result.objectKey.split('/')));
  assert.deepEqual(uploaded, bytes);
  const rows = (await fs.readFile(path.join(dataDir, 'mock-dynamo.jsonl'), 'utf8')).trim().split('\n');
  const row = JSON.parse(rows.at(-1));
  assert.equal(row.recordingId, meta.recordingId);
  assert.equal(row.identity.agentId, session.identity.agentId);
  assert.notEqual(row.identity.email, 'ignored@example.invalid');
  assert.equal(row.context.identity, undefined);

  const otherSession = await client.validateFlexToken('mock-flex-other');
  const otherPresignResponse = await fetch(`${backend.baseUrl}/uploads/presign`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${otherSession.sessionToken}`,
    },
    body: JSON.stringify({ recordingId: 'foreign-recording' }),
  });
  const otherPresign = await otherPresignResponse.json();
  const crossSession = await fetch(`${backend.baseUrl}/metadata`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.sessionToken}`,
    },
    body: JSON.stringify({ recordingId: 'foreign-recording', objectKey: otherPresign.objectKey }),
  });
  assert.equal(crossSession.status, 403);

  const arbitraryKey = await fetch(`${backend.baseUrl}/metadata`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.sessionToken}`,
    },
    body: JSON.stringify({ recordingId: 'foreign-recording', objectKey: 'recordings/healthfirst/other/foreign.webm' }),
  });
  assert.equal(arbitraryKey.status, 400);

  let localSave = null;
  const localClient = createActivationClient({
    baseUrl: backend.baseUrl,
    saveLocal: async (buffer, recordingId) => {
      localSave = { sizeBytes: Buffer.from(buffer).byteLength, recordingId };
      return { path: '/synthetic/local.webm' };
    },
  });
  const localResult = await localClient.processRecording({
    session,
    buffer: bytes,
    meta: { ...meta, recordingId: 'local-copy' },
    context: { recordingKind: 'call' },
  });
  assert.deepEqual(localSave, { sizeBytes: bytes.byteLength, recordingId: 'local-copy' });
  assert.equal(localResult.local.path, '/synthetic/local.webm');

  const derivedResponse = await fetch(`${backend.baseUrl}/uploads/presign`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.sessionToken}`,
    },
    body: JSON.stringify({ sessionId: 'client-chosen-session', recordingId: 'derived-check' }),
  });
  const derived = await derivedResponse.json();
  assert.equal(derivedResponse.status, 200);
  assert.match(derived.objectKey, new RegExp(`^recordings/healthfirst/${session.sessionId}/derived-check-`));
  assert.equal(derived.objectKey.includes('client-chosen-session'), false);

  for (const route of ['uploads/presign', 'metadata']) {
    for (const token of [null, 'mock-flex-upload']) {
      const response = await fetch(`${backend.baseUrl}/${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ recordingId: 'unauthorized' }),
      });
      assert.equal(response.status, 401);
    }
  }
});
