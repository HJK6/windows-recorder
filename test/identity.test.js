'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockIdentity, createStaticIdentity } = require('../src/main/identity');

function stubFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return responder(calls.length);
  };
  return { fetchImpl, calls };
}
const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

test('mock identity authenticates with device enrollment material and caches the token', async () => {
  const { fetchImpl, calls } = stubFetch(() => ok({
    token: 'tok-1', expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  }));
  const id = createMockIdentity({
    tokenEndpoint: 'https://api/v1/auth/device-token',
    deviceId: 'dev-7',
    bootstrapSecret: 'secret-xyz',
    fetchImpl,
  });
  const first = await id.getDeviceToken();
  assert.equal(first.token, 'tok-1');
  assert.equal(calls[0].body.deviceId, 'dev-7');
  assert.equal(calls[0].body.bootstrapSecret, 'secret-xyz');
  assert.equal(calls[0].body.scope, 'device');

  // Cached — second call does not re-fetch.
  await id.getDeviceToken();
  assert.equal(calls.length, 1);
});

test('token near expiry is refreshed', async () => {
  let n = 0;
  const { fetchImpl, calls } = stubFetch(() => ok({
    token: `tok-${++n}`, expiresAt: new Date(Date.now() + 5 * 1000).toISOString(), // 5s => inside skew
  }));
  const id = createMockIdentity({
    tokenEndpoint: 'https://api/t', deviceId: 'd', bootstrapSecret: 's', fetchImpl,
  });
  await id.getDeviceToken();
  await id.getDeviceToken();
  assert.equal(calls.length, 2, 'refreshes because the token is within the refresh skew');
});

test('failed device auth throws (fail closed)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: 'bad_secret' }) });
  const id = createMockIdentity({
    tokenEndpoint: 'https://api/t', deviceId: 'd', bootstrapSecret: 'wrong', fetchImpl,
  });
  await assert.rejects(() => id.getDeviceToken(), /bad_secret/);
});

test('static identity returns a fixed token for tests', async () => {
  const id = createStaticIdentity('fixed-token', { deviceId: 'dX' });
  assert.equal((await id.getDeviceToken()).token, 'fixed-token');
  assert.equal(id.deviceId, 'dX');
});
