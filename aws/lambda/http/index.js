'use strict';

/*
 * http/index.js — the HTTP API control plane (payload format 2.0, one $default
 * route). Browser control calls, the mock-IdP token endpoints, the just-in-time
 * S3 upload grant + verification, and the GET /app control page.
 *
 * Authorization is scope-checked and fails closed on every call. Control calls
 * require a `control` token; device/upload calls require a `device` token; the
 * recording's ownership is checked against the token's device (wrong-target =>
 * 403). A valid token alone is never sufficient (spec §3.1).
 */

const crypto = require('node:crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const jwt = require('../shared/jwt');
const db = require('../shared/db');
const { createSender } = require('../shared/mgmt');
const { renderAppPage } = require('./app-page');

const SECRET = process.env.TOKEN_SIGNING_SECRET;
// Per-device enrollment material: { deviceId: secret }. Each enrolled device has
// its OWN secret, so a device cannot mint a token for another deviceId.
let DEVICE_ENROLLMENT = {};
try { DEVICE_ENROLLMENT = JSON.parse(process.env.DEVICE_ENROLLMENT || '{}'); } catch (_) { DEVICE_ENROLLMENT = {}; }
const BROWSER_LOGIN_KEY = process.env.BROWSER_LOGIN_KEY;
const BUCKET = process.env.BUCKET_NAME;
const KMS_KEY_ID = process.env.KMS_KEY_ID;
const WS_MGMT_ENDPOINT = process.env.WS_MGMT_ENDPOINT;
const DEVICE_TOKEN_TTL = Number(process.env.DEVICE_TOKEN_TTL || 900);
const CONTROL_TOKEN_TTL = Number(process.env.CONTROL_TOKEN_TTL || 3600);
const PRESIGN_TTL = 600;

const s3 = new S3Client({});
const sendToDevice = WS_MGMT_ENDPOINT ? createSender(WS_MGMT_ENDPOINT) : null;

function tsEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const html = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'text/html; charset=utf-8' }, body });

function bearer(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
}
function requireScope(event, scope) {
  const res = jwt.verify(bearer(event), SECRET);
  if (!res.valid) return { error: json(401, { error: 'invalid_token', reason: res.reason }) };
  if (!jwt.hasScope(res.payload, scope)) return { error: json(403, { error: 'insufficient_scope', need: scope }) };
  return { payload: res.payload };
}

// Push a desired-state command to the device's current connection.
async function dispatch(recordingId, deviceId, revision, desiredState) {
  const conn = await db.getDeviceConnection(deviceId);
  if (!conn) return { delivered: false, offline: true };
  const command = {
    type: 'recording.setDesiredState',
    commandId: `cmd-${recordingId}-${revision}`,
    recordingId, deviceId, revision, desiredState, issuedAt: new Date().toISOString(),
  };
  await db.recordCommand(recordingId, revision, { commandId: command.commandId, type: command.type, desiredState });
  if (!sendToDevice) return { delivered: false };
  const r = await sendToDevice(conn.connectionId, { type: 'command', command });
  return r;
}

async function startRecording(event) {
  const auth = requireScope(event, 'control');
  if (auth.error) return auth.error;
  const body = parseBody(event);
  let deviceId = body.deviceId;
  if (!deviceId) {
    const devices = await db.listConnectedDevices();
    if (devices.length === 0) return json(503, { error: 'no_device_online' });
    if (devices.length > 1) return json(409, { error: 'ambiguous_device', devices: devices.map((d) => d.deviceId) });
    deviceId = devices[0].deviceId;
  } else {
    const conn = await db.getDeviceConnection(deviceId);
    if (!conn) return json(503, { error: 'device_offline' });
  }
  const recordingId = crypto.randomUUID();
  await db.createRecording(recordingId, deviceId);
  const r = await dispatch(recordingId, deviceId, 1, 'RECORDING');
  return json(202, { recordingId, revision: 1, deviceId, status: 'accepted', delivered: r.delivered });
}

async function transition(event, recordingId, desiredState) {
  const auth = requireScope(event, 'control');
  if (auth.error) return auth.error;
  const rec = await db.getRecording(recordingId);
  if (!rec) return json(404, { error: 'unknown_recording' });
  const updated = await db.setDesiredState(recordingId, desiredState);
  const r = await dispatch(recordingId, rec.deviceId, updated.revision, desiredState);
  return json(202, { recordingId, revision: updated.revision, status: 'accepted', delivered: r.delivered });
}

async function status(event) {
  const auth = requireScope(event, 'control');
  if (auth.error) return auth.error;
  const recordingId = event.queryStringParameters && event.queryStringParameters.recordingId;
  if (!recordingId) {
    const devices = await db.listConnectedDevices();
    return json(200, { deviceOnline: devices.length > 0, connectedDevices: devices.length, observedState: null });
  }
  const rec = await db.getRecording(recordingId);
  if (!rec) return json(404, { error: 'unknown_recording' });
  const conn = await db.getDeviceConnection(rec.deviceId);
  return json(200, {
    recordingId,
    desiredState: rec.desiredState,
    observedState: rec.observedState,
    revision: rec.revision,
    deviceOnline: Boolean(conn),
  });
}

async function controlToken(event) {
  const body = parseBody(event);
  if (!BROWSER_LOGIN_KEY || body.loginKey !== BROWSER_LOGIN_KEY) {
    return json(401, { error: 'bad_login_key' });
  }
  const token = jwt.sign({ sub: 'poc-operator', scope: 'control' }, SECRET, { expiresInSec: CONTROL_TOKEN_TTL });
  return json(200, { token, expiresAt: new Date(Date.now() + CONTROL_TOKEN_TTL * 1000).toISOString() });
}

async function deviceToken(event) {
  const body = parseBody(event);
  if (!body.deviceId || !body.bootstrapSecret) return json(400, { error: 'device_and_secret_required' });
  const expected = DEVICE_ENROLLMENT[body.deviceId];
  // Fail closed: unknown device OR wrong per-device secret. A device holding its
  // own secret cannot mint a token for a different deviceId.
  if (!expected || !tsEqual(body.bootstrapSecret, expected)) return json(401, { error: 'bad_enrollment_secret' });
  const token = jwt.sign({ sub: body.deviceId, scope: 'device upload' }, SECRET, { expiresInSec: DEVICE_TOKEN_TTL });
  return json(200, { token, expiresAt: new Date(Date.now() + DEVICE_TOKEN_TTL * 1000).toISOString() });
}

async function uploadGrant(event, recordingId) {
  const auth = requireScope(event, 'upload');
  if (auth.error) return auth.error;
  const rec = await db.getRecording(recordingId);
  if (!rec) return json(404, { error: 'unknown_recording' });
  if (rec.deviceId !== auth.payload.sub) return json(403, { error: 'wrong_target_device' });
  const body = parseBody(event);
  if (!body.sha256 || !body.sizeBytes) return json(422, { error: 'size_and_sha256_required' });
  const objectKey = `recordings/${rec.deviceId}/${recordingId}/${crypto.randomUUID()}.webm`;
  // Minimal presigned PUT: the bucket's default SSE-KMS encrypts the object
  // automatically, and immutability + checksum are enforced out of band (unique
  // key + If-None-Match, plus server-side verification on complete). Keeping the
  // signature minimal avoids presigned-header mismatches.
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: objectKey });
  const url = await getSignedUrl(s3, cmd, { expiresIn: PRESIGN_TTL });
  const uploadGrantId = crypto.randomUUID();
  // Bind the grant: completion verifies the object stored at THIS key matches the
  // size + sha declared here, for this device + recording. Caller-supplied values
  // at completion are ignored in favor of these.
  await db.putUploadGrant(uploadGrantId, {
    recordingId,
    deviceId: rec.deviceId,
    objectKey,
    expectedSizeBytes: Number(body.sizeBytes),
    expectedSha256: String(body.sha256),
  });
  return json(200, {
    method: 'PUT',
    url,
    headers: {
      'content-type': body.contentType || 'video/webm',
      'If-None-Match': '*',
    },
    objectKey,
    uploadGrantId,
  });
}

async function uploadComplete(event, recordingId) {
  const auth = requireScope(event, 'upload');
  if (auth.error) return auth.error;
  const rec = await db.getRecording(recordingId);
  if (!rec) return json(404, { error: 'unknown_recording' });
  if (rec.deviceId !== auth.payload.sub) return json(403, { error: 'wrong_target_device' });
  const body = parseBody(event);
  // Verify against the ISSUED grant, not caller-supplied values. Load the grant,
  // confirm it belongs to this device + recording, then read the object stored at
  // the grant's bound key and check its size + SHA-256 against the grant.
  const grant = body.uploadGrantId ? await db.getUploadGrant(body.uploadGrantId) : null;
  if (!grant) return json(404, { error: 'unknown_grant' });
  if (grant.deviceId !== auth.payload.sub || grant.recordingId !== recordingId) {
    return json(403, { error: 'grant_mismatch' });
  }
  let obj;
  try {
    obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: grant.objectKey }));
  } catch (err) {
    return json(404, { error: 'object_not_found', detail: err.name });
  }
  const bytes = Buffer.from(await obj.Body.transformToByteArray());
  const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
  const sizeOk = bytes.byteLength === Number(grant.expectedSizeBytes);
  const checksumOk = actualSha === String(grant.expectedSha256);
  if (!sizeOk || !checksumOk) {
    return json(422, { verified: false, error: 'verification_failed', sizeOk, checksumOk });
  }
  await db.markVerified(recordingId, grant.objectKey, bytes.byteLength, actualSha);
  return json(200, { verified: true, objectKey: grant.objectKey, sizeBytes: bytes.byteLength, checksumSha256: actualSha });
}

function appPage(event) {
  const q = event.queryStringParameters || {};
  if (!BROWSER_LOGIN_KEY || q.k !== BROWSER_LOGIN_KEY) {
    return html(401, '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif">'
      + 'Unauthorized. Append <code>?k=&lt;browser login key&gt;</code> (a Terraform output) to the URL.</body>');
  }
  const host = (event.headers && (event.headers.host || event.headers.Host)) || event.requestContext.domainName;
  const apiBase = `https://${host}`;
  const controlToken = jwt.sign({ sub: 'poc-operator', scope: 'control' }, SECRET, { expiresInSec: CONTROL_TOKEN_TTL });
  return html(200, renderAppPage({ apiBase, controlToken }));
}

function parseBody(event) {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '{}');
    return JSON.parse(raw || '{}');
  } catch (_) { return {}; }
}

exports.handler = async (event) => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path.replace(/\/+$/, '') || '/';
  try {
    if (method === 'GET' && path === '/app') return appPage(event);
    if (method === 'POST' && path === '/v1/auth/device-token') return await deviceToken(event);
    if (method === 'POST' && path === '/v1/auth/control-token') return await controlToken(event);
    if (method === 'POST' && path === '/v1/recordings') return await startRecording(event);
    if (method === 'GET' && path === '/v1/recorder/status') return await status(event);

    const m = path.match(/^\/v1\/recordings\/([^/]+)\/(pause|resume|stop|upload-grants|uploads\/complete)$/);
    if (method === 'POST' && m) {
      const id = decodeURIComponent(m[1]);
      switch (m[2]) {
        case 'pause': return await transition(event, id, 'PAUSED');
        case 'resume': return await transition(event, id, 'RECORDING');
        case 'stop': return await transition(event, id, 'STOPPED');
        case 'upload-grants': return await uploadGrant(event, id);
        case 'uploads/complete': return await uploadComplete(event, id);
        default: break;
      }
    }
    return json(404, { error: 'not_found', path });
  } catch (err) {
    console.error('http handler error', method, path, err && err.stack);
    return json(500, { error: 'internal' });
  }
};
