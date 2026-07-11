'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function createMockBackend({
  host = '127.0.0.1', port = Number(process.env.MOCK_BACKEND_PORT || 8787),
  dataDir = process.env.MOCK_BACKEND_DATA_DIR || path.join(__dirname, '.data'),
  tenant = process.env.HF_TENANT || 'healthfirst',
} = {}) {
  const sessions = new Map();
  const presigns = new Map();
  const observations = [];
  let baseUrl = null;

  function authorize(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    return { header, session: sessions.get(token) || null };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, baseUrl || `http://${host}`);
      if (req.method === 'POST' && url.pathname === '/flex/validate') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        observations.push({ route: 'validate', flexToken: body.flexToken });
        if (typeof body.flexToken !== 'string' || !body.flexToken.startsWith('mock-flex-')) {
          sendJson(res, 401, { valid: false, error: 'invalid_flex_token' });
          return;
        }
        const delay = /^mock-flex-delay(\d+)-/.exec(body.flexToken);
        if (delay) await new Promise((resolve) => setTimeout(resolve, Math.min(Number(delay[1]), 2000)));
        const agent = body.flexToken.slice('mock-flex-'.length).replace(/[^a-z0-9_-]/gi, '') || 'agent';
        const sessionToken = `mock-session-${crypto.randomUUID()}`;
        const sessionId = crypto.randomUUID();
        const identity = {
          agentId: `mock-agent-${agent}`,
          email: `${agent}@example.invalid`,
          phone: '+15550100000',
          roles: ['agent'],
        };
        sessions.set(sessionToken, { identity, sessionId });
        sendJson(res, 200, {
          valid: true, identity, sessionToken, sessionId,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/uploads/presign') {
        const auth = authorize(req);
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        observations.push({ route: 'presign', authorization: auth.header, body });
        if (!auth.session) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const recordingId = String(body.recordingId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
        if (!recordingId) {
          sendJson(res, 400, { error: 'recording_id_required' });
          return;
        }
        const objectKey = `recordings/${tenant}/${auth.session.sessionId}/${recordingId}-${Date.now()}.webm`;
        presigns.set(objectKey, {
          sessionId: auth.session.sessionId,
          recordingId,
          uploaded: false,
        });
        sendJson(res, 200, {
          method: 'PUT',
          url: `${baseUrl}/uploads/put/${encodeURIComponent(objectKey)}`,
          objectKey,
          headers: {},
        });
        return;
      }

      if (req.method === 'PUT' && url.pathname.startsWith('/uploads/put/')) {
        const objectKey = decodeURIComponent(url.pathname.slice('/uploads/put/'.length));
        if (!objectKey.startsWith(`recordings/${tenant}/`) || objectKey.includes('..')) {
          sendJson(res, 400, { error: 'bad_object_key' });
          return;
        }
        const issued = presigns.get(objectKey);
        if (!issued) {
          sendJson(res, 404, { error: 'unknown_presign' });
          return;
        }
        const bytes = await readBody(req);
        const target = path.join(dataDir, 'mock-s3', ...objectKey.split('/'));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
        issued.uploaded = true;
        observations.push({ route: 'upload', objectKey, sizeBytes: bytes.byteLength });
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/metadata') {
        const auth = authorize(req);
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        observations.push({ route: 'metadata', authorization: auth.header, body });
        if (!auth.session) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const issued = presigns.get(body.objectKey);
        if (!issued) {
          sendJson(res, 400, { error: 'invalid_object_key' });
          return;
        }
        if (issued.sessionId !== auth.session.sessionId) {
          sendJson(res, 403, { error: 'cross_session_object_key' });
          return;
        }
        if (issued.recordingId !== body.recordingId || !issued.uploaded) {
          sendJson(res, 400, { error: 'recording_upload_mismatch' });
          return;
        }
        const context = body.context || {};
        const row = {
          ...body,
          context: {
            ...(typeof context.callSid === 'string' ? { callSid: context.callSid } : {}),
            ...(typeof context.taskSid === 'string' ? { taskSid: context.taskSid } : {}),
            ...(['call', 'video', 'in_person'].includes(context.recordingKind)
              ? { recordingKind: context.recordingKind }
              : {}),
          },
          sessionId: auth.session.sessionId,
          identity: auth.session.identity,
        };
        await fs.mkdir(dataDir, { recursive: true });
        await fs.appendFile(path.join(dataDir, 'mock-dynamo.jsonl'), `${JSON.stringify(row)}\n`);
        sendJson(res, 200, { ok: true, id: body.recordingId });
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      sendJson(res, 500, { error: 'mock_backend_error' });
    }
  });

  return {
    sessions,
    presigns,
    observations,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      baseUrl = `http://${host}:${address.port}`;
      return { ...address, baseUrl };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
    get baseUrl() { return baseUrl; },
  };
}

if (require.main === module) {
  const backend = createMockBackend();
  backend.start().then(({ baseUrl }) => process.stdout.write(`Mock backend listening on ${baseUrl}\n`));
}

module.exports = { createMockBackend };
