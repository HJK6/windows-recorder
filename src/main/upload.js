'use strict';

/*
 * upload.js — on stop, the desktop uploads the finalized recording to private
 * S3 via a just-in-time presigned PUT and then asks the backend to verify it.
 *
 * Flow (spec §9.2):
 *   1. POST /v1/recordings/{id}/upload-grants  (Bearer device token)
 *        -> { method, url, headers, objectKey, uploadGrantId }
 *      The server scopes the grant to this exact object, binds the expected
 *      size + SHA-256, and presigns a PUT (SSE-KMS bucket default; immutable
 *      If-None-Match:*). The desktop holds no static AWS credentials.
 *   2. PUT the bytes to the presigned URL with the server-supplied headers
 *      (including x-amz-checksum-sha256 so S3 itself rejects a corrupted body).
 *   3. POST /v1/recordings/{id}/uploads/complete -> backend HeadObject verifies
 *      the stored object's ContentLength and ChecksumSHA256 match. The client's
 *      "done" is not proof; the backend's verification is.
 */

class UploadError extends Error {
  constructor(message, status) { super(message); this.name = 'UploadError'; this.status = status; }
}

async function jsonRequest(fetchImpl, url, { method = 'POST', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { method, headers, body: JSON.stringify(body || {}) });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new UploadError(payload.error || `HTTP ${res.status}`, res.status);
  return payload;
}

function createUploadClient({ httpApiUrl, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation required');
  const base = httpApiUrl.replace(/\/$/, '');
  const endpoint = (p) => `${base}${p}`;

  // upload({ recordingId, deviceToken, buffer, meta }) -> verification result.
  async function upload({ recordingId, deviceToken, buffer, meta }) {
    if (!recordingId) throw new UploadError('recordingId required');
    if (!deviceToken) throw new UploadError('device token required');
    const bytes = Buffer.from(buffer);
    const sizeBytes = bytes.byteLength;
    const sha256Hex = meta && meta.sha256;
    if (!sha256Hex) throw new UploadError('sha256 required');

    const grant = await jsonRequest(fetchImpl, endpoint(`/v1/recordings/${encodeURIComponent(recordingId)}/upload-grants`), {
      token: deviceToken,
      body: { sizeBytes, sha256: sha256Hex, contentType: 'video/webm', durationMs: meta.durationMs },
    });

    const putRes = await fetchImpl(grant.url, {
      method: grant.method || 'PUT',
      headers: grant.headers || {},
      body: bytes,
    });
    if (!putRes.ok) {
      // 412 => If-None-Match:* tripped (object already exists): do not overwrite.
      throw new UploadError(`S3 PUT failed: HTTP ${putRes.status}`, putRes.status);
    }

    const verified = await jsonRequest(fetchImpl, endpoint(`/v1/recordings/${encodeURIComponent(recordingId)}/uploads/complete`), {
      token: deviceToken,
      body: {
        objectKey: grant.objectKey,
        uploadGrantId: grant.uploadGrantId,
        sizeBytes,
        sha256: sha256Hex,
      },
    });
    return { objectKey: grant.objectKey, sizeBytes, ...verified };
  }

  return { upload };
}

module.exports = { UploadError, createUploadClient };
