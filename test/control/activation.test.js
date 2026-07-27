'use strict';

// Retained token-activation / upload path. This exercises the activation client
// against the mock backend directly — transport-independent, so it stays valid
// after the loopback control channel moved from WebSocket to HTTP. It is the unit
// coverage guaranteeing the auth path still works when re-enabled (HF_AUTH=1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createActivationClient } = require('../../src/main/activation');
const { createMockBackend } = require('../../mocks/backend/server');

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
