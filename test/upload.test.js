'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUploadClient } = require('../src/main/upload');

// A fake backend+S3 that records the calls and enforces the contract.
function fakeStack({ putStatus = 200 } = {}) {
  const calls = { grant: null, put: null, complete: null };
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/upload-grants')) {
      calls.grant = { url, auth: opts.headers.authorization, body: JSON.parse(opts.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          method: 'PUT',
          url: 'https://s3.example/put/object-123?sig=abc',
          headers: { 'x-amz-checksum-sha256': 'BASE64==', 'If-None-Match': '*', 'content-type': 'video/webm' },
          objectKey: 'poc/rec-1/object-123.webm',
          uploadGrantId: 'grant-1',
        }),
      };
    }
    if (url.startsWith('https://s3.example/put/')) {
      calls.put = { url, headers: opts.headers, bodyLen: Buffer.from(opts.body).byteLength };
      return { ok: putStatus >= 200 && putStatus < 300, status: putStatus };
    }
    if (url.endsWith('/uploads/complete')) {
      calls.complete = { url, auth: opts.headers.authorization, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ verified: true, sizeBytes: calls.complete.body.sizeBytes, checksumSha256: 'BASE64==' }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchImpl, calls };
}

const META = { sha256: 'a'.repeat(64), durationMs: 1234, recordingId: 'renderer-local-id' };

test('upload on stop: grant -> presigned PUT -> verified complete', async () => {
  const { fetchImpl, calls } = fakeStack();
  const client = createUploadClient({ httpApiUrl: 'https://api.example', fetchImpl });
  const buffer = Buffer.from('fake-webm-bytes');
  const result = await client.upload({
    recordingId: 'rec-1', deviceToken: 'dev-tok', buffer, meta: META,
  });

  // Grant request authorized by the DEVICE token and bound to size + checksum.
  assert.equal(calls.grant.auth, 'Bearer dev-tok');
  assert.equal(calls.grant.body.sizeBytes, buffer.byteLength);
  assert.equal(calls.grant.body.sha256, META.sha256);
  assert.match(calls.grant.url, /\/v1\/recordings\/rec-1\/upload-grants$/);

  // PUT carries the server-supplied checksum + immutability headers.
  assert.equal(calls.put.headers['x-amz-checksum-sha256'], 'BASE64==');
  assert.equal(calls.put.headers['If-None-Match'], '*');
  assert.equal(calls.put.bodyLen, buffer.byteLength);

  // Completion is verified server-side (size + checksum).
  assert.equal(calls.complete.body.objectKey, 'poc/rec-1/object-123.webm');
  assert.equal(result.verified, true);
  assert.equal(result.sizeBytes, buffer.byteLength);
});

test('a failed S3 PUT surfaces an error and does not report verified', async () => {
  const { fetchImpl, calls } = fakeStack({ putStatus: 412 }); // If-None-Match tripped
  const client = createUploadClient({ httpApiUrl: 'https://api.example', fetchImpl });
  await assert.rejects(
    () => client.upload({ recordingId: 'rec-1', deviceToken: 'dev-tok', buffer: Buffer.from('x'), meta: META }),
    /HTTP 412/,
  );
  assert.equal(calls.complete, null, 'completion is not called when the PUT fails');
});

test('missing sha256 is rejected before any network call', async () => {
  const { fetchImpl, calls } = fakeStack();
  const client = createUploadClient({ httpApiUrl: 'https://api.example', fetchImpl });
  await assert.rejects(
    () => client.upload({ recordingId: 'r', deviceToken: 't', buffer: Buffer.from('x'), meta: {} }),
    /sha256 required/,
  );
  assert.equal(calls.grant, null);
});
