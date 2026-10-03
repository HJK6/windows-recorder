'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('../src/shared/jwt');

const SECRET = 'unit-secret';

test('sign/verify round-trips a valid scoped token', () => {
  const token = jwt.sign({ sub: 'dev1', scope: 'device' }, SECRET);
  const res = jwt.verify(token, SECRET);
  assert.equal(res.valid, true);
  assert.equal(res.payload.sub, 'dev1');
  assert.ok(jwt.hasScope(res.payload, 'device'));
  assert.ok(!jwt.hasScope(res.payload, 'control'));
});

test('expired token fails closed', () => {
  const token = jwt.sign({ sub: 'dev1', scope: 'device' }, SECRET, { expiresInSec: -1 });
  assert.deepEqual(jwt.verify(token, SECRET), { valid: false, reason: 'expired' });
});

test('tampered signature fails closed', () => {
  const token = jwt.sign({ sub: 'dev1', scope: 'device' }, SECRET);
  const forged = `${token.slice(0, -2)}xx`;
  assert.equal(jwt.verify(forged, SECRET).valid, false);
  // Signed with the wrong secret is also rejected.
  const other = jwt.sign({ sub: 'dev1', scope: 'device' }, 'different-secret');
  assert.equal(jwt.verify(other, SECRET).valid, false);
});

test('missing/malformed tokens are rejected, never accept-any', () => {
  assert.equal(jwt.verify('', SECRET).valid, false);
  assert.equal(jwt.verify('not.a.jwt.at.all', SECRET).valid, false);
  assert.equal(jwt.verify('onlyonepart', SECRET).valid, false);
  assert.equal(jwt.verify(jwt.sign({}, SECRET), '').valid, false); // no secret => closed
});

test('space-delimited multi-scope claim', () => {
  const token = jwt.sign({ sub: 'u', scope: 'control upload' }, SECRET);
  const { payload } = jwt.verify(token, SECRET);
  assert.ok(jwt.hasScope(payload, 'control'));
  assert.ok(jwt.hasScope(payload, 'upload'));
  assert.ok(!jwt.hasScope(payload, 'device'));
});
