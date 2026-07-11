'use strict';

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function jsonRequest(fetchImpl, url, { method = 'POST', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, { method, headers, body: JSON.stringify(body || {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(payload.error || `HTTP ${response.status}`, response.status);
  return payload;
}

function createActivationClient({ baseUrl, fetchImpl = globalThis.fetch, saveLocal = null }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation required');
  const endpoint = (path) => new URL(path, `${baseUrl.replace(/\/$/, '')}/`).toString();
  const cleanContext = (context = {}) => ({
    ...(typeof context.callSid === 'string' ? { callSid: context.callSid } : {}),
    ...(typeof context.taskSid === 'string' ? { taskSid: context.taskSid } : {}),
    ...(['call', 'video', 'in_person'].includes(context.recordingKind)
      ? { recordingKind: context.recordingKind }
      : {}),
  });

  async function validateFlexToken(flexToken) {
    if (typeof flexToken !== 'string' || !flexToken) throw new TypeError('flexToken required');
    return jsonRequest(fetchImpl, endpoint('flex/validate'), { body: { flexToken } });
  }

  async function uploadBytes(presign, buffer) {
    const response = await fetchImpl(presign.url, {
      method: presign.method || 'PUT',
      headers: presign.headers || {},
      body: Buffer.from(buffer),
    });
    if (!response.ok) throw new HttpError(`upload failed: HTTP ${response.status}`, response.status);
  }

  async function processRecording({ session, buffer, meta, context = {} }) {
    if (!session || !session.sessionToken) throw new Error('online session required');
    const sizeBytes = Buffer.from(buffer).byteLength;
    const sanitizedContext = cleanContext(context);
    const presign = await jsonRequest(fetchImpl, endpoint('uploads/presign'), {
      token: session.sessionToken,
      body: {
        sessionId: session.sessionId,
        recordingId: meta.recordingId,
        contentType: 'video/webm',
        sizeBytes,
        durationMs: meta.durationMs,
        sha256: meta.sha256,
        recordingKind: sanitizedContext.recordingKind,
      },
    });

    await uploadBytes(presign, buffer);
    const metadata = await jsonRequest(fetchImpl, endpoint('metadata'), {
      token: session.sessionToken,
      body: {
        sessionId: session.sessionId,
        recordingId: meta.recordingId,
        objectKey: presign.objectKey,
        durationMs: meta.durationMs,
        sizeBytes,
        sha256: meta.sha256,
        startedAt: meta.startedAt,
        endedAt: meta.endedAt,
        context: sanitizedContext,
      },
    });

    let local = null;
    if (saveLocal) local = await saveLocal(buffer, meta.recordingId);
    return { objectKey: presign.objectKey, sizeBytes, metadata, local };
  }

  return { validateFlexToken, uploadBytes, processRecording };
}

module.exports = { HttpError, createActivationClient };
