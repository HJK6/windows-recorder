'use strict';

/*
 * fake-device.js — a SYNTHETIC headless device for the P2 curl journey. It
 * reuses the real desktop modules (ws-client, identity, upload) so the control
 * path start -> command -> applied-ack -> stop -> verified upload is proven end
 * to end in AWS without the Electron UI. P5 runs the REAL capture on Amaterasu.
 *
 * It uploads a small synthetic buffer on stop (no real screen/mic here).
 *
 * Env: HF_WS_URL, HF_HTTP_API_URL, HF_DEVICE_ID, HF_DEVICE_BOOTSTRAP_SECRET.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createMockIdentity } = require('../../src/main/identity');
const { createWsClient } = require('../../src/main/ws-client');
const { createUploadClient } = require('../../src/main/upload');

const wsUrl = process.env.HF_WS_URL;
const httpApiUrl = process.env.HF_HTTP_API_URL;
const deviceId = process.env.HF_DEVICE_ID || 'poc-fake-device';
const bootstrapSecret = process.env.HF_DEVICE_BOOTSTRAP_SECRET;

if (!wsUrl || !httpApiUrl || !bootstrapSecret) {
  console.error('set HF_WS_URL, HF_HTTP_API_URL, HF_DEVICE_BOOTSTRAP_SECRET');
  process.exit(2);
}

const identity = createMockIdentity({
  tokenEndpoint: `${httpApiUrl.replace(/\/$/, '')}/v1/auth/device-token`,
  deviceId,
  bootstrapSecret,
});
const uploadClient = createUploadClient({ httpApiUrl });

const events = new EventEmitter();
events.setMaxListeners(0);
let state = { recorder: { status: 'idle', muted: false }, session: 'online' };
let currentRecordingId = null;

function setStatus(status) {
  state = { recorder: { status, muted: false }, session: 'online' };
  events.emit('state', state);
  console.log(`[device] recorder -> ${status}`);
}

async function doUpload(recordingId) {
  const buffer = crypto.randomBytes(4096); // synthetic "recording"
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const { token } = await identity.getDeviceToken();
  try {
    const result = await uploadClient.upload({
      recordingId, deviceToken: token, buffer,
      meta: { sha256, durationMs: 1000, recordingId },
    });
    console.log(`[device] upload verified=${result.verified} key=${result.objectKey} size=${result.sizeBytes}`);
  } catch (err) {
    console.error(`[device] upload failed: ${err.message}`);
  }
}

function relay(action, ctx = {}) {
  if ((action === 'start' || action === 'resume') && ctx.recordingId) currentRecordingId = ctx.recordingId;
  setImmediate(() => {
    if (action === 'start' || action === 'resume') setStatus('recording');
    else if (action === 'pause') setStatus('paused');
    else if (action === 'stop') {
      setStatus('idle');
      const recId = currentRecordingId;
      currentRecordingId = null;
      if (recId) doUpload(recId);
    }
  });
}

const client = createWsClient({
  wsUrl,
  identity,
  getState: () => state,
  relay,
  events,
  onConnection: (s) => console.log(`[device] channel ${s}`),
  logger: console,
});

client.start();
console.log(`[device] connecting to ${wsUrl} as ${deviceId}`);
process.on('SIGINT', () => { client.stop(); process.exit(0); });
process.on('SIGTERM', () => { client.stop(); process.exit(0); });
