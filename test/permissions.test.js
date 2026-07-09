'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/shared/permissions');

const ORIGIN = 'file://';

test('grants media + display-capture for our own file:// origin', () => {
  assert.equal(P.shouldGrantCapture('media', 'file:///C:/app/index.html', ORIGIN), true);
  assert.equal(P.shouldGrantCapture('display-capture', 'file:///C:/app/index.html', ORIGIN), true);
});

test('denies non-capture permissions (incl. mediaKeySystem/notifications/geolocation)', () => {
  for (const perm of ['mediaKeySystem', 'notifications', 'geolocation', 'midi', 'clipboard-read']) {
    assert.equal(P.shouldGrantCapture(perm, 'file:///C:/app/index.html', ORIGIN), false, perm);
  }
});

test('denies capture from a non-file (remote) origin — no drive-by camera/mic', () => {
  assert.equal(P.shouldGrantCapture('media', 'https://evil.example/x', ORIGIN), false);
  assert.equal(P.shouldGrantCapture('display-capture', 'http://10.0.0.5/', ORIGIN), false);
});

test('treats an empty / "null" origin as our own local file page (N1)', () => {
  // The permission-CHECK path serializes a file:// origin as "" or "null".
  assert.equal(P.shouldGrantCapture('media', 'null', ORIGIN), true);
  assert.equal(P.shouldGrantCapture('media', '', ORIGIN), true);
  assert.equal(P.shouldGrantCapture('display-capture', undefined, ORIGIN), true);
});

test('fails CLOSED when appOrigin is missing — no fail-open (N2)', () => {
  assert.equal(P.shouldGrantCapture('media', 'file:///x', ''), false);
  assert.equal(P.shouldGrantCapture('media', 'null', null), false);
});

test('parseConsentValue reads Allow/Deny and returns unknown otherwise', () => {
  assert.equal(P.parseConsentValue('    Value    REG_SZ    Allow'), 'Allow');
  assert.equal(P.parseConsentValue('HKCU\\...\\microphone\r\n    Value    REG_SZ    Deny\r\n'), 'Deny');
  assert.equal(P.parseConsentValue('ERROR: The system was unable to find the specified registry key'), 'unknown');
  assert.equal(P.parseConsentValue(''), 'unknown');
});

test('effectiveMicConsent requires BOTH global and NonPackaged to allow (the desktop-app gate)', () => {
  // The bug this guards: NonPackaged=Deny must yield Deny even if global=Allow.
  assert.equal(P.effectiveMicConsent('Allow', 'Deny'), 'Deny', 'desktop-app consent denied');
  assert.equal(P.effectiveMicConsent('Deny', 'Allow'), 'Deny', 'global consent denied');
  assert.equal(P.effectiveMicConsent('Allow', 'Allow'), 'Allow');
  assert.equal(P.effectiveMicConsent('Allow', 'unknown'), 'unknown');
  assert.equal(P.effectiveMicConsent('unknown', 'unknown'), 'unknown');
  assert.equal(P.effectiveMicConsent('Deny', 'Deny'), 'Deny');
});
